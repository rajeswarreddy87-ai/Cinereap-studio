/**
 * Pure helpers that turn a render job spec into FFmpeg argument arrays.
 * Kept side-effect-free so they can be unit-tested with `node --test`.
 */

export const RESOLUTION_PRESETS = {
  "1080p": { width: 1920, height: 1080, crf: 23, codec: "libx264" },
  "1440p": { width: 2560, height: 1440, crf: 22, codec: "libx265" },
  "2160p": { width: 3840, height: 2160, crf: 24, codec: "libx265" },
};

/**
 * Validate and normalise the render settings the phone sends.
 */
export function normaliseRenderSettings(input = {}) {
  const preset = RESOLUTION_PRESETS[input.resolution] ?? RESOLUTION_PRESETS["1080p"];
  const crf = Number.isFinite(input.crf) ? clamp(input.crf, 14, 32) : preset.crf;
  const fps = Number.isFinite(input.fps) ? clamp(input.fps, 24, 60) : 30;
  return {
    resolution: input.resolution in RESOLUTION_PRESETS ? input.resolution : "1080p",
    width: preset.width,
    height: preset.height,
    codec: preset.codec,
    crf,
    fps,
    muteOriginalAudio: input.muteOriginalAudio !== false, // default true
  };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Build the concat-demuxer manifest content. Each line is one clip path.
 * FFmpeg requires absolute paths and single-quote escaping.
 */
export function buildConcatManifest(clipPaths) {
  if (!Array.isArray(clipPaths) || clipPaths.length === 0) {
    throw new Error("buildConcatManifest: at least one clip path is required");
  }
  return clipPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n") + "\n";
}

/**
 * Escape a path for the FFmpeg `subtitles=` filter. The filter parser uses `:`
 * as an option separator and `\` for escapes, plus a few other gotchas. Single
 * quotes wrap the path so spaces survive.
 */
export function escapeSubtitlesPath(p) {
  // Replace `\` -> `\\`, `:` -> `\:`, `'` -> `\'`, `,` -> `\,`.
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,");
}

/**
 * FFmpeg args for the final mux:
 *   - concat already-trimmed clips into a single video track
 *   - optionally prepend an intro clip + append an outro clip
 *   - replace audio with one or more voiceover MP3s (concat'd in order)
 *   - optionally mix in a background-music MP3 (loud-normalised)
 *   - optionally burn an SRT subtitle track into the video
 *
 * Returns the args array suitable for `child_process.spawn('ffmpeg', args)`.
 */
export function buildRenderArgs({
  concatListPath,
  voiceoverPath,            // legacy single-MP3 path (still supported)
  voiceoverPaths,           // new: array of MP3 chunks
  musicPath,                // optional background music MP3
  subtitlesPath,            // optional .srt path to burn into video
  outputPath,
  settings,
  // Future-friendly: caller can pass `musicVolumeDb` (default -12dB to sit
  // under the voiceover). We never let music get louder than -3dB.
  musicVolumeDb,
  // Number of EXTRA times to loop the concatenated video input so the visuals
  // cover the full voiceover length. 0 = play once (default). With `-shortest`
  // the final length equals the voiceover, so visuals never run out / freeze
  // while narration continues. `-stream_loop N` repeats the input N extra times.
  videoLoopCount = 0,
  // Hard cap on the output length in seconds. When set, we add `-t` so the
  // final file is EXACTLY this long regardless of how the looped video or the
  // (infinitely-looped) music bed behave. This is the deterministic guarantee
  // that visuals + audio end together at the narration length.
  outputDurationSec = 0,
}) {
  if (!concatListPath || !outputPath) {
    throw new Error("buildRenderArgs: concatListPath and outputPath are required");
  }
  const s = normaliseRenderSettings(settings);

  // Normalise voiceover input list. Accept either a single legacy `voiceoverPath`
  // or a `voiceoverPaths` array. Empty arrays mean "no voiceover".
  const voList = Array.isArray(voiceoverPaths) && voiceoverPaths.length > 0
    ? voiceoverPaths
    : (voiceoverPath ? [voiceoverPath] : []);
  const hasVoice = voList.length > 0;
  const hasMusic = !!musicPath;
  const hasSubs = !!subtitlesPath;

  // Loop the concatenated video input enough times to outlast the voiceover.
  // `-stream_loop` MUST appear before the `-i` it applies to. A value of -1
  // would loop forever; we always use a finite, computed count and rely on
  // `-shortest` to cut at the voiceover end.
  const loopExtra = Number.isFinite(videoLoopCount) && videoLoopCount > 0
    ? Math.min(2000, Math.floor(videoLoopCount))
    : 0;
  const args = [
    "-y",
    "-hide_banner",
    // `info` + `-stats` so the worker can parse `time=` progress lines (warning
    // level emits NO progress, which made long encodes look "stuck"). Plus a
    // machine-readable progress stream on stdout via `-progress pipe:1`.
    "-loglevel", "info",
    "-stats",
    "-progress", "pipe:1",
    // Input 0: concatenated video (looped if needed to cover the voiceover)
    ...(loopExtra > 0 ? ["-stream_loop", String(loopExtra)] : []),
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
  ];

  // Inputs 1..N: voiceover chunks (each is its own MP3)
  for (const p of voList) args.push("-i", p);
  // Optional input M: music
  let musicInputIndex = -1;
  if (hasMusic) {
    musicInputIndex = 1 + voList.length;
    args.push("-i", musicPath);
  }

  // ---------------- filter graph ----------------
  // We always want to scale/pad the video. If we have subtitles, burn them.
  const vfChain = [
    `scale=${s.width}:${s.height}:force_original_aspect_ratio=decrease`,
    `pad=${s.width}:${s.height}:(ow-iw)/2:(oh-ih)/2:black`,
    `fps=${s.fps}`,
  ];
  if (hasSubs) {
    // Burn subtitles with a clean white-on-black caption look.
    const escaped = escapeSubtitlesPath(subtitlesPath);
    vfChain.push(
      `subtitles='${escaped}':force_style='Fontsize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=40'`,
    );
  }
  const videoFilter = `[0:v]${vfChain.join(",")}[vout]`;

  // Audio filter graph:
  //   - if multiple voiceover chunks: `[1:a][2:a]...concat=n=N:v=0:a=1[voice]`
  //   - if music: bring it down (-12dB by default), loop short loops to fit, mix
  //   - if neither: no audio at all
  const filterParts = [videoFilter];
  let audioOutLabel = null;

  if (hasVoice) {
    if (voList.length === 1) {
      filterParts.push(`[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[voice]`);
    } else {
      const inputs = voList.map((_, i) => `[${i + 1}:a]`).join("");
      filterParts.push(`${inputs}concat=n=${voList.length}:v=0:a=1,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[voice]`);
    }
    audioOutLabel = "voice";
  }

  if (hasMusic) {
    // Default lowered to -20dB (was -10) so narration clearly dominates; allow
    // down to -30dB. Caller typically passes -22 in sync mode.
    const dB = Number.isFinite(musicVolumeDb) ? Math.min(-3, Math.max(-30, musicVolumeDb)) : -20;
    // Loop the decoded music samples so it covers long videos, normalise format,
    // set base volume.
    filterParts.push(
      `[${musicInputIndex}:a]aloop=loop=-1:size=2147483647,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${dB}dB[musicbed]`,
    );
    if (hasVoice) {
      // Professional ducking: the voiceover (sidechain) compresses the music so
      // music automatically dips ~8-10dB whenever narration is present and
      // swells back in the gaps. We split the voice so it both feeds the
      // sidechain detector AND remains in the final mix at full level.
      filterParts.push(`[voice]asplit=2[voicemix][voicesc]`);
      // ratio=4 (was 8) with a higher threshold so narration dips the bed by a
      // musical ~6-8dB rather than crushing it to silence. This keeps the music
      // audible UNDER continuous speech instead of disappearing entirely.
      // ratio=3 + faster release=250 so the bed dips a musical ~5-6dB under
      // narration and recovers quickly in the gaps, staying clearly audible.
      // Deeper duck so speech sits clearly on top: ratio 6 + lower threshold so
      // the bed dips ~10-12dB under narration and recovers in the gaps. makeup=1
      // keeps the post-duck bed from creeping back up over the voice.
      filterParts.push(
        `[musicbed][voicesc]sidechaincompress=threshold=0.05:ratio=6:attack=15:release=300:makeup=1[ducked]`,
      );
      // duration=first => the mix ends when the VOICEOVER (first input) ends, not
      // when the looped music ends. Combined with -shortest this makes the final
      // file length equal the narration length exactly (music is just a bed).
      filterParts.push(`[voicemix][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
      // Gentle fade-out on the last 1.5s of the mixed audio so the bed never
      // cuts abruptly at the narration end.
      audioOutLabel = "aout";
    } else {
      audioOutLabel = "musicbed";
    }
  }

  args.push("-filter_complex", filterParts.join(";"));
  args.push("-map", "[vout]");
  if (audioOutLabel) {
    args.push("-map", `[${audioOutLabel}]`);
  } else {
    args.push("-an");
  }

  // Video codec — ultrafast preset + CRF 23 keeps quality excellent for
  // YouTube while encoding 3-4x faster than veryfast on the VPS CPU.
  const encPreset = s.codec === "libx264" ? "ultrafast" : "fast";
  args.push("-c:v", s.codec, "-crf", String(s.crf), "-preset", encPreset, "-pix_fmt", "yuv420p");
  if (audioOutLabel) {
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000");
    // Cut at whichever stream ends first (almost always the voiceover); this
    // prevents a 30-min looping music tail when the recap is only 8 minutes.
    args.push("-shortest");
  }
  // Deterministic length: cut the whole output at the voiceover/narration length.
  // `-t` is applied to output, so it clamps BOTH the looped video and the music
  // bed to exactly this duration — no 48s video tail, no infinite music.
  if (Number.isFinite(outputDurationSec) && outputDurationSec > 0) {
    args.push("-t", outputDurationSec.toFixed(3));
  }
  args.push("-movflags", "+faststart");
  args.push(outputPath);
  return args;
}

/**
 * Build a tiny `[Script Info]`-only SRT file from `[ {start, end, text} ]`.
 * Times are in seconds. Pure helper so the caller can write the result and
 * pass the path to `buildRenderArgs({ subtitlesPath })`.
 */
export function buildSrt(cues) {
  if (!Array.isArray(cues) || cues.length === 0) return "";
  const fmt = (t) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const r = ms % 1000;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(r)}`;
  };
  return cues
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${(c.text || "").trim()}\n`)
    .join("\n");
}
function pad2(n) { return String(n).padStart(2, "0"); }
function pad3(n) { return String(n).padStart(3, "0"); }

/**
 * Build args for a server-side re-trim (used if the phone sends raw clip
 * ranges instead of pre-trimmed files). Not the primary path in D-Lite,
 * but useful for fallback.
 */
export function buildTrimArgs({ inputPath, startSec, endSec, outputPath, reencode = true, speedFactor = 1.0 }) {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    throw new Error("buildTrimArgs: invalid time range");
  }
  // IMPORTANT: -ss must be before -i (input-side fast seek) but -t must be
  // AFTER -i as an output option. When both -ss and -to are placed before -i,
  // HEVC/MKV containers ignore the -to value and the clip runs to end-of-file.
  // Using -t (duration) as an output option correctly limits the clip length.
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel", "warning",
    "-ss", startSec.toFixed(3),
    "-i", inputPath,
  ];
  if (reencode) {
    // Frame-accurate trim with re-encoded H.264; drop audio entirely (we mute
    // the source per anti-Content-ID policy and mix in the voiceover at concat time).
    // speedFactor < 1.0 means the clip is time-stretched to fill longer narration:
    //   setpts=(1/speedFactor)*PTS slows the video so output_duration = raw / speedFactor.
    // We only do this for mild mismatches (speedFactor ≥ 0.70) where slow-motion
    // still looks natural. -t still encodes the raw input duration; setpts handles output.
    const applySlowMo = Number.isFinite(speedFactor) && speedFactor >= 0.10 && speedFactor < 0.99;
    args.push(
      "-an",
      "-c:v", "libx264",
      "-preset", "ultrafast", // intermediate clips re-encoded again at final step → quality irrelevant here
      "-crf", "23",           // slightly looser CRF → smaller temp files, faster I/O
      "-pix_fmt", "yuv420p",
    );
    if (applySlowMo) {
      args.push("-vf", `setpts=${(1 / speedFactor).toFixed(5)}*PTS`);
    }
    args.push("-movflags", "+faststart");
  } else {
    // Fast lossless copy (keyframe-aligned, less accurate).
    args.push("-c", "copy", "-an", "-avoid_negative_ts", "make_zero");
  }
  // Output-side duration limit: -t controls the INPUT read window.
  // When setpts is applied, FFmpeg outputs raw_duration / speedFactor automatically.
  args.push("-t", (endSec - startSec).toFixed(3));
  args.push(outputPath);
  return args;
}

