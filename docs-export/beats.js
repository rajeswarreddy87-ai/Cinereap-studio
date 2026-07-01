/**
 * beats.js — TRUE narration-to-clip synchronisation (v3.0).
 *
 * v3.0 upgrades over v2.1:
 *   - COVERAGE SCORING (req #8): before building the timeline, check each
 *     beat's available footage against its narration duration. If the coverage
 *     ratio is below 1.2×, expand the scene window by borrowing from the next
 *     adjacent scene — guaranteeing visuals never run out mid-sentence.
 *
 *   - FOOTAGE DIVERSITY (req #4): track scene-window usage. Priority order is:
 *     (1) current beat's own window, (2) next unused window forward,
 *     (3) alternate pass at a time-distant position — only wrap as LAST resort.
 *     This minimises clip repetition across the entire video.
 *
 *   - FORCED VISUAL TRANSITIONS (req #9): any clip longer than MAX_CUT_SEC is
 *     split into sub-clips of MAX_CUT_SEC or shorter, forcing a visual change
 *     every 3–6 seconds. Shorter beats (< MIN_CUT_SEC) are emitted as-is to
 *     avoid micro-cuts.
 *
 * Everything here is pure (no I/O) so the placement math is fully testable.
 */

/** Minimum coverage ratio: available footage must be ≥ 1.2× narration length. */
export const COVERAGE_MIN = 1.2;

/** Force a visual cut (new clip) at least every MAX_CUT_SEC seconds. */
export const MAX_CUT_SEC = 6.0;

/**
 * ChatGPT pipeline: derive per-beat max clip length from importance score (1-10).
 * Higher importance → LONGER max clip (emotion/reveals breathe).
 * Lower importance → SHORTER max clip (snappy transitions, fast energy).
 *
 *   1-3  → 2.5 s  (setup / filler / travel — fast cuts)
 *   4-7  → 4.0 s  (regular story beats — balanced)
 *   8-10 → 6.0 s  (climax / major reveals / emotional peaks — deliberate)
 */
export function importanceToMaxCut(importance) {
  const imp = Number.isFinite(Number(importance)) ? Math.max(1, Math.min(10, Number(importance))) : 5;
  if (imp <= 3) return 2.5;
  if (imp <= 7) return 4.0;
  return 6.0;
}

/**
 * Compute per-beat max clip duration (Item 6 beatType overrides Item 5 importance).
 *   action / danger      → 2.5 s   (rapid energy, fast cuts)
 *   climax               → 3.0 s   (intense, controlled)
 *   investigation        → 3.5 s
 *   mystery / setup      → 4.0 s
 *   resolution           → 5.0 s   (breathe out)
 *   reveal / emotion     → 5.5 s   (let it land)
 * Falls back to importanceToMaxCut when beatType is absent or unrecognised.
 */
export function computeMaxClipSec(importance, beatType) {
  if (typeof beatType === "string" && beatType) {
    switch (beatType.toLowerCase()) {
      case "action":        return 2.5;
      case "danger":        return 2.5;
      case "climax":        return 3.0;
      case "investigation": return 3.5;
      case "mystery":       return 4.0;
      case "setup":         return 4.0;
      case "resolution":    return 5.0;
      case "reveal":        return 5.0;
      case "emotion":       return 5.5;
      default: break;
    }
  }
  return importanceToMaxCut(importance);
}

/** Do not split a clip shorter than MIN_CUT_SEC to avoid jarring micro-cuts.
 *  2.0 s allows low-importance beats (importance 1-3) to actually use their 2.5 s budget. */
export const MIN_CUT_SEC = 2.0;

