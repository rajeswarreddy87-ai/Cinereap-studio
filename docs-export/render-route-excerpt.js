      // Stored as result.hookText — the render step prepends it automatically to
      // every video so viewers see a dramatic tease before the story begins.
      // Uses Claude (best quality); falls back to OpenAI if no Anthropic key.
      let _hookText = null;
      let _hookSceneIds = null; // hoisted so result storage below can always reference it
      const _hookBeats = Array.isArray(parsed.beats) ? parsed.beats : [];
      if (_hookBeats.length >= 5 && (claudeApiKey || openaiApiKey)) {
        try {
          const _beatLines = _hookBeats
            .slice(0, 25)
            .map((b, i) => `${i + 1}. ${String(b.narration || b.reason || "").trim().slice(0, 110)}`)
            .join("\n");
          // Build a sceneIds reference for the hook: top-5 highest-importance beats.
          const _hookTopSceneIds = _hookBeats
            .slice()
            .sort((a, b) => (+(b.importance || 0)) - (+(a.importance || 0)))
            .slice(0, 5)
            .flatMap((b) => Array.isArray(b.sceneIds) ? b.sceneIds : [b.index])
            .filter((v, i, arr) => Number.isFinite(v) && arr.indexOf(v) === i)
            .sort((a, b) => a - b);

          const _hookPrompt =
`You write 50-80 word YouTube movie recap hooks (20-30 s narration time).

Story beats:
${_beatLines}

RULES — follow ALL:
• Immediately grab attention. Short sentences. Fast pacing. Present tense. High tension.
• Create curiosity, tension, and an unanswered question.
• Do NOT reveal the ending, killer identity, final twist, resolution, or who survives.
• Do NOT open with a character name, ordinary daily life, or slow exposition.
• End with exactly one transition line such as "Let's go back to the beginning." or "To understand how this happened, let's start from the beginning."

STRUCTURE: (1) shocking situation → (2) heighten danger/mystery → (3) unanswered question → (4) transition.

ALSO choose hookSceneIds: an array of 3-6 scene indices (from the beat list above) whose
footage best visually represents the hook narration. Pick from the most dramatic / high-action
scenes. These will be used as the visual backdrop for the hook segment.

Respond with valid JSON ONLY:
{ "hookText": "<50-80 word hook>", "hookSceneIds": [<scene indices>] }
No prose, no markdown, no other keys.`;

          let _hookRaw = null;
          if (claudeApiKey) {
            const _hr = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: { "Content-Type": "application/json",
                "x-api-key": claudeApiKey, "anthropic-version": "2023-06-01" },
              body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 300,
                messages: [{ role: "user", content: _hookPrompt }] }),
              signal: AbortSignal.timeout(25_000),
            });
            const _hd = await _hr.json();
            _hookRaw = _hd?.content?.[0]?.text?.trim() || null;
          } else {
            const _hr = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiApiKey}` },
              body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 300,
                messages: [{ role: "user", content: _hookPrompt }] }),
              signal: AbortSignal.timeout(25_000),
            });
            const _hd = await _hr.json();
            _hookRaw = _hd?.choices?.[0]?.message?.content?.trim() || null;
          }
          // Parse JSON response — fall back to treating raw content as plain hookText.
          _hookSceneIds = _hookTopSceneIds;
          if (_hookRaw) {
            try {
              const _fence = _hookRaw.match(/```(?:json)?\s*([\s\S]+?)```/);
              const _src = _fence ? _fence[1].trim() : _hookRaw;
              const _hj = JSON.parse(_src);
              if (typeof _hj?.hookText === "string" && _hj.hookText.trim()) {
                _hookText = _hj.hookText.trim();
                if (Array.isArray(_hj.hookSceneIds) && _hj.hookSceneIds.length > 0) {
                  // GPT is shown beats as "${i+1}. narration" (1-based positions).
