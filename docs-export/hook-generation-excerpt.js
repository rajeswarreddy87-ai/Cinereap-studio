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
