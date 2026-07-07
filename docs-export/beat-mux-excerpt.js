        const timer = setTimeout(() => {
          try { ff.kill("SIGKILL"); } catch {}
          console.warn(`[render ${jobId}] ffmpeg trim ${i} timed out (${TRIM_TIMEOUT_MS / 1000}s) — skipping`);
          clipDone();
        }, TRIM_TIMEOUT_MS);

        ff.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) trimResults[i] = clipPath;
          else console.warn(`[render ${jobId}] ffmpeg trim ${i} failed (code ${code}) — skipping`);
          clipDone();
        });
        ff.on("error", (err) => {
          clearTimeout(timer);
          console.warn(`[render ${jobId}] ffmpeg trim ${i} spawn error: ${err?.message || err} — skipping`);
          clipDone();
        });
      }

      // Edge case: nothing was ever launched (0 clips)
      if (nextIndex >= cleanClips.length && active === 0) finish();
    };

    launchNext(); // kick off the pool
  });

  // Compact to only successfully-trimmed clips (no holes).
  let clipPaths = trimResults.filter((p) => p);
  if (clipPaths.length === 0) {
    throw new Error("All clip trims failed — check the source file and timestamps.");
  }

  // Hook is kept separate — it will be muxed as an independent segment after
  // the body BEAT-MUX completes, then prepended to the final manifest.
  // (No clipPaths / voiceoverFileIds modification here.)

  // ── HOOK FOOTAGE CLIP — DISABLED ─────────────────────────────────────────
  // Legacy hook system. Superseded by HOOK V2 above.
  if (false && _hookTtsId) {
    let _hSrcDur = 0;
    try { _hSrcDur = await probeDurationSec(sourcePath); } catch {}
    if (_hSrcDur > 40) {
      // Cap hook footage at first 35% of movie — prevents picking from the
      // climax/ending region that story beats already cover, which causes the
      // "same scene appears at hook AND near end" problem.
      const _hCeil = Math.min(_hSrcDur * 0.35, _hSrcDur - 60);
      try {
        const _hookMergedPath = path.join(UPLOADS_DIR, `hook-clip-${jobId}.mp4`);
        let _hookSubClips = [];

        // ── DIRECT-TIMESTAMP PATH (on-demand hook) ──────────────────────────
        // When the hook was generated on-demand, _hookDirectTimestamps holds the
        // actual {startSec,endSec} of the beats used to write the narration.
        // Use these directly — no position-index lookup table needed.
        if (_hookDirectTimestamps && _hookDirectTimestamps.length > 0) {
          for (let _di = 0; _di < _hookDirectTimestamps.length; _di++) {
            const dt = _hookDirectTimestamps[_di];
            const mid = (Number(dt.startSec) + Number(dt.endSec)) / 2;
            if (mid < 30 || mid > _hCeil - 5) {
              console.log(`[render ${jobId}] HOOK-DIRECT: idx=${_di} mid=${mid.toFixed(0)}s out of range — skipping`);
              continue;
            }
            const clipLen  = Math.min(6, Math.max(3, Number(dt.endSec) - Number(dt.startSec)));
            const subStart = Math.max(30, mid - clipLen / 2);
            const subEnd   = subStart + clipLen;
            const subPath  = path.join(UPLOADS_DIR, `hook-sub-${jobId}-d${_di}.mp4`);
            const subArgs  = buildTrimArgs({ inputPath: sourcePath, startSec: subStart, endSec: subEnd, outputPath: subPath, reencode: true });
            await new Promise((res) => {
              const ff = spawn("ffmpeg", subArgs, { stdio: "ignore" });
              const t  = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 60_000);
              ff.on("close", (code) => { clearTimeout(t); if (code === 0) _hookSubClips.push(subPath); res(); });
              ff.on("error", () => { clearTimeout(t); res(); });
            });
          }
          if (_hookSubClips.length > 0) {
            console.log(`[render ${jobId}] HOOK: direct-timestamp multi-clips: ${_hookSubClips.length} sub-clips from [${_hookDirectTimestamps.map(t => Math.round(t.startSec)).join(",")}]s`);
          }
        }
        // ── END DIRECT-TIMESTAMP PATH ────────────────────────────────────────

        // Primary lookup: scenesList index → exact detected scene boundaries.
        // Fallback A: _preTrimBeats index map (when scenesList absent from analyze job).
        const _hookSceneLookup = _scenesMap
          ?? (Array.isArray(_preTrimBeats) && _preTrimBeats.length > 0
            ? new Map(_preTrimBeats.map(b => [b.index, b]))
            : null);
        // Fallback B: 1-based beat POSITION map.
        // GPT is given the beat list as "${i+1}. narration" and returns hookSceneIds
        // as 1-based list positions (e.g. "2" means the 2nd beat, not scene index 2).
        // Those values get stored as if they are scene detection indices, so
        // _hookSceneLookup.get(2) finds FFmpeg scene #2 (early credits, ~60 s) instead
        // of the 2nd story beat.  This second map resolves the position interpretation.
        const _hookBeatPosLookup = Array.isArray(_preTrimBeats) && _preTrimBeats.length > 0
          ? new Map(_preTrimBeats.map((b, i) => [i + 1, b]))
          : null;
        console.log(
          `[render ${jobId}] HOOK-DBG: hookSceneIds=${JSON.stringify(_hookSceneIds)}, ` +
          `sceneLookup=${_hookSceneLookup ? _hookSceneLookup.size : 'null'}, ` +
          `beatPosLookup=${_hookBeatPosLookup ? _hookBeatPosLookup.size : 'null'}`
        );

        if (_hookSceneIds && _hookSceneIds.length > 0 && (_hookSceneLookup || _hookBeatPosLookup)) {
          // Multi-clip path: one 5-6 s clip per hookSceneId so footage mirrors
          // each dramatic moment the hook narration actually describes.
          for (let _hi = 0; _hi < _hookSceneIds.length; _hi++) {
            const id = _hookSceneIds[_hi];
            // Try scene-index lookup first.
            let sc = _hookSceneLookup?.get(id);
            // If scene-index lookup returned a very early scene (<90 s) it is probably
            // a credits/logo mismatch (GPT returned a beat position, not a scene index).
            // Fall back to the 1-based beat-position map in that case.
            if (!sc || (Number(sc.startSec) < 90 && _hookBeatPosLookup)) {
              const bpSc = _hookBeatPosLookup?.get(id);
              if (bpSc && Number(bpSc.startSec) >= 90) sc = bpSc;
            }
            if (!sc) {
              console.log(`[render ${jobId}] HOOK-DBG: id=${id} not in any lookup — skipping`);
              continue;
            }
            const mid     = (Number(sc.startSec) + Number(sc.endSec)) / 2;
            if (mid < 30 || mid > _hCeil - 5) {
              console.log(`[render ${jobId}] HOOK-DBG: id=${id} mid=${mid.toFixed(1)}s out of range (30..${(_hCeil-5).toFixed(0)}s) — skipping`);
              continue;
            }
            const clipLen = Math.min(6, Math.max(3, Number(sc.endSec) - Number(sc.startSec)));
            const subStart = Math.max(30, mid - clipLen / 2);
            const subEnd   = subStart + clipLen;
            const subPath  = path.join(UPLOADS_DIR, `hook-sub-${jobId}-${_hi}.mp4`);
            const subArgs  = buildTrimArgs({ inputPath: sourcePath, startSec: subStart, endSec: subEnd, outputPath: subPath, reencode: true });
            await new Promise((res) => {
              const ff = spawn("ffmpeg", subArgs, { stdio: "ignore" });
              const t  = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 60_000);
              ff.on("close", (code) => { clearTimeout(t); if (code === 0) _hookSubClips.push(subPath); res(); });
              ff.on("error", () => { clearTimeout(t); res(); });
            });
          }
          if (_hookSubClips.length > 0) {
            console.log(`[render ${jobId}] HOOK: trimmed ${_hookSubClips.length} sub-clips from hookSceneIds=[${_hookSceneIds.join(",")}]`);
          } else {
            console.log(`[render ${jobId}] HOOK-DBG: all hookSceneIds filtered — will try beat-based emergency clips`);
          }
        }

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
