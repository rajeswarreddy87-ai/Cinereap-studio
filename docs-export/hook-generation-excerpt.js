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