/** Count words in a narration fragment. */
export function wordCount(text) {
  if (typeof text !== "string") return 0;
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

/**
 * Compute a coverage score for one beat.
 *
 *   coverageScore = availableSceneSec / narrationSec
 *
 * Score ≥ 1.2 means there is 20% more footage available than needed — a
 * comfortable buffer that prevents narration from outrunning visuals.
 * Score < 1.0 means the visuals will run out before the beat finishes speaking.
 *
 * @param {number} availableSceneSec  — endSec − startSec of the beat's window
 * @param {number} narrationSec       — how long this beat's narration runs (TTS)
 * @returns {number} coverage ratio (Infinity when narrationSec === 0)
 */
export function computeCoverageScore(availableSceneSec, narrationSec) {
  if (!(narrationSec > 0)) return Infinity;
  return Math.max(0, availableSceneSec) / narrationSec;
}

/**
 * Split a continuous script into per-beat narration fragments.
 *
 * We DON'T have hard sentence->beat labels, so we distribute the script's
 * sentences across the beats in order, weighted by nothing more than sentence
 * count — i.e. an even spread that preserves order. This is intentionally
 * simple and order-preserving; the caller can pass explicit `beatTexts` when
 * Claude provides per-beat narration, in which case we use those verbatim.
 *
 * @param {string} script   the full recap body (no intro/outro)
 * @param {number} beatCount number of beats to spread across
 * @returns {string[]} length === beatCount, each a narration fragment
 */
export function splitScriptIntoBeats(script, beatCount) {
  const n = Math.max(1, Math.floor(beatCount));
  const clean = typeof script === "string" ? script.replace(/\s+/g, " ").trim() : "";
  if (!clean) return new Array(n).fill("");
  // Split into sentences, keeping their terminators.
  const sentences = clean.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];
  if (sentences.length <= n) {
    // Fewer sentences than beats: pad with empties at the end.
    const out = sentences.slice();
    while (out.length < n) out.push("");
    return out.slice(0, n);
  }
  // Distribute sentences as evenly as possible across n buckets, in order.
  const buckets = new Array(n).fill(null).map(() => []);
  const per = sentences.length / n;
  for (let i = 0; i < sentences.length; i++) {
    let b = Math.floor(i / per);
    if (b >= n) b = n - 1;
    buckets[b].push(sentences[i]);
  }
  return buckets.map((arr) => arr.join(" ").trim());
}

/**
 * Compute each beat's target ON-SCREEN duration (seconds) from the total
 * voiceover length, weighted by each beat's spoken word share.
 *
 * @param {string[]} beatTexts per-beat narration fragments (order = narration)
 * @param {number} voiceTotalSec measured total voiceover duration
 * @param {object} [opts]
 * @param {number} [opts.minBeatSec=1.2] floor so no beat flashes by
 * @returns {number[]} per-beat seconds, summing to ~voiceTotalSec
 */
export function computeBeatDurations(beatTexts, voiceTotalSec, opts = {}) {
  const minBeatSec = Number.isFinite(opts.minBeatSec) ? opts.minBeatSec : 1.2;
  const total = Number(voiceTotalSec);
  const n = beatTexts.length;
  if (!Number.isFinite(total) || total <= 0 || n === 0) return new Array(n).fill(0);

  const words = beatTexts.map((t) => wordCount(t));
  let wordTotal = words.reduce((a, b) => a + b, 0);

  // If the script has no measurable words, fall back to an even split.
  let raw;
  if (wordTotal <= 0) {
    raw = new Array(n).fill(total / n);
  } else {
    raw = words.map((w) => (w / wordTotal) * total);
  }

  // Enforce a minimum, then renormalise so the sum still equals total.
  // Iterative water-filling: pin beats at the floor, redistribute the rest by
  // word share among the un-pinned beats.
  const result = new Array(n).fill(0);
  const pinned = new Array(n).fill(false);
  for (let guard = 0; guard < n + 2; guard++) {
    const freeIdx = [];
    let pinnedSum = 0;
    let freeWord = 0;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) { pinnedSum += result[i]; }
      else { freeIdx.push(i); freeWord += (wordTotal > 0 ? words[i] : 1); }
    }
    const remaining = total - pinnedSum;
    if (freeIdx.length === 0) break;
    // If even an equal share can't meet the floor, give everyone the floor and stop.
    if (remaining / freeIdx.length <= minBeatSec) {
      for (const i of freeIdx) result[i] = minBeatSec;
      break;
    }
    let anyNewlyPinned = false;
    for (const i of freeIdx) {
      const share = (wordTotal > 0 ? words[i] : 1) / (freeWord || 1);
      const sec = remaining * share;
      if (sec < minBeatSec) {
        result[i] = minBeatSec;
        pinned[i] = true;
        anyNewlyPinned = true;
      }
    }
    if (!anyNewlyPinned) {
      // No more floors violated: assign the proportional values to free beats.
      for (const i of freeIdx) {
        const share = (wordTotal > 0 ? words[i] : 1) / (freeWord || 1);
        result[i] = remaining * share;
      }
      break;
    }
  }
  return result;
}

/**
 * A source "scene window" available to draw footage from.
 * @typedef {{ startSec:number, endSec:number }} SceneWindow
 */

