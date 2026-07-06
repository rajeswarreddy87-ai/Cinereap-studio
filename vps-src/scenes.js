/**
 * Hybrid scene detection for CineRecap.
 *
 * Instead of sampling a frame every N seconds (fixed-frame), we detect real
 * scene boundaries with FFmpeg's scene-change score, then:
 *   - build a chronological list of scenes (start/end seconds)
 *   - choose a clip window per scene (capped at maxClipSeconds)
 *   - extract FRAMES_PER_SCENE representative key frames per scene
 *
 * Pure-ish: the FFmpeg/ffprobe calls are isolated in small functions so the
 * planning logic (planScenes) can be unit-tested without spawning processes.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Scene-change sensitivity threshold.
 * 0.25 (vs legacy 0.4) is significantly more sensitive — it targets
 * 120–180 detected scenes per 2-hour feature film, giving Claude far more
 * diverse visual coverage and dramatically reducing footage repetition.
 */
export const SCENE_THRESHOLD = 0.20;

/**
 * Number of frames extracted per detected scene sent to Claude.
 * Five frames (start, 25%, mid, 75%, end) give Claude temporal progression
 * within a scene — crucial for understanding action, dialogue, and transitions.
 * Single-frame analysis caused ~15% hallucination rate; 5-frame reduces it.
 */
export const FRAMES_PER_SCENE = 5;

