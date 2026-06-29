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
        const _isProtectedBeat = isProtectedBeatForVisual;
        const protectedBeats = original.filter(_isProtectedBeat);
        const kept = Array.from({ length: BEATS_TARGET }, (_, b) => {
          const start  = Math.floor(b * bucketSize);
          const end    = Math.min(Math.ceil((b + 1) * bucketSize), original.length);
          const bucket = original.slice(start, end);
          if (bucket.length === 0) return null;
          const best = bucket.reduce((top, beat) =>
            +(beat.importance || 0) >= +(top.importance || 0) ? beat : top
          );
          if (seenRefs.has(best)) return null;
          seenRefs.add(best);
          return best;
        }).filter(Boolean);
        for (const pb of protectedBeats) {
          if (!kept.includes(pb) && kept.length < BEATS_TARGET + 8) {
            kept.push(pb);
            console.log(`[render ${jobId}] BEAT-TRIM: protected key scene kept (${String(pb.narration||"").slice(0,40)}…)`);
          }
        }
        kept.sort((a, b) => Number(a.startSec) - Number(b.startSec));

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
        const _hookIntroFloor = 120; // match body intro-skip — never hook with credits/logos
        const _hv2Scored = beats.map((b, i) => {
          const imp = +(b.importance    || 0);
          const emo = +(b.emotionScore  || imp);
          const sur = +(b.surpriseScore || imp);
          const start = Number(b.startSec) || 0;
          if (start < _hookIntroFloor) return { _idx: i, hookScore: -1, startSec: start };
          return { _idx: i, hookScore: imp * 0.60 + emo * 0.30 + sur * 0.10, startSec: start };
        }).filter((x) => x.hookScore >= 0);

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
      const _needsPerBeatTts = beats.length > 0 && (
        voiceoverFileIds.length === 0 ||
        voiceoverFileIds.length === 1 ||
        voiceoverFileIds.length !== beats.length
      );
      if (
        _needsPerBeatTts &&
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
        const _ttsSpeed = (settings && settings.ttsSpeed) || Number(process.env.TTS_SPEED || 0.95);
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
          maxClipSec: COPYRIGHT_SAFE_MODE ? Number(process.env.COPYRIGHT_SAFE_MAX_CLIP_SEC || 3.0) : undefined,
          // ChatGPT pipeline: pass per-beat importance scores so buildSyncedTimeline
          // applies dynamic cut timing (2.5s for transitional, 5.0s for climax).
          beatImportances: Array.isArray(beats) ? beats.map((b) => b.importance ?? null) : undefined,
          beatTypes: Array.isArray(beats) ? beats.map((b) => b.beatType ?? null) : undefined,
        });
        if (Array.isArray(plan.timeline) && plan.timeline.length > 0) {
          console.log(`[render ${jobId}] SYNC: plan.timeline=${plan.timeline.length}, beatDurations=${plan.beatDurations.map(d => d.toFixed(2)).join(',')}`);
          // Sanitize synced timeline: drop zero-duration or invalid segments.
          timestamps = plan.timeline.filter(
            (t) => Number.isFinite(t.startSec) && Number.isFinite(t.endSec) && t.endSec - t.startSec >= 0.1
          );
          syncBeatDurations = plan.beatDurations;
          syncMoods = beats.map((b) => b.mood || "dramatic");
          syncMode = true;
          await jobStore.update(jobId, {
            message: `Synced timeline: ${plan.timeline.length} clips paced to ${voiceTotalPre.toFixed(0)}s narration (no looping)`,
          });
          console.log(`[render ${jobId}] SYNC MODE on: ${plan.timeline.length} segs, voice=${voiceTotalPre.toFixed(1)}s`);
        }
      }