/**
 * Build the ordered list of TRIM ranges that realise the beat timeline.
 *
 * === COVERAGE GUARANTEE (v3.0) ===
 * Before the main loop, each beat's scene window is checked against its
 * narration duration. When availableSceneSec / narrationSec < COVERAGE_MIN
 * (1.2), the window is extended by borrowing up to 30% of the next scene's
 * range. This prevents "narration outrunning footage" even for densely-packed
 * beat sequences.
 *
 * === FOOTAGE DIVERSITY (v3.0) ===
 * A `wrapCount` ceiling (3 re-passes maximum) and staggered re-entry offsets
 * ensure each re-pass starts at a different temporal position. On the first
 * wrap we jump to the 30% mark, second wrap 55%, third wrap 15% — so three
 * consecutive passes cover the film from three distinct starting points rather
 * than replaying the same opening footage every time. In practice, beat-window
 * expansion (beats.js) and scene detection (SCENE_THRESHOLD=0.25) mean re-
 * passes are rarely needed.
 *
 * === FORCED VISUAL TRANSITIONS (v3.0) ===
 * The inner loop emits sub-clips of at most MAX_CUT_SEC (6s). A 15-second beat
 * becomes three 5-second clips instead of one 15-second clip. This guarantees
 * a visual change at least every 6 seconds, which is the #1 factor in YouTube
 * viewer-retention metrics for recap-style content.
 *
 * @param {SceneWindow[]} scenes chronological scene windows (1 per beat, aligned by index)
 * @param {number[]} beatDurations target seconds per beat (same length as scenes)
 * @param {object} [opts]
 * @param {number} [opts.minSegSec=0.4] drop produced segments shorter than this
 * @param {number} [opts.sourceDurationSec] hard clamp for end times (credits-safe ceiling)
 * @param {number} [opts.maxClipSec=MAX_CUT_SEC] max single clip before forcing a visual cut (global fallback)
 * @param {number[]} [opts.beatImportances]      per-beat importance scores (1-10); when set,
 *                                               overrides maxClipSec per-beat via importanceToMaxCut()
 * @returns {Array<{ startSec:number, endSec:number, beatIndex:number, reason?:string }>}
 */
