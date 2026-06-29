    // Hoisted outside try block so the mux gap-fill loop (below) can reference them.
    let srcDur = 0;
    let safeCeiling = 0;

    try {
      let voDurs = await Promise.all(
        voiceoverFileIds.map((id) => probeDurationSec(path.join(UPLOADS_DIR, id)).catch(() => 0)),
      );
      voiceTotalPre = voDurs.reduce((a, b) => a + (Number(b) || 0), 0);
      console.log(`[render ${jobId}] SYNC: voiceTotalPre=${voiceTotalPre.toFixed(2)}s`);
      try { srcDur = await probeDurationSec(sourcePath); } catch {}
      // CREDITS-SAFE CEILING: never let the synced visuals reach the closing
      // credits. Mirror the scene detector's guard (drop the greater of last
      // 90s or 3.5% of runtime, capped at 8%). The sync engine clamps every
      // produced trim to this ceiling, so credits can never appear during
      // narration even when footage must be re-passed to cover a long voiceover.
      safeCeiling = srcDur;
      if (srcDur > 0) {
        const creditsTail = Math.min(srcDur * 0.08, Math.max(90, srcDur * 0.035));
        safeCeiling = Math.max(srcDur * 0.5, srcDur - creditsTail);
      }
      // Extend the last beat's window to safeCeiling so it has full movie
      // footage rather than the AI's original 6-second clip window.
      if (beats.length > 0 && safeCeiling > 0) {
        const lastB = beats[beats.length - 1];
        if (safeCeiling > Number(lastB.startSec)) {
          beats[beats.length - 1] = { ...lastB, endSec: Math.max(Number(lastB.endSec), safeCeiling) };
        }
        const poolSec = beats.reduce((s, b) => s + Math.max(0, Number(b.endSec) - Number(b.startSec)), 0);
        const winSizes = beats.slice(0, 3).map(b => (Number(b.endSec)-Number(b.startSec)).toFixed(0));
        console.log(`[render ${jobId}] SYNC: last beat extended to ${safeCeiling.toFixed(0)}s ceiling, pool=${poolSec.toFixed(0)}s, first3windows=${winSizes.join(',')}s`);
      }
      if (voiceTotalPre > 0.5) {
        // ── WINDOW ADEQUACY EXPANSION ─────────────────────────────────────────
        // After measuring exact per-beat TTS durations (voDurs), expand any beat
        // whose footage window is shorter than its narration.  Borrowing from the
        // next 1-2 beats is safe because the forward cursor in buildSyncedTimeline
        // is strictly monotonic — the adjacent beat simply advances past the
        // section borrowed here, so no footage is repeated within a single beat.
        // This expansion updates `beats` in-place so that:
        //   (a) computeSyncScore reports accurate coverage (not a pre-TTS guess),
        //   (b) buildSyncedTimeline receives correctly-sized windows.
        {
          let expanded = 0;
          let slowMo = 0;
          beats = beats.map((b, i) => {
            const win = Math.max(0, Number(b.endSec) - Number(b.startSec));
            const tts = Number(voDurs[i]) || 0;
            if (tts <= 0 || win >= tts * 1.05) return b; // window ≥105% TTS — OK
            const ratio = win / tts;

            if (ratio >= 0.70) {
              // Mild mismatch (≤30% short): gentle slow-motion, max 1.43× slowdown.
              // The clip is time-stretched via FFmpeg setpts so its output duration
              // equals the TTS length exactly — no scene-borrowing needed.
              // Looks cinematic; ratio < 0.70 would feel unnaturally sluggish.
              slowMo++;
              return { ...b, slowFactor: ratio };
            }

            // Severe mismatch (>30% short): slow-mo would be too obvious.
            // Expand the footage window by borrowing from the next 1-2 beats instead.
            // Safe because the forward cursor is monotonic — adjacent beats simply
            // advance past any borrowed frames.
            const targetEnd = Number(b.startSec) + tts * 1.2;
            const nextEnd = i + 1 < beats.length ? Number(beats[i + 1].endSec) : safeCeiling;
            const farEnd  = i + 2 < beats.length ? Number(beats[i + 2].endSec) : nextEnd;
            const newEnd = Math.min(targetEnd, Math.max(nextEnd, farEnd), safeCeiling || targetEnd + 60);
            if (newEnd > Number(b.endSec) + 0.5) {
              expanded++;
              return { ...b, endSec: newEnd };
            }
            return b;
          });
          const parts = [];
          if (expanded > 0) parts.push(`${expanded} window-expanded`);
          if (slowMo > 0)   parts.push(`${slowMo} time-stretched (slow-mo, ratio ≥70%)`);
          if (parts.length > 0) {
            console.log(`[render ${jobId}] SYNC: window-adequacy: ${parts.join(', ')}`);
          }
        }
        // ── END WINDOW ADEQUACY EXPANSION ─────────────────────────────────────

        let scenes = beats.map((b) => ({ startSec: Number(b.startSec), endSec: Number(b.endSec), reason: b.reason || b.narration || "" }));
        let beatTexts = beats.map((b) => (typeof b.narration === "string" ? b.narration : ""));
        const protectedVisualBeats = beats.map(isProtectedBeatForVisual);
        const originalBeatScenes = scenes.map((sc) => ({ ...sc, label: "analyze" }));
        const transcriptCandidateScenes = beatTexts.map((txt) => findTranscriptCandidateForBeat(txt, sourceTranscriptSegments, srcDur));
        let siglipCandidateScenes = new Array(scenes.length).fill(null);

        // ── CLIP SEMANTIC MATCHING (best-effort, falls back to time windows) ────
        // When the CLIP sidecar has embeddings for this analyze job, replace each
        // beat's time window with a window centred on the most semantically
        // matching frame — so "John shoots Marcus" pulls a frame of that moment
        // rather than whatever footage happened to fall in that time range.
        if (_analyzeJobId) {
          try {
            let framesDir = path.join(UPLOADS_DIR, `frames-${_analyzeJobId}`);
            let frameFiles = (await fs.readdir(framesDir).catch(() => []))
              .filter((f) => f.endsWith(".jpg"))
              .sort();

            // FIX: cache-copied analyze jobs copy only the result JSON — not the frames
            // directory (which is stored under frames-{originalJobId}). When the render
            // uses a cache-copy analyzeJobId the frames dir is empty and CLIP silently
            // skips. Resolve the original by matching sourceFileId across analyze jobs.
            if (frameFiles.length === 0) {
              try {
                const _cacheJob = await jobStore.get(_analyzeJobId);
                const _cacheSrcId = _cacheJob?.result?.sourceFileId || _cacheJob?.sourceFileId;
                if (_cacheSrcId) {
                  const allFramesDirs = (await fs.readdir(UPLOADS_DIR, { withFileTypes: true }))
                    .filter((d) => d.isDirectory() && d.name.startsWith("frames-"));
                  for (const entry of allFramesDirs) {
                    const altJobId = entry.name.slice("frames-".length);
                    if (altJobId === _analyzeJobId) continue;
                    const altJob = await jobStore.get(altJobId);
                    const altSrcId = altJob?.result?.sourceFileId || altJob?.sourceFileId;
                    if (altSrcId !== _cacheSrcId) continue;
                    const altDir = path.join(UPLOADS_DIR, entry.name);
                    const altFiles = (await fs.readdir(altDir).catch(() => []))
                      .filter((f) => f.endsWith(".jpg")).sort();
                    if (altFiles.length > 0) {
                      framesDir  = altDir;
                      frameFiles = altFiles;
                      console.log(`[render ${jobId}] CLIP: resolved frames via original analyze job ${altJobId} (${altFiles.length} frames, srcId=${_cacheSrcId})`);
                      break;
                    }
                  }
                }
              } catch (_fbErr) {
                console.warn(`[render ${jobId}] CLIP: frame fallback lookup failed:`, _fbErr?.message);
              }
            }

            if (frameFiles.length > 0) {
              let srcDurClip = 0;
              try { srcDurClip = await probeDurationSec(sourcePath); } catch {}
              // Use clip-metadata.json written by analyze step for correct per-scene
              // timestamps. Fallback: even-spaced reconstruction (inaccurate for the
              // scene-aware path — kept for old analyze jobs that predate the metadata).
              let frames;
              const _metaPath = path.join(framesDir, 'clip-metadata.json');
              try {
                const _metaItems = JSON.parse(await fs.readFile(_metaPath, 'utf8'));
                frames = _metaItems
                  .filter(m => m.file && m.timeSec > 0)
                  .map(m => ({ path: path.join(framesDir, m.file), timeSec: m.timeSec }));
                console.log(`[render ${jobId}] CLIP: metadata loaded — ${frames.length} frames with scene-accurate timestamps`);
              } catch {
                // Legacy fallback: even-spaced timestamps (wrong for scene-aware extraction)
                const stepSec = srcDurClip > 0 ? srcDurClip / (frameFiles.length + 1) : 0;
                frames = frameFiles.map((f, i) => ({
                  path: path.join(framesDir, f),
                  timeSec: stepSec > 0 ? stepSec * (i + 1) : 0,
                })).filter(f => f.timeSec > 0);
                console.log(`[render ${jobId}] CLIP: no metadata — using legacy even-spaced timestamps (${frames.length} frames)`);
              }

              if (frames.length > 0) {
                // 1. Ensure embeddings are stored in the sidecar (idempotent)
                const embedRes = await callClipSidecar("/embed-job", {
                  jobId: _analyzeJobId,
                  frames,
                }, 300_000); // 5 min — CPU embedding of ~178 scene frames takes 2-4 min

                if (embedRes && embedRes.frames > 0) {
                  // 2. Match each beat's narration text to best-matching frame
                  const nonEmptyTexts = beatTexts.map((t) => t.trim() || "film scene");
                  const matchRes = await callClipSidecar("/match", {
                    jobId: _analyzeJobId,
                    texts: nonEmptyTexts,
                  }, 60_000);

                  if (matchRes && Array.isArray(matchRes.results) && matchRes.results.length === scenes.length) {
                    let clipApplied = 0;
                    let clipCandidateCount = 0;
                    scenes = scenes.map((sc, i) => {
                      const m = matchRes.results[i];
                      if (m && Number.isFinite(Number(m.timeSec))) {
                        const center = Number(m.timeSec);
                        const winHalf = Math.max(8, (Number(sc.endSec) - Number(sc.startSec)) / 2);
                        siglipCandidateScenes[i] = {
                          label: "siglip",
                          startSec: Math.max(0, center - winHalf),
                          endSec: Math.min(srcDurClip || center + winHalf, center + winHalf),
                          score: Number(m.score) || 0,
                        };
                        clipCandidateCount++;
                      }
                      if (protectedVisualBeats[i]) return sc; // funeral/death/climax beats stay on analyzed source window
                      // Direct-apply only very confident SigLIP matches; otherwise Gemini verifier decides.
                      if (!m || m.score < Number(process.env.VISUAL_APPLY_THRESHOLD || 0.16)) return sc;
                      const center = Number(m.timeSec);
                      const _scMid = (Number(sc.startSec) + Number(sc.endSec)) / 2;
                      const _liberalRadius = srcDurClip > 0 ? srcDurClip * 0.15 : 300;
                      if (center < _scMid - _liberalRadius || center > _scMid + _liberalRadius) return sc;
                      const winHalf = Math.max(8, (sc.endSec - sc.startSec) / 2);
                      clipApplied++;
                      return {
                        ...sc,
                        startSec: Math.max(0, center - winHalf),
                        endSec: center + winHalf,
                        reason: (sc.reason || "") + ` [siglip:${m.score.toFixed(2)}]`,
                      };
                    });
                    console.log(
                      `[render ${jobId}] SIGLIP: candidates=${clipCandidateCount}/${scenes.length}, direct-applied=${clipApplied}/${scenes.length} ` +
                      `(frames=${embedRes.frames}, analyzeJob=${_analyzeJobId})`
                    );
                  } else {
                    console.warn(`[render ${jobId}] SIGLIP: match failed or length mismatch`);
                  }
                }
              }
            }
          } catch (clipErr) {
            console.warn(`[render ${jobId}] CLIP matching skipped:`, clipErr?.message || clipErr);
          }
        }
        // ── END CLIP SEMANTIC MATCHING ────────────────────────────────────────

        // ── GEMINI FLASH VERIFICATION ────────────────────────────────────────
        // Final multimodal verifier: Whisper candidate + local visual candidates +
        // Gemini chooses the best short clip. Runs only when GEMINI_API_KEY is set.
        if (SERVER_GEMINI_KEY) {
          const maxVerify = Math.max(0, Math.min(scenes.length, Number(process.env.GEMINI_VERIFY_MAX_BEATS || 35)));
          let attemptedGemini = 0, appliedGemini = 0, rejectedGemini = 0, skippedGemini = 0, failedGemini = 0;
          for (let i = 0; i < maxVerify; i++) {
            const cands = _dedupeCandidates([
              { ...originalBeatScenes[i], label: "analyze" },
              siglipCandidateScenes[i] ? { ...siglipCandidateScenes[i], label: "siglip" } : null,
              scenes[i] ? { ...scenes[i], label: scenes[i].reason?.includes('[siglip:') ? "siglip-current" : "current" } : null,
              transcriptCandidateScenes[i] ? { ...transcriptCandidateScenes[i], label: "whisper" } : null,
            ]);
            if (cands.length < 2) { skippedGemini++; continue; }
            attemptedGemini++;
            const v = await verifyBeatCandidatesWithGemini({ jobId, beatIndex: i, narration: beatTexts[i], sourcePath, candidates: cands });
            if (!v) { failedGemini++; continue; }
            if (v.confidence >= Number(process.env.GEMINI_ACCEPT_THRESHOLD || 0.35)) {
              const chosen = cands[v.index];
              // Never let Gemini move protected beats away unless it chooses the analyzed/protected source.
              if (protectedVisualBeats[i] && chosen.label !== "analyze") { rejectedGemini++; continue; }
              scenes[i] = { ...scenes[i], startSec: chosen.startSec, endSec: chosen.endSec, reason: `${scenes[i]?.reason || ''} [gemini:${chosen.label}:${v.confidence.toFixed(2)}]` };
              appliedGemini++;
            } else {
              rejectedGemini++;
            }
          }
          console.log(`[render ${jobId}] GEMINI: candidates attempted=${attemptedGemini}, applied=${appliedGemini}, rejected=${rejectedGemini}, failed=${failedGemini}, skipped=${skippedGemini}`);
        } else {
