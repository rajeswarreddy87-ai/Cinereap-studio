          if (j.status !== "done") continue;
          if ((j.result?.sourceFileId || j.sourceFileId) !== sourceFileId) continue;
          const t = j.completedAt || j.updatedAt || 0;
          if (t > bestTime && Array.isArray(j.result?.beats) && j.result.beats.length > 0) {
            bestTime = t;
            bestJob = j;
          }
        } catch {}
      }
      if (bestJob) {
        beats = bestJob.result.beats;
        console.log(`[render ${jobId}] AUTO-LOAD: ${beats.length} beats from analyze job (${sourceFileId})`);
        await jobStore.update(jobId, {
          progress: 6,
          message: `Loaded ${beats.length} scenes from analysis — generating narration audio…`,
        });
      } else {
        console.warn(`[render ${jobId}] AUTO-LOAD: no analyze job with beats found for ${sourceFileId}`);
        await jobStore.update(jobId, {
          message: `No scene analysis found for this clip — video will render without narration`,
        });
      }
    } catch (autoErr) {
      console.warn(`[render ${jobId}] AUTO-LOAD: failed:`, autoErr?.message || autoErr);
      await jobStore.update(jobId, {
        message: `Scene lookup failed: ${String(autoErr?.message || autoErr).slice(0, 80)}`,
      });
    }
  }

  // ── PRE-SYNC: redistribute zero-origin timestamps and activate audioSeconds
  // sync when the app sent per-beat audioSeconds but no real scene windows.
  //
  // The app always sends an `audioSeconds` field on each timestamp recording
  // exactly how long that beat's narration runs. When the AI script step
  // didn't produce real scene windows (startSec=0, endSec=0), the clips all
  // point to the first frame of the movie and the visuals loop endlessly.
  // Fix: spread the windows evenly across the credits-safe region of the film
  // so the footage actually advances, then use audioSeconds as exact on-screen
  // durations instead of guessing from word counts.
  {
    const hasAudioSec = Array.isArray(timestamps) && timestamps.length > 0 &&
      timestamps.every((t) => typeof t.audioSeconds === 'number' && t.audioSeconds > 0);
    if (hasAudioSec) {
      // Count how many timestamps have no real scene window.
      const zeroCount = timestamps.filter(
        (t) => t.startSec === 0 && (t.endSec === 0 || t.endSec <= 1)
      ).length;
      const needsRedistribution = zeroCount > timestamps.length * 0.3;
      if (needsRedistribution) {
        let srcDurPre = 0;
        try { srcDurPre = await probeDurationSec(sourcePath); } catch {}
        if (srcDurPre > 60) {
          const creditsTailPre = Math.min(srcDurPre * 0.08, Math.max(90, srcDurPre * 0.035));
          const safeEndPre   = Math.max(srcDurPre * 0.5, srcDurPre - creditsTailPre);
          const safeStartPre = Math.min(180, srcDurPre * 0.04);
          const n = timestamps.length;
          const safeWindow = safeEndPre - safeStartPre;
          timestamps = timestamps.map((t, i) => {
            // Keep any timestamp that already has a real non-trivial window.
            if (t.startSec > 0 && t.endSec > t.startSec + 1 && t.endSec < srcDurPre * 0.9) return t;
            // Intro: first timestamp spanning the whole movie — give it the opening.
            if (i === 0 && t.endSec >= srcDurPre * 0.5) {
              const winDur = Math.min(t.audioSeconds * 0.8, 10);
              return { ...t, startSec: safeStartPre, endSec: Math.min(safeStartPre + winDur, safeEndPre) };
            }
            // Outro: last timestamp — give it the closing section.
            if (i === n - 1) {
              const winDur = Math.min(t.audioSeconds * 0.8, 10);
              return { ...t, startSec: Math.max(safeEndPre - winDur, safeStartPre), endSec: safeEndPre };
            }
            // Body beats: spread evenly, proportional to audioSeconds.
            const frac = n > 2 ? (i - 0.5) / (n - 1) : 0.5;
            const clipDur = Math.min(t.audioSeconds * 0.7, 8);
            const center = safeStartPre + Math.max(0, Math.min(1, frac)) * (safeWindow - clipDur);
            return { ...t, startSec: Math.max(safeStartPre, center), endSec: Math.min(center + clipDur, safeEndPre) };
          });
          console.log(`[render ${jobId}] redistributed ${zeroCount}/${n} zero-origin timestamps across ${safeStartPre.toFixed(0)}-${safeEndPre.toFixed(0)}s`);
        }
      }
      // Now activate audioSeconds sync: use the measured narration duration per beat
      // directly as the on-screen duration (beats.js planSyncedRender otherwise
      // estimates this from word counts, which diverges for TTS-generated audio).
      // Only activate when there is no explicit beats array (that path already handles sync).
      if ((!Array.isArray(beats) || beats.length === 0) && voiceoverFileIds.length > 0) {
        const totalAudioSec = timestamps.reduce((a, t) => a + (Number(t.audioSeconds) || 0), 0);
        if (totalAudioSec > 10) {
          let srcDurAudio = 0;
          try { srcDurAudio = await probeDurationSec(sourcePath); } catch {}
          let safeCeilingAudio = srcDurAudio;
          if (srcDurAudio > 0) {
            const ct = Math.min(srcDurAudio * 0.08, Math.max(90, srcDurAudio * 0.035));
            safeCeilingAudio = Math.max(srcDurAudio * 0.5, srcDurAudio - ct);
          }
          const audioScenes = timestamps.map((t) => ({
            startSec: Number(t.startSec),
            endSec:   Number(t.endSec),
            reason:   t.reason || '',
          }));
          const audioBeatDurations = timestamps.map((t) => Number(t.audioSeconds));
          try {
            const audioTimeline = buildSyncedTimeline(audioScenes, audioBeatDurations, {
              sourceDurationSec: safeCeilingAudio || srcDurAudio || undefined,
            });
            if (audioTimeline.length > 0) {
              timestamps = audioTimeline.filter(
                (t) => Number.isFinite(t.startSec) && Number.isFinite(t.endSec) && t.endSec - t.startSec >= 0.1
              );
              console.log(`[render ${jobId}] audioSeconds sync: ${audioTimeline.length} segs from ${audioScenes.length} beats, total=${totalAudioSec.toFixed(1)}s`);
            }
          } catch (e) {
            console.warn(`[render ${jobId}] audioSeconds sync failed, using redistributed timestamps:`, e?.message || e);
          }
        }
      }
    }
  }

  // ── AUTO-LOAD ANALYZE BEATS (scene-to-scene narration sync) ─────────────
  // The app sends zero-origin timestamps ({startSec:0,endSec:0}) because it
  // doesn't forward the scene windows from the analyze step to the render call.
  // The analyze step already ran Claude and produced perfect per-beat data:
  // real startSec/endSec windows + narration text for each scene.
  // We look that up here and inject it as the beats array so the sync planner
  // can align narration to actual movie scenes — no app change needed.
  if ((!Array.isArray(beats) || beats.length === 0) && voiceoverFileIds.length > 0) {
    const zeroTsCount = Array.isArray(timestamps)
      ? timestamps.filter((t) => t.startSec === 0 && (t.endSec === 0 || t.endSec <= 1)).length
      : 0;
    if (zeroTsCount > (timestamps?.length ?? 0) * 0.3) {
      try {
        const allJobs = await jobStore.list();
        // Find the most recent completed analyze job for this source file.
        const analyzeJob = allJobs
          .filter(
            (j) =>
              j.kind === 'analyze' &&
              (j.sourceFileId === fileId || j.result?.sourceFileId === fileId) &&
              j.status === 'done' &&
              Array.isArray(j.result?.beats) &&
              j.result.beats.length > 0,
          )
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (analyzeJob) {
          // Sort beats chronologically (they should already be, but be safe).
          let rawBeats = analyzeJob.result.beats
            .slice()
            .sort((a, b) => Number(a.startSec) - Number(b.startSec));

          // FIX A — Drop beats Claude labelled as SKIP (studio logos, title cards).
          // No hard time threshold — story content starts at different points
          // per film and region. Trust Claude's own beat notes exclusively.
          const beforeSkip = rawBeats.length;
          rawBeats = rawBeats.filter((b) => {
            const narr = String(b.narration || b.reason || "").trim();
            if (narr.toUpperCase().startsWith("SKIP")) return false;
            if (/\b(studio|logo|production\s*company|distributor|credit|title\s*card|opening\s*credit)\b/i.test(narr)) return false;
            return true;
          });
          if (rawBeats.length < beforeSkip) {
            console.log(`[render ${jobId}] scene-sync: filtered ${beforeSkip - rawBeats.length} SKIP/credits beats`);
          }

          // FIX B — Expand each beat window from its tight 6-second clip to the
          // FULL scene range (beat[i].startSec → beat[i+1].startSec).
          // Without this, 48×6s=288s of footage covers a 1226s narration only
          // by cycling the same clips 4+ times.  With full ranges, the pool is
          // ~5800s for a 2-hour film — far more than enough, zero re-cycling.
          // Compute safe ceiling for last-beat window extension (avoids credits).
          let _srcDurAL = 0;
          try { _srcDurAL = await probeDurationSec(sourcePath); } catch {}
          const _ceilAL = _srcDurAL > 0
            ? Math.max(_srcDurAL * 0.5, _srcDurAL - Math.min(_srcDurAL * 0.08, Math.max(90, _srcDurAL * 0.035)))
            : 0;

          // ChatGPT pipeline: build a sceneId → timestamp map from the stored
          // scenesList so we can resolve exact detected-scene boundaries per beat.
          const _scenesList = analyzeJob.result.scenesList;
          _scenesMap = Array.isArray(_scenesList) && _scenesList.length > 0
            ? new Map(_scenesList.map((s) => [s.index, s])) : null;
          const _sceneIdsResolved = { count: 0, fallback: 0 };

          beats = rawBeats.map((b, i) => {
            // ChatGPT pipeline: use sceneIds to resolve EXACT detected-scene window.
            // beat.sceneIds covers [firstScene ... lastScene] from scene detection.
            if (Array.isArray(b.sceneIds) && b.sceneIds.length > 0 && _scenesMap) {
              const firstSc = _scenesMap.get(b.sceneIds[0]);
              const lastSc  = _scenesMap.get(b.sceneIds[b.sceneIds.length - 1]);
              if (firstSc && lastSc) {
                let resolvedStart = Math.min(Number(b.startSec), firstSc.startSec);
                let resolvedEnd = _ceilAL > 0
                  ? Math.min(lastSc.endSec, _ceilAL) : lastSc.endSec;

                // ChatGPT pipeline: confidence < 0.7 → expand window to adjacent scenes.
                // Low confidence means Claude is uncertain the narration matches this footage;
                // a larger pool gives buildSyncedTimeline better clip options to choose from.
                const conf = Number.isFinite(Number(b.confidence)) ? Number(b.confidence) : 1.0;
                if (conf < 0.7 && _scenesMap) {
                  const lastUsedId = b.sceneIds[b.sceneIds.length - 1];
                  const expandIds = [lastUsedId + 1, lastUsedId + 2].filter((id) => _scenesMap.has(id));
                  for (const eid of expandIds) {
                    const esc = _scenesMap.get(eid);
                    if (esc) resolvedEnd = Math.max(resolvedEnd, _ceilAL > 0 ? Math.min(esc.endSec, _ceilAL) : esc.endSec);
                  }
                  if (expandIds.length > 0) {
                    console.log(`[render ${jobId}] FIX-B: beat ${i} confidence=${conf.toFixed(2)} < 0.7 — expanded window +${expandIds.length} adjacent scenes`);
                  }
                }

                _sceneIdsResolved.count++;
                return {
                  ...b,
                  startSec: resolvedStart,
                  endSec:   resolvedEnd,
                };
              }
            }
            // FIX B fallback (no sceneIds stored or scene not found in map):
            // extend window to next beat's start — same as original FIX B.
            _sceneIdsResolved.fallback++;
            if (i < rawBeats.length - 1) {
              return { ...b, endSec: Math.max(Number(b.endSec), Number(rawBeats[i + 1].startSec)) };
            }
            // Last beat: extend window to safe ceiling.
            const lastEnd = _ceilAL > Number(b.startSec) ? _ceilAL : Number(b.endSec);
            return { ...b, endSec: Math.max(Number(b.endSec), lastEnd) };
          });
          console.log(
            `[render ${jobId}] FIX-B: sceneIds resolved ${_sceneIdsResolved.count} beats, ` +
            `fallback FIX-B on ${_sceneIdsResolved.fallback} beats`,
          );

          _analyzeJobId = analyzeJob.id;
          _hookText = typeof analyzeJob.result.hookText === "string" && analyzeJob.result.hookText.trim()
            ? analyzeJob.result.hookText.trim() : null;
          _hookSceneIds = Array.isArray(analyzeJob.result.hookSceneIds) && analyzeJob.result.hookSceneIds.length > 0
            ? analyzeJob.result.hookSceneIds.map(Number).filter(Number.isFinite) : null;
          if (_hookText) {
            console.log(
              `[render ${jobId}] HOOK: loaded ${_hookText.split(/\s+/).filter(Boolean).length}-word hook` +
              (_hookSceneIds ? ` with hookSceneIds=[${_hookSceneIds.join(",")}]` : " (no hookSceneIds)")
            );
          }
          console.log(
            `[render ${jobId}] scene-sync: loaded ${beats.length} beats from ` +
            `analyze job ${analyzeJob.id} — windows expanded to full scene ranges`,
          );
          await jobStore.update(jobId, {
            message: `Scene sync: ${beats.length} scenes, windows expanded for unique footage`,
          });
        }
      } catch (e) {
        console.warn(`[render ${jobId}] could not auto-load analyze beats:`, e?.message || e);
      }
    }
  }

  // ---- v2.2 TRUE SYNC: if the caller sent per-beat narration windows, replace
  // the incoming timestamps with a narration-paced timeline (no looping). We
  // measure the voiceover length up front so each beat's on-screen duration
  // matches how long it is spoken. `syncMode` then forces videoLoopCount=0.
  let syncMode = false;
  let syncBeatDurations = null;   // per-beat seconds (for music spans)
  let syncMoods = null;           // per-beat moods (for music spans)
  let voiceTotalPre = 0;
  let _perBeatTtsDurations = null; // set by per-beat TTS; used for SRT + sync score
  let whisperBeatDurations = null; // hoisted here so Phase-B gap-fill can read it
  if (Array.isArray(beats) && beats.length > 0 &&
      (voiceoverFileIds.length > 0 || !!(SERVER_SPEECHIFY_KEY || SERVER_OPENAI_KEY))) {
    // ── UNIVERSAL BEAT NORMALISATION ──────────────────────────────────────
    // Runs BEFORE anything else in the sync block so it applies whether
    // beats came from the app request body OR were auto-loaded from the
    // analyze job.  Previously the SKIP filter and window expansion only
    // lived in the auto-load path, so app-sent beats (which bypass
    // auto-load) still carried 6-second windows and SKIP entries —
    // causing the planner to cycle the same 288s of footage 4+ times.
    {
      const beatsBefore = beats.length;

      // ── PAIRED SORT: keep voiceoverFileIds in lockstep with beats ───────
      // When the app sends one audio file per beat (lengths match), sorting
      // beats by startSec without reordering the audio causes a complete
      // narration-to-video mismatch: audio plays in script order while video
      // plays in chronological order. Fix: tag each beat with its original
      // index so we can reconstruct the audio order after sorting/filtering.
      const voicePerBeat = voiceoverFileIds.length === beats.length && beats.length > 0;
      let taggedBeats = beats.map((b, i) => ({ ...b, _origIdx: i }));

      taggedBeats = taggedBeats
        .filter((b) => {
          // Drop only beats Claude labelled as SKIP or described as credits/logos.
          // No hard time threshold — story content starts at different points
          // per film and region.
          const narr = String(b.narration || b.reason || "").trim();
          if (narr.toUpperCase().startsWith("SKIP")) return false;
          if (/\b(studio|logo|production\s*company|distributor|credit|title\s*card|opening\s*credit)\b/i.test(narr)) return false;
          return true;
        })
        .sort((a, b) => Number(a.startSec) - Number(b.startSec))
        .map((b, i, arr) => {
          // Expand each window to the full scene range (next beat's startSec).
          if (i < arr.length - 1) {
            return { ...b, endSec: Math.max(Number(b.endSec), Number(arr[i + 1].startSec)) };
          }
          return b; // last beat: extended to safeCeiling below
        });

      // Reorder audio files to match the sorted beat order.
      if (voicePerBeat && taggedBeats.length > 0) {
        const origVoice = voiceoverFileIds.slice();
        voiceoverFileIds = taggedBeats.map((b) => origVoice[b._origIdx]).filter(Boolean);
        const reordered = taggedBeats.some((b, i) => b._origIdx !== i);
        if (reordered) {
          console.log(`[render ${jobId}] SYNC: reordered ${taggedBeats.length} voice files to match chronological beat order`);
        }
      }

      // Strip internal tag before using beats downstream.
      beats = taggedBeats.map(({ _origIdx, ...b }) => b);

      const poolSec = beats.reduce((s, b) => s + Math.max(0, Number(b.endSec) - Number(b.startSec)), 0);
      console.log(
        `[render ${jobId}] SYNC: beats normalised ${beatsBefore}→${beats.length}` +
        ` (SKIP/intro filtered, windows expanded, unique pool=${poolSec.toFixed(0)}s)`,
      );
    }
    // ── END NORMALISATION ─────────────────────────────────────────────────

    // ── RECAP LENGTH TARGET ────────────────────────────────────────────────────
    // Compute beat target from user-selected duration (passed as targetMinutes).
    // Average TTS per beat ≈ 15s empirically; clamp between 40 and 120 beats.
    // Save full beat list before trimming — hook footage lookup needs all scene indices.
    const _preTrimBeats = beats.slice();
    {
      const AVG_BEAT_SEC  = 15;
      const BEATS_TARGET  = Math.max(40, Math.min(120, Math.round((+targetMinutes || 20) * 60 / AVG_BEAT_SEC)));
      if (beats.length > BEATS_TARGET) {
        const original = beats.slice();

        // ── STRATIFIED SAMPLING ──────────────────────────────────────────────
        // Divide the chronological beat list into BEATS_TARGET equal-sized buckets
        // and pick the highest-importance beat from each bucket.
        //
        // Why stratified instead of pure importance ranking:
        //   Pure top-N by importance clusters selected beats in exciting mid-film
        //   sections, leaving the first act and resolution under-represented.
        //   Stratified sampling guarantees one beat per timeline segment, so every
        //   part of the movie (opening → midpoint → climax → resolution) is covered
        //   regardless of where Claude assigned high importance scores.
        const bucketSize = original.length / BEATS_TARGET;
        const seenRefs   = new Set();
        const kept = Array.from({ length: BEATS_TARGET }, (_, b) => {
          const start  = Math.floor(b * bucketSize);
          const end    = Math.min(Math.ceil((b + 1) * bucketSize), original.length);
          const bucket = original.slice(start, end);
          if (bucket.length === 0) return null;
          // Within each bucket prefer the beat with the highest importance score.
          // Falls back to the first beat in the bucket when no scores are present.
          const best = bucket.reduce((top, beat) =>
            +(beat.importance || 0) >= +(top.importance || 0) ? beat : top
          );
          if (seenRefs.has(best)) return null;
          seenRefs.add(best);
          return best;
        }).filter(Boolean);

        console.log(`[render ${jobId}] BEAT-TRIM: ${original.length}→${kept.length} beats (target=${BEATS_TARGET} for ${+targetMinutes || 20}min, stratified)`);
        beats = kept;
      } else {
        console.log(`[render ${jobId}] BEAT-TRIM: ${beats.length} beats — under target (${BEATS_TARGET} for ${+targetMinutes || 20}min), keeping all`);
      }
    }
    // ── END RECAP LENGTH TARGET ───────────────────────────────────────────────

    // ── HOOK V2 GENERATION ─────────────────────────────────────────────────
    // Select top emotional beats by hookScore, ask Claude to write hook text
    // referencing those exact beat IDs. Footage will come from the same beats.
    // Mismatch between narration and footage is structurally impossible.
    if (HOOK_V2 && Array.isArray(beats) && beats.length >= 5 && (SERVER_ANTHROPIC_KEY || SERVER_OPENAI_KEY)) {
      try {
        // Step 1: score each beat
        const _hv2Scored = beats.map((b, i) => {
          const imp = +(b.importance    || 0);
          const emo = +(b.emotionScore  || imp);
          const sur = +(b.surpriseScore || imp);
          return { _idx: i, hookScore: imp * 0.60 + emo * 0.30 + sur * 0.10 };
        });

        // Step 2: top 8 by hookScore, restore chronological order.
        // FIX: Beats sent from the app often lack importance/emotionScore/surpriseScore
        // fields, causing all hookScores to be 0. When that happens, the old code
        // silently fell back to the first 8 chronological beats (opening scenes) which
        // are dull and non-dramatic. Instead, when all scores are 0, sample from the
        // climax region (40–80% through the story) which contains the peak drama.
        const _allZeroHookScores = _hv2Scored.every(s => s.hookScore === 0);
        let _hv2Top;
        if (_allZeroHookScores) {
          const n = beats.length;
          const _climaxCandidates = _hv2Scored.filter(({ _idx }) => {
            const frac = _idx / Math.max(1, n - 1);
            return frac >= 0.40 && frac <= 0.80;
          });
          // Use climax region if it has at least 4 beats; otherwise use all beats
          const _hv2Pool = _climaxCandidates.length >= 4 ? _climaxCandidates : _hv2Scored;
          // Evenly sample 8 beats from the pool to get good coverage
          const _stride = Math.max(1, Math.floor(_hv2Pool.length / 8));
          _hv2Top = _hv2Pool
            .filter((_, k) => k % _stride === 0)
            .slice(0, 8)
            .sort((a, b) => a._idx - b._idx);
          console.log(`[render ${jobId}] HOOK-V2: no importance scores — sampling ${_hv2Top.length} beats from climax region (beats ${_hv2Top.map(x => x._idx).join(",")})`);
        } else {
          _hv2Top = _hv2Scored
            .slice()
            .sort((a, b) => b.hookScore - a.hookScore)
            .slice(0, 8)
            .sort((a, b) => a._idx - b._idx);
        }

        // Step 3: build prompt with stable beat IDs (array index)
        const _hv2Lines = _hv2Top
          .map(({ _idx }) => {
            const b = beats[_idx];
            return `Beat #${_idx} (${Math.round(b.startSec || 0)}s–${Math.round(b.endSec || 0)}s): ${String(b.narration || b.reason || "").trim().slice(0, 120)}`;
          })
          .join("\n");

        const _hv2Prompt =
`You write YouTube movie recap hooks (max 60 words, ~20s narration time).

Selected story beats:
${_hv2Lines}

RULES:
• Use ONLY the beats above. Never invent events not present here.
• Never reveal the ending, killer identity, final twist, or who survives.
• Immediately grab attention. Short sentences. High tension. Present tense.
• Create curiosity and an unanswered question.
• End with one transition line like "Let's go back to the beginning."

Return JSON only, no markdown:
{"hookText":"...","sourceBeatIds":[beatId1,beatId2,...]}

sourceBeatIds must be the Beat # numbers from the beats you actually referenced.`;

        let _hv2Raw = null;
        if (SERVER_ANTHROPIC_KEY) {
          const _hv2Resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json",
              "x-api-key": SERVER_ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: SERVER_ANTHROPIC_MODEL || "claude-haiku-4-5", max_tokens: 300,
              messages: [{ role: "user", content: _hv2Prompt }] }),
            signal: AbortSignal.timeout(25_000),
          });
          const _hv2Data = await _hv2Resp.json();
          _hv2Raw = _hv2Data?.content?.[0]?.text?.trim() || null;
        } else {
          const _hv2Resp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVER_OPENAI_KEY}` },
            body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 300,
              messages: [{ role: "user", content: _hv2Prompt }] }),
            signal: AbortSignal.timeout(25_000),
          });
          const _hv2Data = await _hv2Resp.json();
          _hv2Raw = _hv2Data?.choices?.[0]?.message?.content?.trim() || null;
        }

        if (_hv2Raw) {
          let _hv2Json = null;
          try {
            const _hv2Match = _hv2Raw.match(/\{[\s\S]*\}/);
            if (_hv2Match) _hv2Json = JSON.parse(_hv2Match[0]);
          } catch {}
          if (_hv2Json?.hookText) {
            _hookText = String(_hv2Json.hookText).trim();
            // Validate returned beat IDs against actual beats array bounds
            const _rawIds = Array.isArray(_hv2Json.sourceBeatIds)
              ? _hv2Json.sourceBeatIds.map(Number).filter(n => Number.isFinite(n) && n >= 0 && n < beats.length)
              : [];
            _hookV2BeatIds = _rawIds.length > 0 ? _rawIds : _hv2Top.map(x => x._idx);
            console.log(`[render ${jobId}] HOOK-V2: "${_hookText.slice(0, 70)}..." sourceBeatIds=[${_hookV2BeatIds.join(",")}]`);
          }
        }
      } catch (hv2GenErr) {
        console.warn(`[render ${jobId}] HOOK-V2 generation skipped (non-fatal):`, hv2GenErr?.message || hv2GenErr);
      }
    }
    // ── END HOOK V2 GENERATION ─────────────────────────────────────────────

    console.log(`[render ${jobId}] SYNC: beats=${beats.length}, voiceFiles=${voiceoverFileIds.length}`);

    // ── PER-BEAT TTS — Segment-Based Audio (Architecture v3) ─────────────────
    // When voice file count ≠ beat count the server cannot know which seconds
    // of audio belong to which beat.  Fix: generate one TTS clip per beat from
    // beats[i].narration.  Then voDurs[i] = exact clip duration → video clip[i]
    // is set to that exact duration → narration and footage are frame-accurate.
    //
    // Only activates when:
    //   • voice file count ≠ beat count (the mismatch scenario)
    //   • beats have substantial narration (avg ≥15 words — not just labels)
    //   • SERVER_OPENAI_KEY is configured
    // Falls back to original voice files + even distribution on any failure.
    {
      const _avgWords = beats.length > 0
        ? beats.reduce(
            (s, b) => s + (b.narration || b.reason || "").trim().split(/\s+/).filter(Boolean).length, 0
          ) / beats.length
        : 0;
      console.log(`[render ${jobId}] PER-BEAT TTS gate: avgWords=${_avgWords.toFixed(1)}, voiceFiles=${voiceoverFileIds.length}, beats=${beats.length}, keySet=${!!(SERVER_SPEECHIFY_KEY || SERVER_OPENAI_KEY)}`);
      if (
        voiceoverFileIds.length !== beats.length &&
        beats.length > 0 &&
        _avgWords >= 3 &&
        (SERVER_SPEECHIFY_KEY || SERVER_OPENAI_KEY || SERVER_ELEVENLABS_KEY || SERVER_HUME_KEY)
      ) {
        // Resolve TTS provider + API key.
        // Priority: settings.ttsProvider → auto-detect from available server keys.
        const _ttsProvider = String(settings?.ttsProvider || (() => {
          if (SERVER_SPEECHIFY_KEY)  return "speechify";
          if (SERVER_ELEVENLABS_KEY) return "elevenlabs";
          if (SERVER_HUME_KEY)       return "hume";
          if (SERVER_OPENAI_KEY)     return "openai";
          return "speechify";
        })()).toLowerCase();
        const _ttsApiKey = (() => {
          switch (_ttsProvider) {
            case "elevenlabs": return SERVER_ELEVENLABS_KEY;
            case "openai":     return SERVER_OPENAI_KEY;
            case "hume":       return SERVER_HUME_KEY;
            default:           return SERVER_SPEECHIFY_KEY || SERVER_OPENAI_KEY;
          }
        })();
        const _ttsVoice = (settings && settings.ttsVoice) || (
          _ttsProvider === "elevenlabs" ? (SERVER_ELEVENLABS_VOICE || "JBFqnCBsd6RMkjVDRZzb") :
          _ttsProvider === "hume"       ? (SERVER_HUME_VOICE || "Kora") :
          _ttsProvider === "openai"     ? "onyx" :
          SERVER_SPEECHIFY_VOICE
        );
        const _ttsSpeed = (settings && settings.ttsSpeed) || 1.0;
        console.log(
          `[render ${jobId}] PER-BEAT TTS: generating ${beats.length} clips ` +
          `(provider=${_ttsProvider} voice=${_ttsVoice} speed=${_ttsSpeed} avgNarrWords=${_avgWords.toFixed(1)})`
        );
        await jobStore.update(jobId, {
          progress: 18,
          message: `Generating ${beats.length} per-beat narration clips (${_ttsProvider} sync mode)…`,
        });
        // Parse app voice settings and map to server numeric params
        const _vsRaw = (typeof settings?.voiceSettings === 'object' && settings.voiceSettings) ? settings.voiceSettings : {};
        const _vsSpeedLabel = String(_vsRaw.speed || '');
        const _vsSpeedNum = (() => { const m = _vsSpeedLabel.match(/([0-9.]+)/); return m ? Math.min(1.2, Math.max(0.7, parseFloat(m[1]))) : null; })();
        const _vsStyleLabel = String(_vsRaw.style || '').toLowerCase();
        const _vsStyleMap = { energetic: 0.5, dramatic: 0.7, calm: 0.15, mysterious: 0.35, comedic: 0.4 };
        const _vsStyleNum = _vsStyleMap[_vsStyleLabel] ?? 0.30;
        const _voiceSettings = {
          stability: typeof _vsRaw.stability === 'number' ? _vsRaw.stability : undefined,
          similarity: typeof _vsRaw.similarity === 'number' ? _vsRaw.similarity : undefined,
          styleNum: _vsStyleNum,
          speedNum: _vsSpeedNum,
        };
        const _ttsRes = await generatePerBeatTTS(jobId, beats, _ttsApiKey, {
            ttsProvider: _ttsProvider,
            ttsVoice: _ttsVoice,
            ttsSpeed: _ttsSpeed,
            voiceSettings: _voiceSettings,
            onProgress: async (done, total) => {
              const pct = Math.round(18 + (done / total) * 24); // 18→42% range
              await jobStore.update(jobId, {
                progress: pct,
                message: `Voicing scene ${done}/${total}…`,
              });
            },
          });
          voiceoverFileIds = _ttsRes.map((r) => r.id);
          _perBeatTtsDurations = _ttsRes.map((r) => r.duration);
          const _ttsTotal = _ttsRes.reduce((s, r) => s + r.duration, 0);
          const _silenced = _ttsRes.filter((r) => r._silence || r._skip).length;
          console.log(
            `[render ${jobId}] PER-BEAT TTS: ${beats.length} clips ready, ` +
            `total=${_ttsTotal.toFixed(1)}s` +
            (_silenced > 0
              ? ` (${_silenced}/${beats.length} silence-padded — voiced beats are frame-accurate)`
              : " — all beats voiced, frame-accurate sync")
          );
      }
    }
    // ── END PER-BEAT TTS ──────────────────────────────────────────────────────

    // Hoisted outside try block so the mux gap-fill loop (below) can reference them.
    let srcDur = 0;
    let safeCeiling = 0;

    try {
      const voDurs = await Promise.all(
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
        const beatTexts = beats.map((b) => (typeof b.narration === "string" ? b.narration : ""));

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

