          const sur = +(b.surpriseScore || imp);
          const start = Number(b.startSec) || 0;
          const txt = String(b.narration || b.reason || "").toLowerCase();
          if (start < _hookIntroFloor) return { _idx: i, hookScore: -1, startSec: start };
          let keywordBoost = 0;
          if (/shot|blood|dies|death|killer|murder|gun|funeral|grave|hospital|crash|betray|revenge|loses|taken|custody/i.test(txt)) keywordBoost += 8;
          if (/fight|brawl|knockout|champion|final round|low blow|uppercut|escobar|climax/i.test(txt)) keywordBoost += 5;
          if (/wife|daughter|maureen|leila|leyla|cry|grief|love|family/i.test(txt)) keywordBoost += 4;
          if (/deal|contract|manager|business|pool|speech|press conference|paperwork/i.test(txt)) keywordBoost -= 5;
          return { _idx: i, hookScore: imp * 0.50 + emo * 0.25 + sur * 0.25 + keywordBoost, startSec: start };
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
`You write a high-retention YouTube movie recap hook (55-75 words, ~22-30s narration time).

Selected high-impact story beats:
${_hv2Lines}

HOOK GOAL:
Create a shocking, emotional, action-driven opening that makes viewers NEED to know what happened next.

RULES — follow ALL:
• Use ONLY the beats above. Never invent events not present here.
• Prioritize SURPRISE, SHOCK, EMOTION, DANGER, REVENGE, FAMILY LOSS, BETRAYAL, or ACTION.
• Start with the most dramatic situation, not ordinary setup or business context.
• Short sentences. Present tense. Fast pacing. No generic phrases like "this movie" or "our hero".
• Do NOT reveal the final ending, final winner, final twist, or resolution.
• Create an unanswered question by the final third of the hook.
• End with exactly one transition line: "To understand how it got this far, we have to go back to the beginning."
• Pick sourceBeatIds ONLY from beats whose footage directly supports the hook visuals.
• The visual hook should include 3-6 short clips covering the shock/action/emotion you mention.

Return JSON only, no markdown:
{"hookText":"...","sourceBeatIds":[beatId1,beatId2,...]}

sourceBeatIds must be the Beat # numbers from the beats you actually referenced.`;

        let _hv2Raw = null;
        if (SERVER_ANTHROPIC_KEY) {
          const _hv2Resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json",
              "x-api-key": SERVER_ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: SERVER_ANTHROPIC_MODEL || "claude-opus-4-5", max_tokens: 700,
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
