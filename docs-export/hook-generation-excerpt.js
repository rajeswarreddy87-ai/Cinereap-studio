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
    _preTrimBeats = beats.slice();