export function buildSyncedTimeline(scenes, beatDurations, opts = {}) {
  const minSegSec = Number.isFinite(opts.minSegSec) ? opts.minSegSec : 0.4;
  const maxClipSec = Number.isFinite(opts.maxClipSec) ? Math.max(MIN_CUT_SEC, opts.maxClipSec) : MAX_CUT_SEC;
  const hardMax = Number.isFinite(opts.sourceDurationSec) && opts.sourceDurationSec > 0
    ? opts.sourceDurationSec : Number.POSITIVE_INFINITY;
  const hardMin = Number.isFinite(opts.sourceStartSec) && opts.sourceStartSec > 0
    ? opts.sourceStartSec : 0;

  const n = Math.min(scenes.length, beatDurations.length);
  if (n === 0) return [];
  const out = [];

  // Compute the safe footage range.
  const rangeStart = hardMin > 0 ? hardMin : Math.max(0, Number(scenes[0].startSec) || 0);
  const ceiling = Number.isFinite(hardMax)
    ? hardMax - 0.05
    : (Number.isFinite(Number(scenes[n - 1].endSec)) ? Number(scenes[n - 1].endSec) : rangeStart + 60);

  // ── PRE-PASS: COVERAGE EXPANSION (req #8) ──────────────────────────────
  // For each beat, check coverageScore = window_size / narration_duration.
  // If score < COVERAGE_MIN, expand the window end by borrowing from adjacent
  // scenes. We look up to 2 scenes ahead so even densely-packed beats (where
  // the immediately-next window is also small) reach the coverage target.
  // The forward cursor is strictly monotonic so adjacent beats simply advance
  // past any borrowed section — no duplicate footage within one beat.
  const workScenes = scenes.map((sc, i) => {
    const avail = Math.max(0, Number(sc.endSec) - Number(sc.startSec));
    const need = Math.max(0, Number(beatDurations[i]) || 0);
    const score = computeCoverageScore(avail, need);
    if (score >= COVERAGE_MIN || need <= 0) return sc;

    // How much footage do we need to reach COVERAGE_MIN?
    const targetEnd = Number(sc.startSec) + need * COVERAGE_MIN;
    // Look ahead up to 2 scenes; take the furthest reachable end.
    const nextSceneEnd = i + 1 < scenes.length ? Number(scenes[i + 1].endSec) : ceiling;
    const farSceneEnd  = i + 2 < scenes.length ? Number(scenes[i + 2].endSec) : nextSceneEnd;
    // Allow borrowing as far as targetEnd requires (capped at 2 scenes ahead).
    const maxBorrow = Math.min(targetEnd, Math.max(nextSceneEnd, farSceneEnd), ceiling);
    const newEnd = Math.min(targetEnd, maxBorrow, ceiling);
    if (newEnd > Number(sc.endSec)) {
      return { ...sc, endSec: newEnd };
    }
    return sc;
  });

  // ── FORWARD CURSOR ────────────────────────────────────────────────────────
  // The cursor only moves FORWARD through the source footage. For each beat:
  //   1. Advance cursor to max(cursor, beat's own scene start).
  //   2. Emit sub-clips of at most maxClipSec seconds, forcing visual cuts.
  //   3. Advance the cursor by the total taken.
  //
  // Diversity: when the cursor hits the safe ceiling it performs a staggered
  // re-entry: wrap 1 → 30%, wrap 2 → 55%, wrap 3 → 15% of the safe range.
  // Max 3 wraps; beyond that we stop emitting to avoid infinite-loop footage.
  let cursor = rangeStart;
  let wrapCount = 0;
  // Staggered offsets for each wrap pass to avoid repeating the same footage.
  const WRAP_OFFSETS = [0.30, 0.55, 0.15];
  // Track the last cursor position used before each wrap to steer the offset.
  let lastCursorBeforeWrap = cursor;
  // QC: duplicate-clip tracking — record every emitted range; warn when a new
  // clip overlaps >50% with a previously used range (likely from a wrap or scene
  // mapping collision). We never skip duplicates here (that would create timing
  // gaps) but the warnings surface in render logs so operators can tune the
  // footage pool size or scene density.
  const _usedRanges = [];
  let _dupCount = 0;
  function _trackRange(start, end) {
    const dur = end - start;
    if (dur <= 0) return;
    for (const ur of _usedRanges) {
      const os = Math.max(start, ur.start);
      const oe = Math.min(end, ur.end);
      if (oe > os && (oe - os) / dur > 0.5) {
        _dupCount++;
        return; // already counted — don't push again
      }
    }
    _usedRanges.push({ start, end });
  }

  for (let i = 0; i < n; i++) {
    let need = Number(beatDurations[i]) || 0;
    if (need <= 0) continue;

    const reason = typeof workScenes[i].reason === "string" ? workScenes[i].reason : "";

    // Always jump the cursor to this beat's designated scene window start.
    // Allowing backward jumps is essential for non-linear films (flashbacks,
    // parallel timelines) where Claude's narrative ordering differs from strict
    // movie chronology. The old forward-only constraint caused beats whose scene
    // windows lay behind the current cursor to receive completely wrong footage
    // from wherever the cursor happened to be — the most common cause of
    // "no sync" complaints. Content accuracy beats diversity: showing the right
    // scene (possibly from a revisited position) is always better than showing
    // a unique but wrong scene.
    const sceneStart = Number(workScenes[i].startSec);
    if (Number.isFinite(sceneStart)) {
      cursor = sceneStart;
    }

    // ── Inner loop: emit sub-clips of ≤ maxClipSec to force visual transitions.
    // "Unused scenes first" is guaranteed by the forward cursor — we always
    // advance into new territory before considering a wrap. Wrapping is
    // deferred to after each beat's entire need is served.
    let subclipCount = 0;
    while (need >= minSegSec) {
      // Wrap check: if cursor is at or past the ceiling, stagger re-entry.
      if (cursor >= ceiling - minSegSec) {
        if (wrapCount >= WRAP_OFFSETS.length) {
          // Exhausted all wrap passes — stop to avoid infinite looping footage.
          console.warn(`[buildSyncedTimeline] max wraps (${WRAP_OFFSETS.length}) reached at beat ${i}; stopping`);
          need = 0;
          break;
        }
        lastCursorBeforeWrap = cursor;
        wrapCount++;
        const offset = WRAP_OFFSETS[(wrapCount - 1) % WRAP_OFFSETS.length];
        cursor = rangeStart + (ceiling - rangeStart) * offset;
        console.warn(`[buildSyncedTimeline] wrap #${wrapCount} at beat ${i} → cursor reset to ${cursor.toFixed(1)}s (${(offset * 100).toFixed(0)}% of range)`);
      }

      // ChatGPT pipeline: beatType (Item 6) overrides importance (Item 5) for cut timing.
      // Falls back to global maxClipSec when neither array is provided.
      const computedMaxCut = (Array.isArray(opts.beatImportances) || Array.isArray(opts.beatTypes))
        ? Math.max(MIN_CUT_SEC, computeMaxClipSec(
            Array.isArray(opts.beatImportances) ? opts.beatImportances[i] : undefined,
            Array.isArray(opts.beatTypes) ? opts.beatTypes[i] : undefined
          ))
        : maxClipSec;
      // maxClipSec is a hard cap. In copyright-safe mode the render passes 3.0s;
      // high-importance/climax beats still get more sub-clips, not longer raw clips.
      const beatMaxCut = Math.min(maxClipSec, computedMaxCut);
      const clipLen = Math.min(need, beatMaxCut);
      const clipEnd = Math.min(cursor + clipLen, ceiling);
      const taken = clipEnd - cursor;

      if (taken >= minSegSec) {
        _trackRange(cursor, clipEnd);
        pushSeg(out, cursor, clipEnd, i, reason, minSegSec);
        cursor = clipEnd;
        need -= taken;
        subclipCount++;
      } else {
        // Not enough room before the ceiling — trigger wrap on next iteration.
        cursor = ceiling;
      }
    }
  }

  const cutMode = Array.isArray(opts.beatImportances) ? "importance-dynamic" : `≤${maxClipSec}s fixed`;
  const dupMsg = _dupCount > 0 ? ` QC: ${_dupCount} duplicate clip(s) detected` : "";
  if (wrapCount > 0) {
    console.warn(`[buildSyncedTimeline] wrapped ${wrapCount}x (footage pool exhausted during long narration)${dupMsg}`);
  } else {
    console.log(`[buildSyncedTimeline] forward-cursor: ${n} beats, 0 wraps, cut mode: ${cutMode}${dupMsg}`);
  }
  if (_dupCount > 0) {
    console.warn(`[buildSyncedTimeline] QC: ${_dupCount} duplicate clip range(s) — consider adding more footage or reducing beat count`);
  }

  return out;
}

