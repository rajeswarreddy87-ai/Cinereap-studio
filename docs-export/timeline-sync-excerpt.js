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
          console.log(`[render ${jobId}] GEMINI: skipped (GEMINI_API_KEY not set)`);
        }
        // ── END GEMINI FLASH VERIFICATION ────────────────────────────────────

        // ── TEXT-TO-TEXT BEAT NOTE MATCHING (zero cost, always available) ────
        // Uses beat notes Claude already wrote during analyze — no extra API call.
        // Only fires for beats CLIP did not already improve, and only when the
        // footage window is shorter than the TTS duration (LOW-SYNC risk beats).
        {
          const _txtResult = _textMatchBeatNotes(beats, voDurs);
          if (_txtResult.applied > 0) {
            scenes = scenes.map((sc, i) => {
              if (protectedVisualBeats[i]) return sc;
              if (sc.reason && (sc.reason.includes('[clip:') || sc.reason.includes('[gemini:'))) return sc;
              return _txtResult.scenes[i];
