
/* ---------- Gemini beat-verifier helpers --------------------------------- */
async function _extractVerifierClip(sourcePath, { startSec, endSec }, outPath) {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", startSec.toFixed(3), "-i", sourcePath,
      "-t", (endSec - startSec).toFixed(3),
      "-vf", "scale=480:-2,fps=6", "-an",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      outPath,
    ], { stdio: "ignore" });
    const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} resolve(false); }, 45_000);
    ff.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
    ff.on("error", () => { clearTimeout(t); resolve(false); });
  });
}
async function verifyBeatCandidatesWithGemini({ jobId, beatIndex, narration, sourcePath, candidates }) {
  if (!SERVER_GEMINI_KEY || !Array.isArray(candidates) || candidates.length < 2) return null;
  const clipParts = [];
  const tmpPaths = [];
  try {
    for (let i = 0; i < candidates.length; i++) {
      const tmp = path.join(UPLOADS_DIR, `gemini-cand-${jobId}-${String(beatIndex).padStart(3,"0")}-${i}.mp4`);
      tmpPaths.push(tmp);
      const ok = await _extractVerifierClip(sourcePath, candidates[i], tmp);
      if (!ok) continue;
      const data = await fs.readFile(tmp, { encoding: "base64" });
      clipParts.push({ idx: i + 1, label: candidates[i].label || `candidate-${i+1}`, data });
    }
    if (clipParts.length < 2) return null;
    const prompt = `You are verifying movie recap synchronization. Narration beat:\n"${String(narration).slice(0,900)}"\n\nYou will see ${clipParts.length} candidate video clips in order. Pick the ONE clip whose visible action best matches the narration. Return ONLY JSON: {"best":1,"confidence":0.0,"reason":"short"}. If none match, choose the least bad and set confidence below 0.45.`;
    const parts = [{ text: prompt }];
    for (const cp of clipParts) {
      parts.push({ text: `Candidate ${cp.idx} (${cp.label})` });
      parts.push({ inline_data: { mime_type: "video/mp4", data: cp.data } });
    }
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${SERVER_GEMINI_MODEL}:generateContent?key=${encodeURIComponent(SERVER_GEMINI_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 512,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) { console.warn(`[render ${jobId}] GEMINI beat ${beatIndex}: HTTP ${resp.status}`); return null; }
    const data = await resp.json();
    const txt = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) { console.warn(`[render ${jobId}] GEMINI beat ${beatIndex}: no JSON in response: ${txt.slice(0, 120)}`); return null; }
    const parsed = JSON.parse(m[0]);
    const best = Number(parsed.best) - 1;
    const conf = Number(parsed.confidence) || 0;
    if (best < 0 || best >= candidates.length) return null;
    return { index: best, confidence: conf, reason: String(parsed.reason || "").slice(0, 160) };
  } catch (e) {
    console.warn(`[render ${jobId}] GEMINI beat ${beatIndex} failed:`, e?.message || e);
    return null;
  } finally {
    for (const p of tmpPaths) { try { await fs.unlink(p); } catch {} }
  }
}

