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
