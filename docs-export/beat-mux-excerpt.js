
      if (!_outroTtsOk) {
        console.warn(`[render ${jobId}] OUTRO TTS: all providers failed — outro skipped`);
      }

      if (_outroTtsOk) {
        console.log(`[render ${jobId}] OUTRO TTS: ${_outroDurSec.toFixed(1)}s — id=${_outroTtsId}`);
        // Use footage from 55% into the film — avoids the climax/ending region
        // that story beats already cover (last 30%), preventing the same footage
        // appearing in the outro that viewers just watched in beats 70-80.
        let _oSrcDur = 0;
        try { _oSrcDur = await probeDurationSec(sourcePath); } catch {}
        if (_oSrcDur > 60) {
          const _oStart    = Math.max(30, _oSrcDur * 0.55);
          const _oEnd      = Math.min(_oSrcDur - 3, _oStart + Math.max(_outroDurSec + 3, 15));
          const _oClipPath = path.join(UPLOADS_DIR, `outro-clip-${jobId}.mp4`);
          const _oArgs     = buildTrimArgs({ inputPath: sourcePath, startSec: _oStart, endSec: _oEnd, outputPath: _oClipPath, reencode: true });
          await new Promise((res) => {
            const ff = spawn("ffmpeg", _oArgs, { stdio: "ignore" });
            const t  = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 90_000);
            ff.on("close", (code) => {
              clearTimeout(t);
              if (code === 0) {
                clipPaths.push(_oClipPath);
                voiceoverFileIds.push(_outroTtsId);
                console.log(`[render ${jobId}] OUTRO: appended clip (${_oStart.toFixed(0)}–${_oEnd.toFixed(0)}s) + TTS ${_outroTtsId}`);
              } else {
                console.warn(`[render ${jobId}] outro clip failed (code ${code}) — skipping`);
              }
              res();
            });
            ff.on("error", (e) => { clearTimeout(t); console.warn(`[render ${jobId}] outro clip error:`, e?.message || e); res(); });
          });
        }
      }
    }
  } catch (outroErr) {
    console.warn(`[render ${jobId}] outro generation failed (non-fatal):`, outroErr?.message || outroErr);
  }
  // ── END OUTRO SEGMENT ─────────────────────────────────────────────────────

  const outputPath     = path.join(OUTPUT_DIR, `recap-${jobId}.mp4`);
  let musicPath        = musicPathOverride
    ? musicPathOverride
    : (musicFileId ? path.join(UPLOADS_DIR, musicFileId) : null);
  let adaptiveMusicPath = null;
  let outputDurationSec = 0; // used by poster generation below

  // ── BEAT-BY-BEAT MUX ─────────────────────────────────────────────────────
  // GROUP-BY-BEAT MUX: concat each beat's sub-clips into one beat video (video-only),
  // then mux with the beat's full TTS voice file using -shortest.
  // This ensures narration plays CONTINUOUSLY over all visual cuts within a beat —
  // no audio interruption at 6-second sub-clip boundaries.
  //
  // clipPaths layout: [sub1_b0, sub2_b0, sub3_b0, sub1_b1, ...]
  //   Hook is NOT in clipPaths — it is muxed independently after body BEAT-MUX.
  //   cleanClips[j].beatIndex → which beat owns sub-clip j
  //   voiceoverFileIds[beatIndex] → the beat's TTS file

  // Build beat groups: beatIndex → [clipPath, ...] in timeline order
  const _beatGroupMap = new Map();
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
    // Audio is master. Never speed up narration or footage here; if the full MP3
    // runs longer than the assembled video, clone the final frame so -shortest
    // ends on the audio stream instead of cutting the last words.
    const tailPad = (vDur > 0 && aDur > 0) ? Math.max(padSec, aDur - vDur + 0.75) : padSec;
    return new Promise((res) => {
      const ff = spawn("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "warning",
        "-i", videoPath,
        "-i", voicePath,
        "-filter_complex",
          `[0:v]tpad=stop_mode=clone:stop_duration=${tailPad.toFixed(3)}[vpad]`,
        "-map", "[vpad]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-shortest", outPath,
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
