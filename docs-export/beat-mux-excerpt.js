        // Emergency fallback: hookSceneIds lookup produced nothing.
        // Use the first 5 story beats (past the credits region) as hook footage.
        // These are guaranteed real story content in chronological order.
        if (_hookSubClips.length === 0 && Array.isArray(_preTrimBeats || beats)) {
          const _emergencySource = _preTrimBeats || beats;
          const _emergencyBeats  = _emergencySource
            .filter(b => Number(b.startSec) > 90 && Number(b.startSec) < _hCeil - 30)
            .slice(0, 8);
          for (let _ei = 0; _ei < _emergencyBeats.length && _hookSubClips.length < 5; _ei++) {
            const eb       = _emergencyBeats[_ei];
            const mid      = (Number(eb.startSec) + Number(eb.endSec)) / 2;
            const clipLen  = 5;
            const subStart = Math.max(30, mid - clipLen / 2);
            const subEnd   = subStart + clipLen;
            const subPath  = path.join(UPLOADS_DIR, `hook-sub-${jobId}-e${_ei}.mp4`);
            const subArgs  = buildTrimArgs({ inputPath: sourcePath, startSec: subStart, endSec: subEnd, outputPath: subPath, reencode: true });
            await new Promise((res) => {
              const ff = spawn("ffmpeg", subArgs, { stdio: "ignore" });
              const t  = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 60_000);
              ff.on("close", (code) => { clearTimeout(t); if (code === 0) _hookSubClips.push(subPath); res(); });
              ff.on("error", () => { clearTimeout(t); res(); });
            });
          }
          if (_hookSubClips.length > 0) {
            console.log(`[render ${jobId}] HOOK: emergency beat-clips: ${_hookSubClips.length} sub-clips from first story beats`);
          }
        }

        // Last resort: single clip from most dramatic moment in first 35%.
        // Clip duration matches the final hook TTS duration (after atempo speedup)
        // so the hook video and audio are perfectly aligned with no drift into body.
        if (_hookSubClips.length === 0) {
          // Default to 15% into movie (past credits, before climax)
          let _hDramaSec = Math.min(_hSrcDur * 0.15, _hCeil - 38);
          if (Array.isArray(beats) && beats.length > 2) {
            // Pick highest-importance beat that falls within the first 35% ceiling
            const earlyBeats = beats.filter(b => {
              const tc = (Number(b.startSec) + Number(b.endSec)) / 2;
              return tc > 120 && tc < _hCeil - 38;
            });
            if (earlyBeats.length > 0) {
              const top = earlyBeats.reduce((a, b) => (+(b.importance || 0) > +(a.importance || 0)) ? b : a, earlyBeats[0]);
              const tc  = (Number(top.startSec) + Number(top.endSec)) / 2;
              if (tc > 120 && tc < _hCeil - 38) _hDramaSec = tc;
            }
          }
          // Use the actual TTS duration (post-atempo) so the clip matches the audio exactly
          const _hClipDur = _hookFinalDurSec > 5 ? _hookFinalDurSec + 1 : 30;
          const _hStart  = Math.max(120, Math.min(_hDramaSec - _hClipDur / 2, _hCeil - _hClipDur - 5));
          const fallPath = path.join(UPLOADS_DIR, `hook-sub-${jobId}-0.mp4`);
          const fallArgs = buildTrimArgs({ inputPath: sourcePath, startSec: _hStart, endSec: _hStart + _hClipDur, outputPath: fallPath, reencode: true });
          await new Promise((res) => {
            const ff = spawn("ffmpeg", fallArgs, { stdio: "ignore" });
            const t  = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 60_000);
            ff.on("close", (code) => { clearTimeout(t); if (code === 0) _hookSubClips.push(fallPath); res(); });
            ff.on("error", () => { clearTimeout(t); res(); });
          });
          if (_hookSubClips.length > 0) {
            console.log(`[render ${jobId}] HOOK: last-resort single 32 s clip (drama@${Math.round(_hDramaSec)}s)`);
          }
        }

        if (_hookSubClips.length === 1) {
          clipPaths.unshift(_hookSubClips[0]);
          voiceoverFileIds.unshift(_hookTtsId);
          console.log(`[render ${jobId}] HOOK: single sub-clip prepended + TTS ${_hookTtsId}`);
        } else if (_hookSubClips.length > 1) {
          // Merge sub-clips into one hook track then prepend
          const _hManifest = path.join(UPLOADS_DIR, `hook-manifest-${jobId}.txt`);
          await fs.writeFile(_hManifest, _hookSubClips.map((p) => `file '${p}'`).join("\n"), "utf8");
          await new Promise((res) => {
            const ff = spawn("ffmpeg", [
              "-f", "concat", "-safe", "0", "-i", _hManifest,
              "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-an", "-y", _hookMergedPath,
            ], { stdio: "ignore" });
            const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 90_000);
            ff.on("close", (code) => {
              clearTimeout(t);
              if (code === 0) {
                clipPaths.unshift(_hookMergedPath);
                voiceoverFileIds.unshift(_hookTtsId);
                console.log(`[render ${jobId}] HOOK: ${_hookSubClips.length} sub-clips merged + prepended + TTS ${_hookTtsId}`);
              } else {
                console.warn(`[render ${jobId}] hook merge failed (code ${code}) — skipping hook`);
              }
              res();
            });
            ff.on("error", (e) => { clearTimeout(t); console.warn(`[render ${jobId}] hook merge error:`, e?.message || e); res(); });
          });
          for (const sc of _hookSubClips) { try { await fs.unlink(sc); } catch {} }
          try { await fs.unlink(_hManifest); } catch {}
        }
      } catch (hClipErr) {
        console.warn(`[render ${jobId}] hook clip failed (non-fatal):`, hClipErr?.message || hClipErr);
      }
    } // end if (_hSrcDur > 40)
  }
  // ── END HOOK FOOTAGE CLIP ─────────────────────────────────────────────────

  // ── OUTRO SEGMENT — DISABLED ─────────────────────────────────────────────
  // Outro removed. Video ends cleanly after last body beat.
  if (false) try {
    const _outroText = (typeof settings?.outroText === "string" && settings.outroText.trim())
      ? settings.outroText.trim()
      : "That's the complete story. If you enjoyed this breakdown, hit like and subscribe for more movie recaps every week.";
    if (_hookTtsKey) {
      const _outroTtsSpeed = (settings && settings.ttsSpeed) || 1.0;
      const _outroTtsId    = `${jobId}-outro-tts-beat-000.mp3`;
      const _outroTtsPath  = path.join(UPLOADS_DIR, _outroTtsId);
      let _outroDurSec     = 0;
      let _outroTtsOk      = false;

      // Attempt 1: primary TTS provider (same as story beats)
      try {
        await _ttsOnce(_hookTtsProvider, _hookTtsKey, _hookTtsVoice, _outroTtsSpeed, _outroText, _outroTtsPath);
        _outroDurSec = await probeDurationSec(_outroTtsPath);
        if (_outroDurSec > 0.1) { _outroTtsOk = true; }
      } catch (e1) {
        console.warn(`[render ${jobId}] OUTRO TTS: primary provider failed — ${e1?.message || e1}`);
      }

      // Attempt 2: OpenAI fallback (reliable, always available)
      if (!_outroTtsOk && SERVER_OPENAI_KEY) {
        try {
          await new Promise(r => setTimeout(r, 2000)); // brief pause before fallback
          await _ttsOnce("openai", SERVER_OPENAI_KEY, "onyx", 1.0, _outroText, _outroTtsPath);
          _outroDurSec = await probeDurationSec(_outroTtsPath);
          if (_outroDurSec > 0.1) { _outroTtsOk = true; console.log(`[render ${jobId}] OUTRO TTS: used OpenAI fallback`); }
        } catch (e2) {
          console.warn(`[render ${jobId}] OUTRO TTS: OpenAI fallback also failed — ${e2?.message || e2}`);
        }
      }

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
  const _muxVideoWithVoice = (videoPath, voicePath, outPath, padSec = 0.25) => new Promise((res) => {
    // Video gets tpad=0.6s clone frames so there is always a visual tail after narration.
    // Audio is mapped directly (no apad filter) — apad+filter_complex+shortest caused
    // audio corruption (stammering, silent beats) on this FFmpeg build.
    //
    // -shortest stops at whichever stream ends first:
