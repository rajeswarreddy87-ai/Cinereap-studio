  for (let _j = 0; _j < cleanClips.length; _j++) {
    const _bi = typeof cleanClips[_j].beatIndex === "number" ? cleanClips[_j].beatIndex : _j;
    if (!_beatGroupMap.has(_bi)) _beatGroupMap.set(_bi, []);
    _beatGroupMap.get(_bi).push(clipPaths[_j]);
  }
  // Ordered list of unique beat indices (preserves timeline order)
  const _beatOrder = [...new Set(cleanClips.map((cc) => typeof cc.beatIndex === "number" ? cc.beatIndex : 0))];
  console.log(`[render ${jobId}] BEAT-MUX MAP: ${cleanClips.length} sub-clips → ${_beatOrder.length} body beats`);

  // Helper: mux a video file with a voice TTS file (no audio seek needed — full beat voice)
  // padSec is dynamic — callers pass the probed TTS-video gap so the pad is exactly what's
  // needed, avoiding 2s of frozen-frame clone on beats where TTS fits the footage tightly.
  const _muxVideoWithVoice = async (videoPath, voicePath, outPath, padSec = 0.25) => {
    let vDur = 0, aDur = 0;
    try { vDur = await probeDurationSec(videoPath); } catch {}
    try { aDur = await probeDurationSec(voicePath); } catch {}
    // Audio is master. For mild mismatches, retime the video with setpts so the
    // visual action spans the narration instead of drifting into the next beat.
    //   ratio < 1.0 => video is shorter than narration -> slow video down
    //   ratio > 1.0 => video is longer than narration  -> speed video up
    // Keep retiming conservative; bigger mismatches are handled by gap-fill or tail pad.
    const retimeMin = Number(process.env.VIDEO_RETIME_MIN || 0.82);
    const retimeMax = Number(process.env.VIDEO_RETIME_MAX || 1.18);
    let speed = 1.0;
    let retime = false;
    if (vDur > 0.5 && aDur > 0.5) {
      const ratio = vDur / aDur;
      if (ratio >= retimeMin && ratio <= retimeMax && Math.abs(ratio - 1) > 0.015) {
        speed = ratio;
        retime = true;
      }
    }
    const videoChain = retime
      ? `setpts=PTS/${speed.toFixed(5)},tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`
      : `tpad=stop_mode=clone:stop_duration=${((vDur > 0 && aDur > 0) ? Math.max(padSec, aDur - vDur + 0.75) : padSec).toFixed(3)}`;
    if (retime) {
      console.log(`[render ${jobId}] BEAT-RETIME: ${path.basename(outPath)} video=${vDur.toFixed(2)}s audio=${aDur.toFixed(2)}s speed=${speed.toFixed(3)}x`);
    }
    return new Promise((res) => {
      const ff = spawn("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "warning",
        "-i", videoPath,
        "-i", voicePath,
        "-filter_complex",
          `[0:v]${videoChain}[vpad]`,
        "-map", "[vpad]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-shortest",
        ...(aDur > 0 ? ["-t", aDur.toFixed(3)] : []),
        outPath,
      ], { stdio: "ignore" });
      const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(false); }, 180_000);
      ff.on("close", (code) => { clearTimeout(t); res(code === 0); });
      ff.on("error", () => { clearTimeout(t); res(false); });
    });
  };

  // Helper: concat multiple video-only clips into one using filter_complex (robust to VFR)
  const _concatVideoClips = (clips, outPath) => new Promise((res) => {
    const _inputs  = clips.flatMap((p) => ["-i", p]);
    const _filter  = clips.map((_, k) => `[${k}:v]`).join("") +
                     `concat=n=${clips.length}:v=1:a=0[vout]`;
    const ff = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "warning",
      ..._inputs,
      "-filter_complex", _filter,
      "-map", "[vout]",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-an",
      outPath,
    ], { stdio: "ignore" });
    const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(false); }, 120_000);
    ff.on("close", (code) => { clearTimeout(t); res(code === 0); });
    ff.on("error", () => { clearTimeout(t); res(false); });
  });

  await jobStore.update(jobId, { progress: 45, message: "Assembling beat videos" });
  const _muxedPaths = [];

  // ── PHASE A: BUILD BEAT VIDEOS ───────────────────────────────────────────────
  // Concat each beat's sub-clips into a single video-only file.
  // Audio is master: TTS duration drives all footage timing decisions.
  const _beatVideoStore = new Map(); // bi → assembled video path (no audio)

  for (const _bi of _beatOrder) {
    const _beatClips = _beatGroupMap.get(_bi) || [];
    if (_beatClips.length === 0) continue;
    let _beatVidPath;
    if (_beatClips.length === 1) {
      _beatVidPath = _beatClips[0];
    } else {
      _beatVidPath = path.join(UPLOADS_DIR, `beat-concat-${jobId}-${String(_bi).padStart(3, "0")}.mp4`);
      const concatOk = await _concatVideoClips(_beatClips, _beatVidPath);
      if (!concatOk) {
        console.warn(`[render ${jobId}] beat-concat ${_bi} failed — using first sub-clip`);
        _beatVidPath = _beatClips[0];
      }
    }
    _beatVideoStore.set(_bi, _beatVidPath);
  }
  console.log(`[render ${jobId}] PHASE-A: ${_beatVideoStore.size} beat videos assembled`);

  // ── PHASE B: GAP-FILL + VOICE MUX ────────────────────────────────────────────
  // Audio is master. TTS (per-beat, measured from generated audio) drives footage timing.
  // • TTS > video → gap-fill: borrow adjacent scene footage from source.
  // • Video > TTS → -shortest trims to audio end; 0.3s visual tail (lead-out).
  // • Sync validation per beat: drift ≤0.30s PASS / ≤0.75s WARN / >0.75s FIX.
  await jobStore.update(jobId, { progress: 60, message: "Muxing beats" });
  let _beatMuxDone = 0;
  let _syncPass = 0, _syncWarn = 0, _syncFix = 0;
  for (const _bi of _beatOrder) {
    const _beatRawVidPath = _beatVideoStore.get(_bi);
    if (!_beatRawVidPath) {
      const _beatClips = _beatGroupMap.get(_bi) || [];
      _muxedPaths.push(..._beatClips);
      _beatMuxDone++;
      continue;
    }

    // TTS: always from original per-beat voice generated during PER-BEAT TTS step
    const _voId    = voiceoverFileIds[_bi] || null;
    const _voPath  = _voId ? path.join(UPLOADS_DIR, _voId) : null;

    if (!_voPath) {
      console.warn(`[render ${jobId}] beat ${_bi} missing voice file — skipping silent segment`);
      _beatMuxDone++;
      continue;
    }
    let _hasVoice = false;
    try { await fs.access(_voPath); _hasVoice = true; } catch {}
    if (!_hasVoice) {
      console.warn(`[render ${jobId}] beat ${_bi} voice file not found (${_voId}) — skipping silent segment`);
      _beatMuxDone++;
      continue;
    }

    let _beatVideoPath = _beatRawVidPath;

    // ── AUDIO-MASTER SYNC ─────────────────────────────────────────────────────
    // Spec: TTS is the master timeline. Video always adapts — never reverse.
    // CASE 1 (video < TTS content): gap-fill via Steps 1→4.
    // CASE 2 (video > TTS content): _muxVideoWithVoice -shortest trims at audio end.
    const _muxPadSec = 0.25;  // spec: 0.2–0.3s visual tail
    {
      const _vidDur = await probeDurationSec(_beatVideoPath).catch(() => 0);

      // Use NARRATION CONTENT duration, not full MP3 file duration.
      // Speechify MP3 files contain 0.7–2.6s of trailing silence after the last
      // spoken word. probeDurationSec(_voPath) returns the full file length, which
      // caused gap-fill to fire on every beat trying to match silence that the mux
      // discards anyway. Use whisperBeatDurations (content-only, from Whisper word
      // alignment) or _perBeatTtsDurations (measured during generation) instead.
      const _tsDurArr = Array.isArray(whisperBeatDurations) ? whisperBeatDurations
                      : Array.isArray(_perBeatTtsDurations) ? _perBeatTtsDurations
                      : null;
      const _contentDur = (_tsDurArr && Number(_tsDurArr[_bi]) > 0.05)
        ? Number(_tsDurArr[_bi])
        : await probeDurationSec(_voPath).catch(() => 0);
      const _fileDur = await probeDurationSec(_voPath).catch(() => _contentDur);
      const _isTailBeat = _beatOrder.indexOf(_bi) >= Math.max(0, _beatOrder.length - 3);
      const _voiDur = _isTailBeat ? Math.max(_contentDur, _fileDur) : _contentDur;

      const _gap    = _voiDur - _vidDur;  // +ve = video short, -ve = video long

      if (_gap > 0.30 && _vidDur > 0) {
        // CASE 1: video shorter than TTS by > 0.30s
        const _beat      = beats[_bi];
        const _nextBeat  = beats[_bi + 1];
        const _beatStart = Number(_beat?.startSec || 0);
        const _beatEnd   = Number(_beat?.endSec   || _beatStart + _vidDur);
        const _nextStart = _nextBeat ? Number(_nextBeat.startSec) : _beatEnd + 120;
        const _target    = _voiDur + 0.25;  // desired clip duration

        let _extPath = _beatVideoPath;
        let _extDur  = _vidDur;

        // STEP 1+2: re-trim beat's own source window (same sceneIds), just longer
        {
          const _s1End = Math.min(_beatStart + _target, _nextStart - 0.1);
          if (_s1End > _beatStart + _extDur + 0.2 && _beatStart >= 0) {
            const _s1Path = path.join(UPLOADS_DIR, `beat-gf1-${jobId}-${String(_bi).padStart(3,"0")}.mp4`);
            const _s1Ok   = await new Promise((res) => {
              const ff = spawn("ffmpeg", buildTrimArgs({
                inputPath: sourcePath, startSec: _beatStart, endSec: _s1End,
                outputPath: _s1Path, reencode: true,
              }), { stdio: "ignore" });
              const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(false); }, 90_000);
              ff.on("close", (code) => { clearTimeout(t); res(code === 0); });
              ff.on("error", () => { clearTimeout(t); res(false); });
            });
            if (_s1Ok) {
              const _s1Dur = await probeDurationSec(_s1Path).catch(() => 0);
              if (_s1Dur > _extDur) { _extPath = _s1Path; _extDur = _s1Dur; console.log(`[render ${jobId}] GAP-FILL beat ${_bi}: Step1 own scene → ${_extDur.toFixed(1)}s`); }
            }
          }
        }

        // STEP 3: immediately adjacent scenes from same continuous event (+1, +2 only)
        if (_target - _extDur > 0.30 && _scenesMap && Array.isArray(_beat?.sceneIds) && _beat.sceneIds.length > 0) {
          const _lastScId = _beat.sceneIds[_beat.sceneIds.length - 1];
          for (const adjId of [_lastScId + 1, _lastScId + 2]) {
            if (_target - _extDur <= 0.30) break;
            const adjScene = _scenesMap.get(adjId);
            if (!adjScene) break;
            const adjEnd = Math.min(Number(adjScene.endSec), _nextStart - 0.1);
            if (adjEnd <= _beatStart + _extDur + 0.2) break;
            const _s3Path = path.join(UPLOADS_DIR, `beat-gf3-${jobId}-${String(_bi).padStart(3,"0")}-s${adjId}.mp4`);
            const _s3Ok   = await new Promise((res) => {
              const ff = spawn("ffmpeg", buildTrimArgs({
                inputPath: sourcePath, startSec: _beatStart, endSec: adjEnd,
                outputPath: _s3Path, reencode: true,
