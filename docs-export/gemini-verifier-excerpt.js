

const PROTECTED_SCENE_RE = /funeral|cemetery|grave|burial|mourn|casket|headstone|dies|death|killed|murder|shoots|shot|blood|betray|twist|climax|final round|knockout|hospital|crash/i;
function isProtectedBeatForVisual(b) {
  const t = `${b?.narration || ""} ${b?.reason || ""}`;
  return PROTECTED_SCENE_RE.test(t);
}
function _tokSet(s) {
  return new Set(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2));
}
function _jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function findTranscriptCandidateForBeat(narration, transcriptSegments, sourceDurationSec = 0) {
  if (!Array.isArray(transcriptSegments) || transcriptSegments.length === 0) return null;
  const q = _tokSet(narration);
  if (!q.size) return null;
  let best = null;
  for (let i = 0; i < transcriptSegments.length; i++) {
    const st = Number(transcriptSegments[i].start ?? transcriptSegments[i].startSec ?? 0);
    let end = st;
    let text = "";
    for (let j = i; j < transcriptSegments.length; j++) {
      const sj = transcriptSegments[j];
      const sjEnd = Number(sj.end ?? sj.endSec ?? st);
      if (sjEnd - st > 18) break;
      text += " " + String(sj.text || "");
      end = Math.max(end, sjEnd);
    }
    const score = _jaccard(q, _tokSet(text));
    if (!best || score > best.score) best = { startSec: st, endSec: Math.max(end, st + 6), score, label: "whisper" };
  }
  if (!best || best.score < 0.09) return null;
  const dur = Math.min(14, Math.max(6, best.endSec - best.startSec + 4));
  const mid = (best.startSec + best.endSec) / 2;
  return {
    label: "whisper",
    startSec: Math.max(0, mid - dur / 2),
    endSec: sourceDurationSec > 0 ? Math.min(sourceDurationSec, mid + dur / 2) : mid + dur / 2,
    score: best.score,
  };
}
function _dedupeCandidates(cands) {
  const out = [];
  for (const c of cands) {
    if (!c || !(Number(c.endSec) > Number(c.startSec) + 0.5)) continue;
    const mid = (Number(c.startSec) + Number(c.endSec)) / 2;
    if (out.some(o => Math.abs(((o.startSec + o.endSec) / 2) - mid) < 2.0)) continue;
    out.push({ ...c, startSec: Number(c.startSec), endSec: Number(c.endSec) });
  }
  return out.slice(0, 5);
}
async function _extractVerifierClip(sourcePath, cand, outPath) {
  const mid = (Number(cand.startSec) + Number(cand.endSec)) / 2;
  const len = Math.min(8, Math.max(4, Number(cand.endSec) - Number(cand.startSec)));
  const startSec = Math.max(0, mid - len / 2);
  const endSec = startSec + len;
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
      parts.push({ inlineData: { mimeType: "video/mp4", data: cp.data } });
    }
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${SERVER_GEMINI_MODEL}:generateContent?key=${encodeURIComponent(SERVER_GEMINI_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0, maxOutputTokens: 120 } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      console.warn(`[render ${jobId}] GEMINI beat ${beatIndex}: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const txt = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
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
    version: "2.7.4",
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
