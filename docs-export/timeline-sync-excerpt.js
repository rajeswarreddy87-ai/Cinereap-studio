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
                    scenes = scenes.map((sc, i) => {
                      const m = matchRes.results[i];
                      // Only apply if score is confident enough (CLIP cosine > 0.22)
                      // and the matched frame is within the general timeline region.
                      if (!m || m.score < 0.22) return sc;
                      const center = m.timeSec;
                      // FIX: Widened window guard. The old strict check (center must be
                      // within sc.startSec..sc.endSec) prevented CLIP from correcting
                      // beats where Claude placed the timestamp in the wrong scene.
                      // New guard: allow CLIP to relocate a beat's window as long as the
                      // matched frame is within ±15% of movie duration from the beat midpoint.
                      // This lets CLIP escape Claude's wrong timestamps (e.g. "Layla scene"
                      // assigned to minute 30 but Layla actually appears at minute 45)
                      // while still staying in the correct chronological region.
                      const _scMid = (Number(sc.startSec) + Number(sc.endSec)) / 2;
                      const _liberalRadius = srcDurClip > 0 ? srcDurClip * 0.15 : 300;
                      if (center < _scMid - _liberalRadius || center > _scMid + _liberalRadius) return sc;
                      const winHalf = Math.max(8, (sc.endSec - sc.startSec) / 2);
                      clipApplied++;
                      return {
                        ...sc,
                        startSec: Math.max(0, center - winHalf),
                        endSec: center + winHalf,
                        reason: (sc.reason || "") + ` [clip:${m.score.toFixed(2)}]`,
                      };
                    });
                    console.log(
                      `[render ${jobId}] CLIP: semantic windows applied to ${clipApplied}/${scenes.length} beats ` +
                      `(frames=${embedRes.frames}, analyzeJob=${_analyzeJobId})`
                    );
                  }
                }
              }
            }
          } catch (clipErr) {
            console.warn(`[render ${jobId}] CLIP matching skipped:`, clipErr?.message || clipErr);
          }
        }
        // ── END CLIP SEMANTIC MATCHING ────────────────────────────────────────

        // ── TEXT-TO-TEXT BEAT NOTE MATCHING (zero cost, always available) ────
        // Uses beat notes Claude already wrote during analyze — no extra API call.
        // Only fires for beats CLIP did not already improve, and only when the
        // footage window is shorter than the TTS duration (LOW-SYNC risk beats).
        {
          const _txtResult = _textMatchBeatNotes(beats, voDurs);
          if (_txtResult.applied > 0) {
            scenes = scenes.map((sc, i) => {
              if (sc.reason && sc.reason.includes('[clip:')) return sc; // CLIP already handled
              return _txtResult.scenes[i];
            });
            console.log(
              `[render ${jobId}] TEXT-MATCH: re-centred ${_txtResult.applied} footage-starved beat(s) ` +
              `using note similarity — ${_txtResult.log.slice(0, 5).join(', ')}` +
              (_txtResult.log.length > 5 ? ` (+${_txtResult.log.length - 5} more)` : '')
            );
          }
        }
        // ── END TEXT-TO-TEXT BEAT NOTE MATCHING ──────────────────────────────

        // Intro-safe start: the earliest second of footage that may appear
        // on-screen. Derived from the first surviving beat so credits,
        // production logos, and title cards are never drawable even on
        // reset-passes when the pool is re-swept for long narrations.
        let safeStart = scenes.length > 0
          ? Math.max(0, scenes.reduce((mn, s) => Math.min(mn, s.startSec), Infinity))
          : 0;
        // Logo-safety floor for feature films: studio logos (Universal, WB, etc.)
        // and opening title cards can run 60-120s. If the beat analysis places the
        // first scene before 120s, bump the floor so those frames never appear.
        // Only applies to feature-length content (>30 min) to avoid cutting real
        // opening scenes from short films.
        if (srcDur > 1800) {
          // 4% of runtime, max 4 min. Southpaw and similar films run opening
          // credits through 3-4 min; 120s cap was too low and caused credits
          // to appear as the first body beat after the hook.
          const logoFloor = Math.min(240, srcDur * 0.04);
          if (safeStart < logoFloor) {
            console.log(`[render ${jobId}] SYNC: logo-safety floor raised ${safeStart.toFixed(1)}→${logoFloor.toFixed(1)}s (feature film intro guard)`);
            safeStart = logoFloor;
          }
        }
        if (safeStart > 0) {
          console.log(`[render ${jobId}] SYNC: intro-skip floor = ${safeStart.toFixed(1)}s (no footage before first real beat)`);
          // Enforce the floor, not just log it. Drop pre-credit/logo beats and keep
          // beats/voice files/durations/text in lockstep so narration cannot describe
          // footage that we intentionally refuse to show.
          const keepIdx = [];
          for (let i = 0; i < scenes.length; i++) {
            const st = Number(scenes[i].startSec) || 0;
            const en = Number(scenes[i].endSec) || 0;
            if (en > safeStart + 0.5) keepIdx.push(i);
          }
          const beforeIntro = scenes.length;
          if (keepIdx.length > 0 && keepIdx.length < scenes.length) {
            scenes = keepIdx.map((i) => {
              const sc = scenes[i];
              return Number(sc.startSec) < safeStart ? { ...sc, startSec: safeStart } : sc;
            });
            beats = keepIdx.map((i) => beats[i]);
            beatTexts = keepIdx.map((i) => beatTexts[i]);
            voDurs = keepIdx.map((i) => voDurs[i]);
            voiceoverFileIds = keepIdx.map((i) => voiceoverFileIds[i]).filter(Boolean);
            if (Array.isArray(_perBeatTtsDurations)) _perBeatTtsDurations = keepIdx.map((i) => _perBeatTtsDurations[i]);
            if (Array.isArray(whisperBeatDurations)) whisperBeatDurations = keepIdx.map((i) => whisperBeatDurations[i]);
            console.log(`[render ${jobId}] SYNC: intro filter dropped ${beforeIntro - scenes.length} pre-floor beat(s); firstStart=${Number(scenes[0]?.startSec || 0).toFixed(1)}s`);
          } else {
            scenes = scenes.map((sc) => Number(sc.startSec) < safeStart && Number(sc.endSec) > safeStart
              ? { ...sc, startSec: safeStart }
              : sc);
          }
        }
        // Decide distribution mode:
        //   per-beat-audio  → voice files count equals beats count → exact audio durations
        //   even            → mismatch (e.g. 7 files, 44 beats) → equal slice per beat
        //   word-count      → narration text available and lengths match → proportional
        const voiceBeatMatch = voDurs.length === scenes.length && scenes.length > 0;
        let useEvenDist = !voiceBeatMatch;
        const distMode = voiceBeatMatch ? "per-beat-audio" : "even";
        console.log(`[render ${jobId}] SYNC: distribution=${distMode} (${voDurs.length} voiceFiles, ${scenes.length} beats)`);

        // Whisper word-level alignment (req #3): when voice file count ≠ beat count
        // (even-distribution mode) AND an OpenAI key is available, run Whisper on the
        // combined voiceover to get EXACT per-beat durations from actual speech timing.
        // This eliminates word-count estimation drift (the cause of 15s vs 54s swings).
        whisperBeatDurations = null; // reset each sync pass (declared at function scope above)
        // ChatGPT pipeline: run Whisper alignment whenever an OpenAI key is available
        // and voice files + beat texts are ready — not just on even-distribution paths.
        // Per-beat TTS (one file per beat) gives the BEST Whisper word alignment since
        // the word-count cursor matches exactly one narration text per audio file.
        if (SERVER_OPENAI_KEY && voiceoverFileIds.length > 0 && beatTexts.length === scenes.length) {
          try {
            await jobStore.update(jobId, { message: "Aligning beat timing with Whisper word timestamps" });
            const wDurs = await alignBeatsByWhisperWords(voiceoverFileIds, beatTexts, SERVER_OPENAI_KEY, UPLOADS_DIR);
            if (Array.isArray(wDurs) && wDurs.length === beatTexts.length && wDurs.every((d) => d !== null && d > 0)) {
              whisperBeatDurations = wDurs;
              useEvenDist = false;
              console.log(`[render ${jobId}] SYNC: Whisper word alignment succeeded → exact per-beat durations`);
            } else {
              console.warn(`[render ${jobId}] SYNC: Whisper alignment returned partial nulls; falling back to even dist`);
            }
          } catch (wErr) {
            console.warn(`[render ${jobId}] SYNC: Whisper alignment failed (using even distribution):`, wErr?.message || wErr);
          }
        }

        // ── Long Scene Subdivision ──────────────────────────────────────────
        // Any scene window longer than 60s is split into ~20s sub-ranges before
        // planSyncedRender. This prevents a single long conversation scene from
        // filling the entire forward cursor with one static shot.
        function subdivideScenes(sceneArr, maxSec = 60, subSec = 20) {
          const out = [];
          for (const sc of sceneArr) {
            const dur = Number(sc.endSec) - Number(sc.startSec);
            if (dur <= maxSec) { out.push(sc); continue; }
            // Split into subSec-length chunks; last chunk absorbs the remainder.
            let cur = Number(sc.startSec);
            let sub = 0;
            while (cur < Number(sc.endSec) - 0.5) {
              const next = Math.min(cur + subSec, Number(sc.endSec));
              out.push({ ...sc, startSec: cur, endSec: next, _subLabel: `${sc.index ?? "?"}${String.fromCharCode(65 + sub)}` });
              cur = next;
              sub++;
            }
          }
          return out;
        }
        // Skip SUBDIVIDE when exact per-beat TTS durations are available.
        // SUBDIVIDE expands scene count (e.g. 80→251) but whisperBeatDurations stays at 80.
        // planSyncedRender requires beatDurations.length === scenes.length to use real TTS
        // durations — a mismatch causes it to fall back to equal distribution (all clips same
        // length → zero sync). When we have per-beat audio, subdivision is unnecessary anyway:
        // each beat already has an exact measured duration and the forward cursor handles variety.
        //
        // IMPORTANT: also skip when per-beat Speechify voDurs matches scene count —
        // previously whisperBeatDurations was always null for Speechify, causing subdivide
        // to always run and produce a scenes/durations length mismatch → equal distribution
        // → all clips 2.80s → 33% gap-fill → zigzag video.
        const hasExactBeatDurs = (
          (Array.isArray(whisperBeatDurations) && whisperBeatDurations.length === scenes.length) ||
          (Array.isArray(voDurs) && voDurs.length === scenes.length)
        );
        const scenesForPlan = hasExactBeatDurs ? scenes : subdivideScenes(scenes, 60, 20);
        if (hasExactBeatDurs) {
          const _durSrc = Array.isArray(whisperBeatDurations) ? 'whisper' : 'speechify';
          console.log(`[render ${jobId}] SUBDIVIDE: skipped — exact per-beat TTS durations present (${scenes.length} scenes, source=${_durSrc})`);
        } else if (scenesForPlan.length !== scenes.length) {
          console.log(`[render ${jobId}] SUBDIVIDE: ${scenes.length} scenes → ${scenesForPlan.length} after splitting long scenes (>60s)`);
        }

        const plan = planSyncedRender({
          scenes: scenesForPlan,
          voiceTotalSec: voiceTotalPre,
          beatTexts,
          beatDurations: whisperBeatDurations || voDurs,
          // When voice file count does not match beat count we cannot know how
          // narration maps to individual beats.  Even distribution (equal seconds
          // per beat) is far more accurate than word-count of short reason labels
          // which caused 15 s vs 54 s swings and severe audio/video drift.
          useEvenDistribution: useEvenDist,
          sourceDurationSec: safeCeiling || srcDur || undefined,
          sourceStartSec: safeStart > 0 ? safeStart : undefined,
          // ChatGPT pipeline: pass per-beat importance scores so buildSyncedTimeline
          // applies dynamic cut timing (2.5s for transitional, 5.0s for climax).
          beatImportances: Array.isArray(beats) ? beats.map((b) => b.importance ?? null) : undefined,
