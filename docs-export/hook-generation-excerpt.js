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