/* ---------- routes ---------- */
app.get("/health", (_req, res) => {
  // Build TTS provider list so the app can show only available options.
  const ttsProviderList = [
    { id: "speechify",  label: "Speechify",  available: Boolean(SERVER_SPEECHIFY_KEY),  defaultVoice: SERVER_SPEECHIFY_VOICE  || "dominic" },
    { id: "openai",     label: "OpenAI TTS", available: Boolean(SERVER_OPENAI_KEY),      defaultVoice: "onyx" },
    { id: "elevenlabs", label: "ElevenLabs", available: Boolean(SERVER_ELEVENLABS_KEY),  defaultVoice: SERVER_ELEVENLABS_VOICE || "JBFqnCBsd6RMkjVDRZzb" },
    { id: "hume",       label: "Hume AI",    available: Boolean(SERVER_HUME_KEY),         defaultVoice: SERVER_HUME_VOICE       || "Kora" },
  ];
  const defaultTtsProvider = ttsProviderList.find(p => p.available)?.id || "speechify";

  res.json({
    ok: true,
    version: "2.8.7",
    serverTranscription: Boolean(SERVER_OPENAI_KEY),
    serverAnalysis: Boolean(SERVER_ANTHROPIC_KEY),
    serverModel: SERVER_ANTHROPIC_MODEL || null,
    geminiVerifier: Boolean(SERVER_GEMINI_KEY),
    geminiModel: SERVER_GEMINI_KEY ? SERVER_GEMINI_MODEL : null,
    youtubeConfigured: Boolean(process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET),
    ttsProviders: ttsProviderList,
    defaultTtsProvider,
    features: [
      "ingest-url",
      "ingest-upload",
      "analyze",
      "render",
      "youtube",
      "cookies-upload",
      "voiceover-chunks",   // new in 1.5.0 — voiceoverFileIds[]
      "music-mix",          // new in 1.5.0 — musicFileId
      "subtitle-burn",      // new in 1.5.0 — subtitlesSrt
      "transcribe",         // new in 1.6.0 — whisper-1 transcript + segment timestamps
      "analyze-transcript", // new in 1.6.0 — /analyze accepts transcript grounding
      "scene-detection",    // new in 2.0.0 — hybrid scene-based key frames + single story
      "music-moods",        // new in 2.0.0 — built-in mood beds via musicMood + GET /music/:mood
      "video-align",        // new in 2.0.0 — visuals looped to cover full voiceover
      "music-ducking",      // new in 2.0.0 — sidechain duck under narration
      "server-transcription", // new in 2.3.0 — server-side OpenAI key, always-on whisper
      "auto-music",         // new in 2.3.0 — scene-adaptive music, no manual mood pick
      "poster",             // new in 2.4.0 — render generates a thumbnail JPG
      "youtube-oauth",      // new in 2.4.0 — browser OAuth connect + upload
      "claude-models",      // new in 2.5.0 — GET /claude-models proxies Anthropic model list
      "ai-thumbnails",      // new in 2.6.0 — DALL-E thumbnail generation via server key
      "translate-transcript", // new in 2.5.0 — Whisper translation endpoint for non-English films
      "uncapped-narration", // new in 2.5.0 — full-length narration, no word-count ceiling
      "clip-select",        // new in 2.6.0 — CLIP semantic frame matching for clip selection
      "gemini-verify",      // new in 2.7.4 — Gemini Flash verifies top candidate clips when GEMINI_API_KEY is set
      "multi-tts",          // new in 2.7.0 — ttsProvider field selects speechify|openai|elevenlabs|hume
      "storage-api",        // new in 2.7.0 — GET /system/storage, DELETE /system/clear-renders
      "source-download",    // new in 2.7.0 — GET /uploads/:fileId/download
    ],
  });
});

/* ---------- /claude-models: proxy Anthropic model list with caller's key ---------- */
// Returns the same shape as GET https://api.anthropic.com/v1/models so the app
// can show a model picker without the user copy-pasting model IDs.
app.get("/claude-models", requireAuth, async (req, res) => {
  const apiKey = req.headers["x-anthropic-key"] || req.query.anthropicApiKey;
  if (!apiKey) return res.status(400).json({ error: "Pass your Anthropic key via X-Anthropic-Key header or anthropicApiKey query param" });
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    const body = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(body);
    // Annotate each model with its max output tokens so the app can display
    // useful info (e.g. "Opus 4 — 32k output tokens").
    const { getModelMaxOutputTokens } = await import("./analyze.js");
    const models = (body.data || []).map((m) => ({
      ...m,
      maxOutputTokens: getModelMaxOutputTokens(m.id),
    }));
    res.json({ models, total: models.length });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* ---------- /v1/images/generations: proxy DALL-E calls through server key ---------- */
// Allows the app to generate thumbnails even without an on-device OpenAI key.
// Mirrors the /transcribe pattern: uses caller key if provided, falls back to server key.
app.post("/v1/images/generations", requireAuth, async (req, res) => {
  let openaiApiKey = (req.body || {}).openaiApiKey || req.headers["authorization"]?.replace("Bearer ", "").trim();
  if (!openaiApiKey && SERVER_OPENAI_KEY) openaiApiKey = SERVER_OPENAI_KEY;
  if (!openaiApiKey) return res.status(400).json({ error: "openaiApiKey required (no server key configured)" });
  // Strip our custom fields before forwarding
  const { openaiApiKey: _k, ...forwardBody } = req.body || {};
  try {
    const upstream = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiApiKey}` },
      body: JSON.stringify(forwardBody),
    });
    const body = await upstream.json();
    res.status(upstream.status).json(body);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* ---------- helpers for AI thumbnail storage ----------------------------- */
const AI_THUMB_STYLES = ["dramatic", "bold", "cinematic"];
function aiThumbPath(jobId, style) {
  return path.join(OUTPUT_DIR, `thumb-${jobId}-${style}.jpg`);
}

// Extract a frame from a video at `timeSec` and apply a style-specific
// cinematic colour grade.  Returns destPath on success, throws on failure.
// styles: "dramatic" | "bold" | "cinematic"
const FRAME_FILTERS = {
  // Real-movie-frame thumbnails, channel style: close/cropped, sharp face, punchy contrast.
  dramatic:  "crop=iw*0.82:ih*0.82:(iw-iw*0.82)/2:(ih-ih*0.82)/2,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=contrast=1.65:brightness=-0.04:saturation=1.22:gamma=0.98,unsharp=7:7:1.4:5:5:0.5,vignette=PI/4,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.40:t=8",