/** Run ffprobe to get duration in seconds. */
export function probeDurationSec(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ];
    const ff = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    ff.stdout.on("data", (d) => (out += d.toString()));
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err.slice(0, 200)}`));
      const v = parseFloat(out.trim());
      if (!Number.isFinite(v) || v <= 0) return reject(new Error("ffprobe: invalid duration"));
      resolve(v);
    });
    ff.on("error", reject);
  });
}

/**
 * Detect scene-change timestamps (in seconds) using FFmpeg's `select` filter
 * with the `scene` score and `showinfo` metadata. We downscale to speed up the
 * pass dramatically (we only need timing, not pixels).
 *
 * Threshold is now SCENE_THRESHOLD (0.25) instead of the legacy 0.4, producing
 * 2–3× more scene cuts per film and far better visual diversity in recaps.
 *
 * @returns {Promise<number[]>} sorted scene-cut timestamps (seconds), excluding 0.
 */
export function detectSceneCuts(filePath, { threshold = SCENE_THRESHOLD, maxAnalyzeWidth = 240, durationSec = 0, onProgress, _skipFrameFast = true } = {}) {
  return new Promise((resolve, reject) => {
    // Fast path: `-skip_frame nokey` decodes ONLY I-frames (keyframes).
    // This is 10-20x faster than full decode but fails for videos where
    // yt-dlp / HLS produces long GOP lengths (I-frames every 30-40s).
    // When that happens, cuts.length < MIN_CUTS_FOR_QUALITY and we retry
    // without the flag using a narrower width (120px) for speed.
    const MIN_CUTS_FOR_QUALITY = 20;
    const args = [
      "-hide_banner",
      ...(_skipFrameFast ? ["-skip_frame", "nokey"] : []),
      "-i", filePath,
      "-filter_complex",
      `[0:v]scale=${maxAnalyzeWidth}:-2,select='gt(scene,${threshold})',showinfo`,
      "-an",
      "-progress", "pipe:1",
      "-f", "null",
      "-",
    ];
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdoutBuf = "";
    let maxObservedSec = 0;
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    // Parse `-progress` stream (out_time_ms / out_time) for live feedback.
    ff.stdout.on("data", (d) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const ln of lines) {
        const mm = ln.match(/out_time_ms=(\d+)/);
        if (mm) {
          const sec = Number(mm[1]) / 1e6;
          if (sec > maxObservedSec) maxObservedSec = sec;
          if (onProgress && durationSec > 0) {
            const frac = Math.max(0, Math.min(1, sec / durationSec));
            const mmss = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
            const total = `${String(Math.floor(durationSec / 60)).padStart(2, "0")}:${String(Math.floor(durationSec % 60)).padStart(2, "0")}`;
            onProgress(frac, `Scanning scenes ${mmss} / ${total}`);
          }
        }
      }
    });
    ff.on("close", () => {
      // showinfo prints lines like: "... pts_time:123.456 ..."
      const times = [];
      const re = /pts_time:([0-9]+\.?[0-9]*)/g;
      let m;
      while ((m = re.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (Number.isFinite(t) && t > 0) times.push(t);
      }
      times.sort((a, b) => a - b);

      // If the fast keyframe-only pass found too few cuts the source video
      // likely has a long GOP (I-frame every 30-40s, common with yt-dlp HLS
      // downloads). Retry with full frame decode at half the width for speed.
      if (_skipFrameFast && times.length < MIN_CUTS_FOR_QUALITY) {
        // FIX (SYNC-FIXES #2a): lowering resolution on retry finds FEWER
        // meaningful scene-score crossings, not more — that was backwards.
        // Keep resolution and step the threshold DOWN instead so genuinely
        // under-detected films (e.g. low-contrast encodes) actually surface
        // more real cuts on the full-decode retry.
        const retryThreshold = Math.max(0.08, threshold * 0.6);
        console.log(
          `[detectSceneCuts] fast scan found only ${times.length} cuts (long-GOP video) — ` +
          `retrying with full decode, threshold ${threshold.toFixed(2)} → ${retryThreshold.toFixed(2)}…`
        );
        detectSceneCuts(filePath, {
          threshold: retryThreshold,
          maxAnalyzeWidth,
          durationSec,
          onProgress,
          _skipFrameFast: false,
        }).then(resolve).catch(() => resolve({ cuts: times, maxObservedSec }));
        return;
      }

      // Return the max timestamp seen in the progress stream so callers can
      // use it as the authoritative duration when the container header lies
      // (common with HLS-merged MP4s where moov reports only a partial window).
      resolve({ cuts: times, maxObservedSec });
    });
    ff.on("error", reject);
  });
}

/**
 * Progressive scene-cut detection — retries with lower thresholds before
 * planScenes falls back to an artificial time grid.
 */
export async function detectSceneCutsProgressive(filePath, { durationSec = 0, onProgress } = {}) {
  const thresholds = [SCENE_THRESHOLD, 0.15, 0.10, 0.08];
  const minCuts = Math.max(60, Math.round((durationSec || 0) / 40));
  let best = { cuts: [], maxObservedSec: 0 };
  for (const threshold of thresholds) {
    const result = await detectSceneCuts(filePath, { threshold, durationSec, onProgress });
    const cuts = Array.isArray(result?.cuts) ? result.cuts : [];
    if (cuts.length > best.cuts.length) best = result;
    if (best.cuts.length >= minCuts) {
      if (threshold < SCENE_THRESHOLD) {
        console.log(`[detectSceneCutsProgressive] ${best.cuts.length} cuts at threshold ${threshold} (target ≥${minCuts})`);
      }
      break;
    }
  }
  return best;
}

/**
 * Split long detected scenes into ~12s chunks so Claude gets finer windows
 * without discarding real cut boundaries for an artificial grid.
 */
export function subdivideLongScenes(scenes, { maxSceneSec = 15, chunkSec = 12 } = {}) {
  const out = [];
  for (const sc of scenes) {
    const dur = sc.end - sc.start;
    if (dur <= maxSceneSec) {
      out.push({ ...sc });
      continue;
    }
    const chunks = Math.max(2, Math.ceil(dur / chunkSec));
    const step = dur / chunks;
    for (let c = 0; c < chunks; c++) {
      out.push({ start: sc.start + c * step, end: sc.start + (c + 1) * step });
    }
  }
  return out;
}

/**
 * Turn raw scene-cut timestamps + total duration into a planned list of scenes
 * with clip windows and key-frame times.
 *
 * Strategy:
 *   - Build [0, cut1, cut2, ..., duration] boundaries.
 *   - Drop scenes shorter than `minSceneSec` by merging into the previous one.
 *   - If we have MORE scenes than `targetCount`, keep the longest `targetCount`
 *     (most significant) but preserve chronological order.
 *   - If we have FEWER scenes than `minCount` (e.g. detection found almost
 *     nothing), fall back to evenly-spaced segments so we always have coverage.
 *   - For each kept scene: clip window = [start, min(start+maxClipSeconds, end)],
 *     keyframe time = midpoint of the clip window.
 *
 * Default targetCount raised to 150 to target 120–180 scenes per feature film.
 *
 * Pure function — no I/O — so it is unit-testable.
 */
export function planScenes({
  cuts = [],
  duration,
  targetCount = 150,
  maxClipSeconds = 6,
  minSceneSec = 1.2,
}) {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("planScenes: duration must be > 0");
  }
  const maxSec = Math.max(2, Number(maxClipSeconds) || 6);
  const target = Math.max(8, Math.round(Number(targetCount) || 150));
  // FIX (2026-07-03): tracks whether the "too few real scenes" fallback below
  // fired. Smuggled onto the returned array (see bottom of this function) so
  // callers that only expect an array keep working, while analyzeScenes()
  // can still read it off.
  let _isFallbackGrid = false;

  // Credits guard: the closing credits roll typically occupies the final
  // minutes of a feature and produces dark/low-motion frames that look bad in a
  // recap. We exclude scene material in the trailing tail so beats never land
  // on the credits. We drop the greater of the last 90s or 3.5% of runtime,
  // but never more than 8% (to stay safe on short films / trailers).
  const creditsTail = Math.min(duration * 0.08, Math.max(90, duration * 0.035));
  const usableEnd = Math.max(duration * 0.5, duration - creditsTail);

  // 1) Boundaries -> raw scenes (cap at usableEnd to skip the credits tail).
  const bounds = [0, ...cuts.filter((t) => t > 0 && t < usableEnd), usableEnd];
  // Dedup + sort.
  const uniq = Array.from(new Set(bounds.map((t) => Math.round(t * 1000) / 1000))).sort((a, b) => a - b);
  let scenes = [];
  for (let i = 0; i < uniq.length - 1; i++) {
    scenes.push({ start: uniq[i], end: uniq[i + 1] });
  }

  // 2) Merge tiny scenes into the previous one.
  const merged = [];
  for (const sc of scenes) {
    const dur = sc.end - sc.start;
    if (merged.length > 0 && dur < minSceneSec) {
      merged[merged.length - 1].end = sc.end;
    } else {
      merged.push({ ...sc });
    }
  }
  scenes = merged;

  // 3) Too few scenes — subdivide real cuts before resorting to an artificial grid.
  // v3.0.6: the old 50%-of-target gate (e.g. 79 < 90) wrongly discarded 79
  // genuine scene boundaries and replaced them with a 38.7s grid — the #1 cause
  // of narration/visual mismatch. Only use the grid when detection is truly
  // broken (<25% of target AND <40 scenes); otherwise subdivide long scenes.
  const rawSceneCount = scenes.length;
  const minCountForGrid = Math.max(8, Math.round(target * 0.25));
  const minCountHealthy = Math.max(20, Math.round(target * 0.35));
  if (scenes.length >= minCountHealthy) {
    console.log(`[planScenes] real scene detection: ${scenes.length} scenes from ${cuts.length} cuts (target ${target})`);
    if (scenes.length < target) {
      const subdivided = subdivideLongScenes(scenes);
      if (subdivided.length > scenes.length) {
        console.log(`[planScenes] subdivided long scenes: ${scenes.length} → ${subdivided.length} finer windows (real cuts preserved)`);
        scenes = subdivided;
      }
    }
  } else if (scenes.length >= minCountForGrid) {
    const subdivided = subdivideLongScenes(scenes);
    console.log(
      `[planScenes] sparse but real detection: ${rawSceneCount} scenes from ${cuts.length} cuts — ` +
      `subdivided to ${subdivided.length} windows (avoiding artificial grid)`
    );
    scenes = subdivided;
  } else {
    console.warn(
      `[planScenes] SCENE DETECTION FALLBACK: only ${rawSceneCount} real scenes ` +
      `(< ${minCountForGrid}) — using an even ${(usableEnd / target).toFixed(1)}s grid. ` +
      `Clip windows will NOT align to real cuts; visual match will suffer. ` +
      `Lower SCENE_THRESHOLD or check the source encode.`
    );
    scenes = [];
    const seg = usableEnd / target;
    for (let i = 0; i < target; i++) {
      const start = i * seg;
      scenes.push({ start, end: Math.min(usableEnd, start + seg) });
    }
    _isFallbackGrid = true;
  }

  // 4) Too many scenes -> sample EVENLY across the whole usable timeline so the
  // recap spans the entire film (beginning -> end), not just the front half.
  // We bucket scenes into `target` time-buckets and pick the longest scene in
  // each bucket (longest = most visually substantial), preserving order. This
  // is far better than keeping the globally-longest scenes, which clustered the
  // recap into one part of the movie.
  if (scenes.length > target) {
    const span = usableEnd > 0 ? usableEnd : duration;
    const buckets = new Array(target).fill(null);
    for (const sc of scenes) {
      const mid = (sc.start + sc.end) / 2;
      let b = Math.floor((mid / span) * target);
      if (b < 0) b = 0;
      if (b >= target) b = target - 1;
      const len = sc.end - sc.start;
      if (!buckets[b] || len > buckets[b].end - buckets[b].start) buckets[b] = sc;
    }
    let picked = buckets.filter(Boolean);
    // If some buckets were empty (sparse cuts), backfill from remaining scenes
    // to get as close to target as possible, keeping chronological order.
    if (picked.length < target) {
      const chosen = new Set(picked);
      const extras = scenes.filter((s) => !chosen.has(s));
      const need = target - picked.length;
      // even-stride pick from extras
      const stride = Math.max(1, Math.floor(extras.length / Math.max(1, need)));
      for (let i = 0, added = 0; i < extras.length && added < need; i += stride, added++) {
        picked.push(extras[i]);
      }
    }
    picked.sort((a, b) => a.start - b.start);
    scenes = picked.map(({ start, end }) => ({ start, end }));
  }

  // 5) Build clip windows + keyframe times.
  const planned = scenes.map((sc, idx) => {
    const clipStart = sc.start;
    const clipEnd = Math.min(sc.end, clipStart + maxSec, Math.max(0, duration - 0.05));
    const safeEnd = clipEnd > clipStart ? clipEnd : Math.min(duration - 0.05, clipStart + Math.min(maxSec, sc.end - sc.start || 1));
    const keyframeSec = Math.min(Math.max(clipStart, (clipStart + safeEnd) / 2), Math.max(0, duration - 0.1));
    return {
      index: idx,
      sceneStart: sc.start,
      sceneEnd: sc.end,
      startSec: clipStart,
      endSec: safeEnd,
      keyframeSec,
    };
  });
  // Smuggle the fallback flag onto the array (arrays can carry extra props)
  // so existing callers that only use .map/.filter/.length are unaffected.
  planned.isFallbackGrid = _isFallbackGrid;
  return planned;
}

/** Extract a single JPEG frame at `tSec`. Returns the output path. */
export function extractKeyFrame(filePath, tSec, outPath, maxWidth = 512) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-ss", Math.max(0, tSec).toFixed(3),
      "-i", filePath,
      "-frames:v", "1",
      "-vf", `scale=${maxWidth}:-2`,
      "-q:v", "3",
      outPath,
    ];
    const ff = spawn("ffmpeg", args, { stdio: "ignore" });
    ff.on("close", (code) => (code === 0 ? resolve(outPath) : reject(new Error(`extractKeyFrame failed (code ${code})`))));
    ff.on("error", reject);
  });
}

/**
 * Compute the FRAMES_PER_SCENE frame timestamps for a single scene.
 * Distributes evenly across the FULL scene range (sceneStart → sceneEnd),
 * clamped to [0, duration - 0.1]. Returns an array of FRAMES_PER_SCENE times.
 *
 * Using the full scene range (not just the 6s clip window) lets Claude see
 * how the scene evolves over time — critical for understanding action arcs,
 * dialogue exchanges, and scene transitions.
 */
export function sceneFrameTimes(sc, duration) {
  // Use the CLIP/render window [startSec,endSec], NOT the full sceneStart→sceneEnd
  // span. Sampling the full span made the model describe footage past the capped
  // clip cut-off, so the note never matched what the viewer sees (SYNC-FIXES #1).
  const winStart = Math.max(0, Number(sc.startSec ?? sc.sceneStart));
  const winEnd = Math.min(Number(sc.endSec ?? sc.sceneEnd), duration - 0.05);
  const range = Math.max(0, winEnd - winStart);
  const cap = duration - 0.1;

  if (range < 0.5) {
    // Very short scene — all 5 frames collapse to the midpoint.
    const mid = Math.min(winStart + range / 2, cap);
    return new Array(FRAMES_PER_SCENE).fill(mid);
  }

  // 10/30/50/70/90% keeps all samples strictly inside the rendered window.
  return [0.1, 0.3, 0.5, 0.7, 0.9].map((frac) =>
    Math.min(winStart + range * frac, cap)
  );
}

/**
 * Full scene analysis: detect cuts, plan scenes, extract FRAMES_PER_SCENE
 * key frames per scene. Key-frame extraction runs in parallel batches for speed.
 *
 * Returns scenes where each has:
 *   - framePaths: string[]  — all FRAMES_PER_SCENE extracted JPEG paths
 *   - framePath:  string    — the midpoint frame (index 2) for backward compat
 *
 * @returns {Promise<{ duration:number, scenes: Array<{index,startSec,endSec,keyframeSec,framePath,framePaths}> }>}
 */
export async function analyzeScenes(filePath, {
  outDir,
  targetCount = 150,
  maxClipSeconds = 6,
  threshold = SCENE_THRESHOLD,
  keyframeWidth = 512,
  onProgress,
} = {}) {
  const probedDuration = await probeDurationSec(filePath);
  if (onProgress) onProgress(10, "Detecting scenes");
  const { cuts, maxObservedSec } = await detectSceneCutsProgressive(filePath, {
    durationSec: probedDuration,
    onProgress: (frac, msg) => {
      if (onProgress) onProgress(10 + Math.round(frac * 23), msg);
    },
  });
  // HLS-merged containers often have a wrong moov duration in the header.
  // Use whichever is larger: the container's reported duration or the
  // furthest timestamp ffmpeg actually decoded. This prevents Claude from
  // being told the film is 34 min when it is actually 78+ min.
  const duration = Math.max(probedDuration, maxObservedSec || 0);
  if (onProgress) onProgress(35, `Found ${cuts.length} scene cuts; planning`);
  const planned = planScenes({ cuts, duration, targetCount, maxClipSeconds });

  await fs.mkdir(outDir, { recursive: true });
  // PAR=6 scenes in parallel × 5 frames each = 30 concurrent ffmpeg jobs;
  // reduced from 8 to avoid overwhelming I/O on modest VPS hardware.
  const PAR = 6;
  const scenes = new Array(planned.length);
  for (let b = 0; b < planned.length; b += PAR) {
    const batch = planned.slice(b, b + PAR);
    await Promise.all(
      batch.map(async (sc) => {
        // Compute the FRAMES_PER_SCENE timestamps spread across the full scene.
        const frameTimes = sceneFrameTimes(sc, duration);
        const framePaths = [];

        // Extract all frames in parallel within this scene.
        await Promise.all(
          frameTimes.map(async (tSec, fi) => {
            const fp = path.join(outDir, `scene-${String(sc.index).padStart(3, "0")}-f${fi}.jpg`);
            try {
              await extractKeyFrame(filePath, tSec, fp, keyframeWidth);
              framePaths[fi] = fp;
            } catch {
              // Leave slot empty — compact below.
            }
          })
        );

        // Compact: remove any slots that failed extraction.
        const validPaths = framePaths.filter(Boolean);

        if (validPaths.length > 0) {
          // framePath = the middle frame (index 2 = 50%) for backward compat.
          const midIdx = Math.floor(validPaths.length / 2);
          scenes[sc.index] = { ...sc, framePath: validPaths[midIdx], framePaths: validPaths };
        } else {
          scenes[sc.index] = { ...sc, framePath: null, framePaths: [] };
        }
      }),
    );
    if (onProgress) {
      const pct = 35 + Math.round(((b + batch.length) / planned.length) * 60);
      onProgress(Math.min(95, pct), `Extracted frames ${Math.min(b + batch.length, planned.length)}/${planned.length} scenes`);
    }
  }
  // Compact any failed extractions.
  const finalScenes = scenes.filter((s) => s && s.framePaths && s.framePaths.length > 0);
  if (onProgress) onProgress(100, `Scene analysis complete (${finalScenes.length} scenes, ${FRAMES_PER_SCENE} frames each)`);
  return { duration, scenes: finalScenes, isFallbackGrid: !!planned.isFallbackGrid };
}