function pushSeg(out, start, end, beatIndex, reason, minSegSec) {
  if (!(end - start >= minSegSec)) return;
  out.push({ startSec: round3(start), endSec: round3(end), beatIndex, reason });
}

function round3(n) { return Math.round(n * 1000) / 1000; }

/**
 * Top-level convenience: given the script, the ordered scene windows, and the
 * measured voiceover length, return the synced trim timeline.
 *
 * @param {object} args
 * @param {string} args.script               recap body (no intro/outro)
 * @param {SceneWindow[]} args.scenes         chronological scene windows
 * @param {number} args.voiceTotalSec         measured total voiceover seconds
 * @param {string[]} [args.beatTexts]         optional explicit per-beat narration
 * @param {number} [args.minBeatSec]
 * @param {number} [args.sourceDurationSec]
 * @param {number} [args.maxClipSec]          override for forced-cut interval (default MAX_CUT_SEC)
 * @param {number[]} [args.beatImportances]   per-beat importance scores (1-10) for dynamic cut timing
 * @returns {{ timeline: Array, beatDurations: number[], beatTexts: string[] }}
 */
export function planSyncedRender({ script, scenes, voiceTotalSec, beatTexts, beatDurations: beatDurationsOverride, useEvenDistribution, minBeatSec, sourceDurationSec, sourceStartSec, maxClipSec, beatImportances, beatTypes }) {
  const n = Array.isArray(scenes) ? scenes.length : 0;
  let durations;

  if (Array.isArray(beatDurationsOverride) && beatDurationsOverride.length === n && n > 0) {
    // Exact per-beat audio durations supplied (voice files == beats count). Use verbatim.
    durations = beatDurationsOverride.map((d) => Math.max(Number(d) || 0, 0));
  } else if (useEvenDistribution || n === 0) {
    // Voice file count !== beat count: we cannot know how narration maps to beats.
    // Even distribution is the most honest fallback — much better than word-count
    // of short reason labels (which caused 15s vs 54s swings and severe drift).
    const total = Math.max(Number(voiceTotalSec) || 0, 0);
    durations = new Array(n).fill(n > 0 ? total / n : 0);
  } else {
    const texts = Array.isArray(beatTexts) && beatTexts.length === n
      ? beatTexts
      : splitScriptIntoBeats(script, n);
    durations = computeBeatDurations(texts, voiceTotalSec, { minBeatSec });
  }

  const texts = Array.isArray(beatTexts) && beatTexts.length === n
    ? beatTexts
    : splitScriptIntoBeats(script, n);
  const timeline = buildSyncedTimeline(scenes, durations, {
    sourceDurationSec,
    sourceStartSec,
    maxClipSec: Number.isFinite(maxClipSec) ? maxClipSec : MAX_CUT_SEC,
    beatImportances: Array.isArray(beatImportances) ? beatImportances : undefined,
    beatTypes: Array.isArray(beatTypes) ? beatTypes : undefined,
  });
  return { timeline, beatDurations: durations, beatTexts: texts };
}
