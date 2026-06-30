/**
 * CineRecap Render Server.
 *
 * Endpoints:
 *   GET  /health                              public, returns { ok: true, version }
 *   POST /upload?role=clip|voiceover          auth, multipart, returns { fileId, url }
 *   POST /render                              auth, JSON body, returns { jobId }
 *   GET  /jobs/:jobId                         auth, returns job status
 *   GET  /jobs/:jobId/download                auth, streams the final MP4
 *   POST /jobs/:jobId/youtube                 auth, uploads the rendered MP4 to YouTube
 *
 * All auth uses a static Bearer token from AUTH_TOKEN env. Set a long random
 * value (`openssl rand -hex 32`) and share it once with the phone via Settings.
 */
import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

import { buildConcatManifest, buildRenderArgs, buildTrimArgs, normaliseRenderSettings } from "./ffmpeg-args.js";
import { JobStore } from "./jobs.js";
import { uploadToYouTube } from "./youtube.js";
import { google } from "googleapis";
import { ingestFromUrl } from "./ingest-worker.js";
import { buildAnalyzeMessages, callClaude, callClaudeWithFrameBatching, extractFrames, enforceMaxClipDurationServer, frameToBase64, parseAnalysisResponse, probeDurationSec, analyzeWithScenes } from "./analyze.js";
import { analyzeScenes, SCENE_THRESHOLD } from "./scenes.js";
import { promises as fsp } from "node:fs";
import { transcribeMovie, buildTranscriptBlock } from "./transcribe.js";
import { planSyncedRender, buildSyncedTimeline } from "./beats.js";
import { planMusicTimeline, dominantMood } from "./music.js";

const PORT = Number(process.env.PORT || 8787);
const STORAGE_DIR = process.env.STORAGE_DIR || "/data";
const UPLOADS_DIR = path.join(STORAGE_DIR, "uploads");
const OUTPUT_DIR = path.join(STORAGE_DIR, "output");
const JOBS_DIR = path.join(STORAGE_DIR, "jobs");
const COOKIES_DIR = path.join(STORAGE_DIR, "cookies");
const MUSIC_DIR = path.join(STORAGE_DIR, "music");
const CHUNKS_DIR = path.join(STORAGE_DIR, "chunks"); // resumable movie upload staging
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
// Server-side OpenAI key for whisper-1 transcription. When set, transcription
// runs automatically for every analyze job even if the app sends no key, so
// the recap is always grounded in real dialogue (true sync) without the user
// ever pasting a key in the app.
const SERVER_OPENAI_KEY    = process.env.OPENAI_API_KEY     || "";
const SERVER_SPEECHIFY_KEY   = process.env.SPEECHIFY_API_KEY  || "";
const SERVER_SPEECHIFY_VOICE = process.env.SPEECHIFY_VOICE_ID || "dominic"; // Dominic — EN narrator

// ElevenLabs TTS — optional second provider. Set ELEVENLABS_API_KEY to enable.
// Default voice: George (JBFqnCBsd6RMkjVDRZzb) — deep English narrator.
const SERVER_ELEVENLABS_KEY   = process.env.ELEVENLABS_API_KEY  || "";
// ElevenLabs voice IDs are case-sensitive on their API. The known-good ID for
// "Jofra – Expressive & Neutral Narrator" is mixed-case. Normalise the env var
// so an all-caps copy-paste never causes silent 404s on every TTS request.
const _rawElVoice = (process.env.ELEVENLABS_VOICE_ID || "NuRyEq0OdD9mMOyd51UZ").trim();
const SERVER_ELEVENLABS_VOICE = _rawElVoice.toUpperCase() === "NURYEQ0ODD9MMOYD51UZ"
  ? "NuRyEq0OdD9mMOyd51UZ"
  : _rawElVoice;

// Hume AI TTS — optional third provider. Set HUME_API_KEY to enable.
const SERVER_HUME_KEY   = process.env.HUME_API_KEY   || "";
const SERVER_HUME_VOICE = process.env.HUME_VOICE_NAME || "Kora";

// Server-side Anthropic key + model override.
// When ANTHROPIC_API_KEY is set the server uses it instead of whatever key
// the app sends, so the user never needs to paste a key in app settings.
// When ANTHROPIC_MODEL is set it overrides whatever model the app chose,
// letting you pin the quality to e.g. claude-opus-4-5 from one place.
const SERVER_ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY   || "";
const SERVER_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL      || "";

const CLIP_SIDECAR_URL = process.env.CLIP_SIDECAR_URL || "http://localhost:8788";
const SERVER_GEMINI_KEY   = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const SERVER_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!AUTH_TOKEN) {
  console.warn("[WARN] AUTH_TOKEN is empty — server is wide open. Set it in .env before exposing publicly.");
}

await fs.mkdir(UPLOADS_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });
await fs.mkdir(COOKIES_DIR, { recursive: true });
await fs.mkdir(MUSIC_DIR, { recursive: true });
await fs.mkdir(CHUNKS_DIR, { recursive: true });
// Self-heal: if the mood music beds are missing (fresh volume), generate them
// once at startup using the bundled gen_music.sh. Non-fatal on failure.
try {
  const beds = (await fs.readdir(MUSIC_DIR)).filter((f) => f.endsWith(".mp3"));
  if (beds.length < 8) {
    console.log(`[music] ${beds.length}/8 mood beds present — generating...`);
    await new Promise((resolve) => {
      const g = spawn("sh", ["/app/gen_music.sh"], { stdio: "ignore" });
      g.on("close", () => resolve());
      g.on("error", () => resolve());
    });
    const after = (await fs.readdir(MUSIC_DIR)).filter((f) => f.endsWith(".mp3"));
    console.log(`[music] now ${after.length} mood beds present`);
  }
} catch (e) {
  console.warn("[music] bed generation skipped:", e?.message || e);
}
const jobStore = new JobStore(JOBS_DIR);
await jobStore.init();

/* Reset any jobs that were left in "running" state by a previous container
   crash or restart — their ffmpeg/node processes are now dead. */
try {
  const allJobs = await jobStore.list();
  let zombieCount = 0;
  for (const job of allJobs) {
    if (job.status === "running") {
      await jobStore.update(job.id, {
        status: "failed",
        error: "Server restarted — render process was interrupted. Please retry.",
        message: "Interrupted by server restart",
      }).catch(() => {});
      zombieCount++;
    }
  }
  if (zombieCount > 0) console.log(`[startup] reset ${zombieCount} interrupted job(s) to failed`);
} catch (e) {
  console.warn("[startup] zombie job cleanup failed:", e?.message || e);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ---------- middleware ---------- */
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next(); // dev convenience when token is empty
  const header = req.get("authorization") || "";
  const headerToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  const queryToken = typeof req.query?.token === "string" ? req.query.token : "";
  const supplied = headerToken || queryToken;
  if (supplied !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 8 * 1024 * 1024 * 1024 }, // 8 GB — movie files can reach 2-4 GB
});

/**
 * Align a combined voiceover to per-beat durations using Whisper word-level
 * timestamps (req #3). When voice files ≠ beat count (even-distribution mode),
 * run Whisper on the concatenated voiceover and use the actual word timing to
 * compute precise per-beat durations — eliminating word-count estimation drift.
 *
 * @param {string[]} voiceFileIds  file IDs in UPLOADS_DIR (in order)
 * @param {string[]} beatTexts     per-beat narration text (same order as beats)
 * @param {string}   openaiKey     OpenAI API key
 * @param {string}   uploadsDir    path to the uploads directory
 * @returns {Promise<number[]|null>} per-beat durations in seconds, or null on failure
 */
async function alignBeatsByWhisperWords(voiceFileIds, beatTexts, openaiKey, uploadsDir) {
  if (!openaiKey || !Array.isArray(voiceFileIds) || voiceFileIds.length === 0) return null;
  if (!Array.isArray(beatTexts) || beatTexts.length === 0) return null;

  const tmpId = nanoid(8);
  const combinedPath = path.join(uploadsDir, `whisper-combined-${tmpId}.mp3`);
  const concatListPath = path.join(uploadsDir, `whisper-list-${tmpId}.txt`);
  try {
    // 1. Concatenate all voice files into one MP3 for a single Whisper call.
    if (voiceFileIds.length === 1) {
      await fs.copyFile(path.join(uploadsDir, voiceFileIds[0]), combinedPath);
    } else {
      const lines = voiceFileIds
        .map((id) => `file '${path.join(uploadsDir, id).replace(/'/g, "\\'")}'`)
        .join("\n");
      await fs.writeFile(concatListPath, lines + "\n");
      await new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", [
          "-y", "-hide_banner", "-loglevel", "error",
          "-f", "concat", "-safe", "0", "-i", concatListPath,
          "-c", "copy", combinedPath,
        ], { stdio: "ignore" });
        ff.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg concat exit ${c}`))));
        ff.on("error", reject);
      });
    }

    // 2. Call Whisper with word-level timestamps.
    const audioData = await fs.readFile(combinedPath);
    const form = new FormData();
    form.append("file", new Blob([audioData], { type: "audio/mpeg" }), "voiceover.mp3");
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}` },
      body: form,
    });
    if (!resp.ok) {
      console.warn(`[alignBeatsByWhisperWords] Whisper API error ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const words = Array.isArray(data.words) ? data.words : [];
    if (words.length === 0) {
      console.warn("[alignBeatsByWhisperWords] Whisper returned no word timestamps");
      return null;
    }

    // 3. Match each beat's narration text to its spoken word range in the timeline.
    // Strategy: count words per beat, advance a word cursor, use the first/last
    // word's start/end times as the beat's exact duration boundary.
    const beatDurations = [];
    let wordCursor = 0;
    for (let i = 0; i < beatTexts.length; i++) {
      const beatWordCount = (beatTexts[i] || "").trim().split(/\s+/).filter(Boolean).length;
      const startIdx = wordCursor;
      const endIdx = Math.min(wordCursor + beatWordCount - 1, words.length - 1);
      if (startIdx < words.length && words[startIdx] && words[endIdx]) {
        const dur = (words[endIdx].end ?? words[endIdx].start) - words[startIdx].start;
        beatDurations.push(Math.max(0.5, dur));
      } else {
        beatDurations.push(null); // mark as failed — caller falls back to even dist
      }
      // Advance by the ACTUAL word range consumed (endIdx + 1), not the expected
      // count. Using beatWordCount caused cursor drift when TTS elided contractions
      // ("they're" → 1 Whisper word instead of 2) — every subsequent beat got
      // wrong timestamps, producing 15-20% sync error on beats with contractions.
      wordCursor = endIdx + 1;
    }
    console.log(`[alignBeatsByWhisperWords] ${words.length} words → ${beatDurations.filter(Boolean).length}/${beatDurations.length} beats aligned`);
    return beatDurations;
  } catch (e) {
    console.warn("[alignBeatsByWhisperWords] failed:", e?.message || e);
    return null;
  } finally {
    try { await fs.unlink(combinedPath); } catch {}
    try { await fs.unlink(concatListPath); } catch {}
  }
}

/**
 * callClipSidecar — POST to the CLIP Python sidecar with a hard timeout.
 * Returns the parsed JSON body on success, or null on any failure (network
 * error, timeout, model not ready, etc.). Callers always fall back gracefully.
 *
 * @param {string} endpoint  e.g. "/embed-job", "/match"
 * @param {object} body      JSON payload
 * @param {number} [timeoutMs=15000]  hard abort timeout
 * @returns {Promise<object|null>}
 */
async function callClipSidecar(endpoint, body, timeoutMs = 15_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${CLIP_SIDECAR_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

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
    version: "2.8.6",
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
  bold:      "crop=iw*0.78:ih*0.78:(iw-iw*0.78)/2:(ih-ih*0.78)/2,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=contrast=1.85:brightness=0.04:saturation=1.85:gamma=0.95,unsharp=7:7:1.7:5:5:0.7,vibrance=intensity=0.55,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=10",
  cinematic: "crop=iw*0.88:ih*0.88:(iw-iw*0.88)/2:(ih-ih*0.88)/2,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,colorchannelmixer=rr=1.14:rb=-0.07:gr=-0.05:gg=0.94:bb=0.78:br=0.14,eq=contrast=1.50:saturation=1.18,unsharp=5:5:1.0,vignette=PI/5,drawbox=x=0:y=0:w=iw:h=ih:color=black@0.38:t=8",
};

// Find the timestamps of dramatic scene changes in a video using ffprobe.
// Returns an array of seconds (sorted), filtered to avoid the first/last 5%.
async function findSceneChangeTimestamps(videoPath, duration) {
  return new Promise((resolve) => {
    let stdout = "";
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "frame=pts_time:frame_tags=lavfi.scene_score",
      "-of", "csv",
      "-f", "lavfi",
      `movie=${videoPath.replace(/\\/g, "/")},select=gt(scene\\,0.28)`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.on("close", () => {
      const minT = duration * 0.05;
      const maxT = duration * 0.95;
      const timestamps = [];
      for (const line of stdout.split("\n")) {
        const parts = line.split(",");
        const pts = parseFloat(parts[2] || parts[1] || "");
        if (!isNaN(pts) && pts >= minT && pts <= maxT) timestamps.push(pts);
      }
      resolve(timestamps.sort((a, b) => a - b));
    });
    proc.on("error", () => resolve([]));
    setTimeout(() => { try { proc.kill(); } catch {} resolve([]); }, 12_000);
  });
}
async function extractStyledFrame(videoPath, timeSec, destPath, style = "dramatic") {
  const vf = FRAME_FILTERS[style] || FRAME_FILTERS.dramatic;
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-ss", String(Math.max(0, timeSec)),
      "-i", videoPath,
      "-vframes", "1",
      "-vf", vf,
      "-q:v", "2",
      destPath,
    ], { stdio: "ignore" });
    ff.on("close", (code) => code === 0 ? resolve(destPath) : reject(new Error(`ffmpeg frame extract exit ${code}`)));
    ff.on("error", reject);
  });
}
// Build an emotionally-driven story thumbnail prompt from beat context + style.
// buildThumbPrompt: generates viral, highly-clickable YouTube thumbnail prompts.
// Extracts character archetypes, setting, emotional peak, and the core story
// conflict from beat narration, then builds two distinct styles:
//   bold     → extreme close-up face emotion, red/amber, MrBeast-level stop-scroll energy
//   dramatic → cinematic wide / medium shot, Netflix/orange-teal grade, premium feel
function buildThumbPrompt(beatContext, style) {
  const ctx = (typeof beatContext === "string") ? beatContext.trim() : "";

  /* ── 1. CHARACTER DETECTION ─────────────────────────────────────────── */
  const isVeteran   = /veteran|marine|soldier|military|war|combat|tour of duty|served/i.test(ctx);
  const isRancher   = /ranch|farmer|cowboy|homestead|land|cattle|livestock/i.test(ctx);
  const isOldMan    = /old man|elderly|aging|weathered|retired|widower|gray|grey/i.test(ctx);
  const isWoman     = /\bshe\b|\bher\b|mother|woman|girl|wife|widow|daughter/i.test(ctx);
  const isChild     = /child|boy|girl|kid|son|daughter|young|little one/i.test(ctx);
  const isOfficer   = /police|officer|detective|sheriff|agent|badge|cop\b/i.test(ctx);
  const isGangster  = /gang|mob|mafia|cartel|criminal|syndicate|kingpin|traffick/i.test(ctx);
  const isSpy       = /spy|agent|cia|fbi|undercover|covert|assassin|hitman/i.test(ctx);
  const isDoctor    = /doctor|surgeon|nurse|hospital|patient|medical|diagnosis/i.test(ctx);
  const isLawyer    = /lawyer|attorney|counsel|case|defend|prosecut|court\b/i.test(ctx);

  /* ── 2. SETTING DETECTION ────────────────────────────────────────────── */
  const isDesert    = /desert|arizona|border|ranch|sand|mesa|scrub|sun-baked|arid/i.test(ctx);
  const isForest    = /forest|woods|trees|jungle|wilderness|rural/i.test(ctx);
  const isCity      = /city|urban|street|alley|downtown|neighborhood|apartment/i.test(ctx);
  const isCourt     = /court|trial|judge|jury|lawsuit|verdict|hearing/i.test(ctx);
  const isPrison    = /prison|jail|cell|bars|inmate|locked up|arrest/i.test(ctx);
  const isWar       = /battlefield|warzone|frontline|bunker|trenches|explosion|troops/i.test(ctx);
  const isOcean     = /ocean|sea|boat|ship|island|coast|storm|wave|sailor/i.test(ctx);
  const isMountain  = /mountain|summit|cliff|peak|altitude|avalanche|trek|hiking/i.test(ctx);

  /* ── 3. CONFLICT / ARC DETECTION ────────────────────────────────────── */
  const isBully     = /bully|humiliat|mock|ridicul|torment|abuse|harass|degrad|attack/i.test(ctx);
  const isBetrayal  = /betray|backstab|double.cross|frame|set.?up|falsely|lied|cheat/i.test(ctx);
  const isRevenge   = /revenge|retaliat|payback|fight.?back|turn.?the.?table|reckoning|confront/i.test(ctx);
  const isLoss      = /lost|died|death|killed|widow|grief|mourning|heartbreak|tragedy/i.test(ctx);
  const isStruggle  = /bank|foreclos|debt|poverty|evict|threaten|desperate|nowhere to turn/i.test(ctx);
  const isTriumph   = /triumph|justice|won|freed|survived|overcame|vindicated|walk.?free/i.test(ctx);
  const isInjustice = /innocent|wrongly|unjust|unfair|frame|corrupt|crooked|rigged/i.test(ctx);
  const isProtect   = /protect|defend|shield|save|rescue|guard|stood up/i.test(ctx);
  const isEscape    = /escape|run|flee|chase|hunted|pursued|hiding|on the run/i.test(ctx);
  const isSacrifice = /sacrifice|gave.?up|give.?up|everything to|for the sake of|choice/i.test(ctx);

  /* ── 4. EXTRACT CORE STORY CONFLICT ─────────────────────────────────── */
  // Pull the most emotionally charged sentence from the beat context
  // to anchor the image to the actual story premise.
  let coreConflict = "";
  const sentences = ctx.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  // Score sentences by conflict weight
  const conflictWords = /betray|frame|kill|murder|destroys|ruins|loses|threaten|arrested|corrupt|innocent|dying|trapped|left him|left her|abandoned|discover|reveal|truth/i;
  const scored = sentences.map(s => ({ s, score: (s.match(conflictWords) || []).length }));
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]?.score > 0) coreConflict = scored[0].s.trim().slice(0, 200);

  /* ── 5. BUILD CHARACTER DESCRIPTION ─────────────────────────────────── */
  let hero = "a lone man";
  if (isVeteran && isRancher) hero = "a weathered Vietnam veteran and rancher in his 60s, sun-beaten face, steel-grey stubble, eyes hardened by decades of loss and hardship, the face of a man who fought for his country and is now fighting for his land";
  else if (isVeteran && isOfficer) hero = "a decorated combat veteran turned law enforcement officer, jaw set like iron, uniform bearing the weight of both battlefield trauma and civic duty, eyes that have seen the worst of humanity";
  else if (isVeteran)         hero = "a battle-hardened military veteran in his prime, jaw set like stone, eyes that have seen too much — fierce, unbreakable, with the quiet righteous fury of a man who has been pushed to his absolute limit";
  else if (isRancher)         hero = "a rugged rancher with calloused, scarred hands and a deeply weathered face, standing on the land his family bled for, quiet fury smoldering in his eyes";
  else if (isOldMan && isInjustice) hero = "an elderly man with the bearing of someone who has lived righteously his whole life, now confronting a profound injustice — seemingly frail but with a burning, unquenchable defiance in his eyes";
  else if (isOldMan)          hero = "an elderly man, seemingly frail but with a burning defiance in his eyes that stops people cold — the look of someone who has survived everything and refuses to be broken now";
  else if (isWoman && isChild) hero = "a desperate mother clutching her young child close, body shielding the child from an unseen threat — eyes wide with primal fear, jaw set with the ferocious protectiveness only a parent knows";
  else if (isWoman && isBetrayal) hero = "a woman who trusted the wrong person — standing at the edge of devastating discovery, her expression a devastating mix of heartbreak and simmering fury, someone who will not go quietly";
  else if (isWoman)           hero = "a woman standing her ground against an overwhelming threat, hands trembling but eyes blazing with the righteous fury of someone who has been underestimated for the last time";
  else if (isChild && isInjustice) hero = "a young child caught in a storm of adult injustice — tear-streaked face turned upward, small and vulnerable yet refusing to break, with the heartbreaking dignity of a kid who shouldn't have to be this strong";
  else if (isChild)           hero = "a terrified child, tear-streaked face looking up at an overwhelming threat, small but refusing to cower";
  else if (isOfficer && isInjustice) hero = "a lone detective or officer who uncovered corruption from within — standing isolated in a system that wants him silenced, badge heavy with the weight of what he knows";
  else if (isGangster)        hero = "a man caught between worlds — the criminal empire he was born into and the sliver of conscience that remains, face bearing the scars of a life lived in shadow";
  else if (isSpy)             hero = "a covert operative whose cover has been blown — alone, hunted, but razor-focused, the calm of a trained professional masking a storm of urgency beneath";
  else if (isDoctor)          hero = "a doctor who knows a devastating truth that no one will believe — expression torn between clinical composure and desperate urgency, white coat now feeling like a prison";
  else if (isLawyer)          hero = "a lawyer who took the case everyone said was unwinnable — standing in the courthouse shadow, briefcase in hand, eyes carrying the weight of an innocent person's fate";

  /* ── 6. SETTING BACKDROP ─────────────────────────────────────────────── */
  let backdrop = "a dramatically lit dark background suggesting isolation and danger";
  if (isDesert)    backdrop = "a scorching Arizona desert at golden hour, dust haze on the horizon, oppressive heat shimmer, the vast emptiness of land fought over and bled for";
  else if (isWar)  backdrop = "a war-torn landscape, smoke and fire in the distance, bombed-out structures silhouetted against a blood-red sky, the absolute chaos of conflict";
  else if (isForest) backdrop = "a dense, threatening forest where every shadow hides something sinister, shafts of harsh late-afternoon light cutting through the dark canopy";
  else if (isCourt) backdrop = "the brutal geometry of a courtroom — cold marble pillars, harsh fluorescent light, the crushing institutional weight of a justice system being tested";
  else if (isPrison) backdrop = "cold concrete and iron bars, a single harsh overhead light casting deep cell-block shadows, the suffocating walls of wrongful confinement";
  else if (isCity)  backdrop = "a rain-slicked urban street at night, police lights strobing red and blue on wet asphalt, the anonymous cruelty of a city that doesn't care";
  else if (isOcean) backdrop = "a storm-lashed coastline at dusk, enormous waves crashing, the sea indifferent and merciless as the horizon disappears into dark clouds";
  else if (isMountain) backdrop = "a brutal mountain summit wreathed in cloud, biting wind visible in every detail, the sublime indifference of nature to human survival";

  /* ── 7. EMOTIONAL PEAK MOMENT + EXPRESSION ───────────────────────────── */
  let peakMoment = "standing defiantly at the point of no return";
  let facialExpr = "jaw clenched, eyes burning with quiet fury and absolute resolve";
  let storyDetail = coreConflict ? `The story behind this image: ${coreConflict}.` : "";

  if (isRevenge && isBully) {
    peakMoment = "rising from where they were knocked down — pointing a trembling finger directly at their tormentors, the moment the worm finally turns";
    facialExpr = "face flushed with rage, tears of anger streaming down cheeks, nostrils flaring — pure righteous fury that has been building for the entire film";
  } else if (isRevenge && isBetrayal) {
    peakMoment = "confronting the person who destroyed them — the betrayer frozen in sudden terror as the reckoning they thought they'd escaped arrives";
    facialExpr = "ice-cold fury beneath a mask of composure — the terrifying calm of someone who planned this moment for a very long time";
  } else if (isRevenge) {
    peakMoment = "stepping forward into the final confrontation, shoulders squared, the moment the oppressor realizes with absolute certainty they went too far";
    facialExpr = "cold, composed fury — the terrifying calm of someone who has nothing left to lose and everything to gain";
  } else if (isEscape) {
    peakMoment = "frozen mid-flight — caught between the only two options left: run or turn and fight";
    facialExpr = "raw survival panic barely controlled, adrenaline cracking through every muscle, but a core of steel refusing to let fear win";
  } else if (isBetrayal) {
    peakMoment = "frozen in the gut-punch instant of devastating betrayal — staring at the person they trusted with everything, their entire world collapsing in real time";
    facialExpr = "expression shattering from disbelief into volcanic rage — eyes glassy with shock, fists clenching as the grief turns to fury";
  } else if (isLoss && isSacrifice) {
    peakMoment = "bearing the unbearable weight of a sacrifice — what they gave up etched into every line of their face, but no regret, only grief";
    facialExpr = "grief-ravaged face, cheeks streaked with dried tears, the hollow look of someone who paid a price no one should have to pay";
  } else if (isLoss) {
    peakMoment = "head bowed over a loss that irrevocably changed everything, fists clenched at their sides in silent, shaking anguish";
    facialExpr = "grief-ravaged face streaked with tears, yet an ember of defiant resolve glowing underneath the devastation";
  } else if (isStruggle && (isVeteran || isRancher)) {
    peakMoment = "planting his feet on the land between him and the men who came to take it — arms at his sides, not moving an inch, a human immovable object";
    facialExpr = "eyes like flint, jaw set in absolute refusal — a man who has survived war and hardship and will not be moved by smaller men";
  } else if (isInjustice && isOfficer) {
    peakMoment = "holding the evidence that could destroy careers — alone in the spotlight of the truth he uncovered, knowing what it will cost him";
    facialExpr = "determined beyond fear, eyes clear with moral certainty even as everything closes in around him";
  } else if (isTriumph) {
    peakMoment = "the shattering moment of vindication — head raised, chest forward, years of unjust suffering suddenly behind them and the world finally seeing the truth";
    facialExpr = "eyes red-rimmed from the long unbearable fight, tears of relief and fierce pride mixed together — the face of someone who refused to stop";
  } else if (isProtect) {
    peakMoment = "stepping between the vulnerable and the threat — arms spread wide, body a shield, choosing this moment without hesitation";
    facialExpr = "face set with fierce protective resolve, love and duty overriding every instinct for self-preservation";
  }

  /* ── 8. STYLE-SPECIFIC PROMPT ────────────────────────────────────────── */
  let prompt;

  if (style === "bold") {
    // BOLD: Extreme close-up face, viral YouTube drama energy, red/amber palette.
    // The hero's face IS the story — every micro-expression carries the core conflict.
    prompt = [
      `Hyper-realistic cinematic photograph. Extreme close-up portrait of ${hero}.`,
      `The single most emotionally devastating moment of their story: ${peakMoment}.`,
      `Expression: ${facialExpr}.`,
      storyDetail,
      `The face fills 80% of the frame. Shot at eye level with a 50mm lens, razor-thin depth of field — eyes in perfect focus, everything behind falling into painterly blur.`,
      `Lighting: hard key light from below-right (campfire or bare interrogation bulb), cool blue fill from the opposite side creating split-face drama, blazing rim light outlining the jaw like fire.`,
      `Color grade: crushing warm amber-red shadows, fiery orange highlights scorching one side of the face, blown-out rim light creating a glowing edge — the unmistakable look of the highest-CTR YouTube drama channels.`,
      `The viewer should feel like they pressed PAUSE at the single most jaw-dropping second of the film.`,
      `Ultra-sharp eyes, visible tears or sweat on skin, micro-details in pores and stubble, hyperrealistic photography quality, 8K.`,
      `No text, no captions, no logos, no watermarks. 16:9 aspect ratio.`
    ].filter(Boolean).join(" ");

  } else {
    // DRAMATIC: Cinematic wide/medium, the hero in their story world.
    // The setting and story context are as important as the face.
    prompt = [
      `Award-winning cinematic still photograph. ${hero} at ${peakMoment},`,
      `set against ${backdrop}.`,
      `Expression: ${facialExpr}.`,
      storyDetail,
      `Composition: the hero is positioned using rule of thirds — left of center, with the weight of the world visible in the negative space to their right, conveying the isolation and enormity of what they face.`,
      `Every visual element reinforces the core story: the environment itself reflects their emotional state — hostile, charged, and impossible to escape.`,
      `Color grade: iconic Hollywood orange-and-teal — warm skin tones glowing against a cold steel-blue environment, maximum visual contrast and cinematic depth.`,
      `Lighting: practical source (harsh desert sun, bare bulb, or car headlights) with dramatic shadows carving the subject's face into something unforgettable.`,
      `Shot on ARRI Alexa at golden hour or magic hour; volumetric light rays, atmospheric dust or mist, subtle film grain.`,
      `This should feel like the defining key art still from a Netflix or Prime Video original — premium, emotionally devastating, and absolutely impossible to scroll past.`,
      `No text, no captions, no logos. 16:9 aspect ratio, ultra-detailed, photorealistic.`
    ].filter(Boolean).join(" ");
  }

  return prompt;
}

// Call DALL-E-3 and save the result as a JPEG.  Returns posterPath or null.
async function generateDalleThumbnail(apiKey, prompt, destPath) {
  // Try dall-e-3 first; fall back to dall-e-2 if model unavailable.
  // Do NOT send response_format — it was removed from the API in 2025.
  // gpt-image-1 is the current generation model (dall-e-3/2 removed from this key).
  // Returns b64_json by default; 1536x1024 is closest to 16:9 YouTube format.
  const tryGenerate = async (model, size) => {
    const body = { model, prompt, n: 1, size };
    const r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`ImageGen ${r.status} (${model}): ${json?.error?.message || JSON.stringify(json)}`);
    return json;
  };
  let data;
  try { data = await tryGenerate("gpt-image-1", "1536x1024"); }
  catch (e) {
    console.warn("gpt-image-1 1536x1024 failed, trying 1024x1024:", e.message);
    data = await tryGenerate("gpt-image-1", "1024x1024");
  }
  // Response shape: data[0].url OR data[0].b64_json depending on API version
  const entry = data?.data?.[0];
  let buf;
  if (entry?.url) {
    const imgRes = await fetch(entry.url);
    if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
    buf = Buffer.from(await imgRes.arrayBuffer());
  } else if (entry?.b64_json) {
    buf = Buffer.from(entry.b64_json, "base64");
  } else {
    throw new Error("No url or b64_json in DALL-E response");
  }
  // Re-encode to JPEG via ffmpeg (normalises size + strips metadata)
  const tmpPng = destPath + ".tmp.png";
  await fs.writeFile(tmpPng, buf);
  await new Promise((resolve) => {
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", tmpPng,
      "-vf", "scale=1280:-2", "-q:v", "3", destPath], { stdio: "ignore" });
    ff.on("close", resolve); ff.on("error", resolve);
  });
  try { await fs.unlink(tmpPng); } catch {}
  await fs.stat(destPath); // throws if file wasn't written
  return destPath;
}

// Build a channel-style DALL-E prompt from the story data.
// The goal: hyperrealistic YouTube thumbnail showing hero in danger — matching
// the "Super Short Summary" channel aesthetic (close-up face, tabloid drama).
function buildChannelDallEPrompt(style, { youtubeTitle, storySummary, movieTitle }) {
  const title = (youtubeTitle || movieTitle || "a dramatic movie scene").replace(/['"]/g, "");
  const summary = (storySummary || "").slice(0, 220).replace(/['"]/g, "");
  const storyCtx = summary
    ? `Story context: "${summary}". `
    : "";

  if (style === "dramatic") {
    return (
      `${storyCtx}` +
      `YouTube movie recap thumbnail — tabloid drama style, title: "${title}". ` +
      `Hyperrealistic cinematic close-up: the PROTAGONIST (the victim or hero from this story) fills most of the frame. ` +
      `Their face shows raw fear, desperation, or pain — wide eyes, tense jaw, sweat. ` +
      `A threatening figure or dark force looms behind them or is partially visible at the edge. ` +
      `Dramatic chiaroscuro: face lit from one side by a harsh amber/orange practical light, ` +
      `deep black background with cool blue shadows. Shallow depth of field, film grain, ` +
      `sharp on the eyes. No text. No watermarks. No subtitles. 16:9 aspect ratio.`
    );
  }
  if (style === "bold") {
    return (
      `${storyCtx}` +
      `YouTube thumbnail — high-voltage confrontation scene for: "${title}". ` +
      `Hyperrealistic film still: the hero faces the antagonist or threat head-on. ` +
      `Both figures tense, aggressive body language, intense eye contact or a physical clash. ` +
      `Extreme high-contrast lighting — vivid warm orange side-light on hero, ` +
      `cold blue/green on the antagonist. Punchy oversaturated colors. ` +
      `Camera slightly low-angle to emphasise power struggle. No text. No watermarks. 16:9.`
    );
  }
  // cinematic
  return (
    `${storyCtx}` +
    `Widescreen cinematic YouTube thumbnail for: "${title}". ` +
    `The protagonist stands small against an imposing, dangerous environment or crowd. ` +
    `Atmospheric: moody blue-grey haze, orange-amber practical lights in background, ` +
    `Hollywood orange-teal colour grade, heavy film grain, epic scale. ` +
    `The hero's body language conveys vulnerability or defiance. ` +
    `Netflix key-art quality. No text. No watermarks. 16:9 aspect ratio.`
  );
}

/* ---------- POST /jobs/:jobId/ai-thumbnails: real-frame channel thumbnails -- */
// Primary: enhanced real frames from the rendered recap video (actual movie character faces).
// Fallback: DALL-E only if real-frame extraction fails.
app.post("/jobs/:jobId/ai-thumbnails", requireAuth, async (req, res) => {
  const job = await jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });

  const { analyzeJobId, movieTitle } = req.body || {};

  const VARIANTS = ["dramatic", "bold", "cinematic"];
  const results = {};
  const errors  = {};

  // ── Resolve story data from the analyze job ───────────────────────────────
  let storyData = {
    youtubeTitle: null,
    storySummary: null,
    movieTitle: (typeof movieTitle === "string" && movieTitle.trim()) ? movieTitle.trim() : null,
  };
  const analyzeJobId_ = analyzeJobId || job.analyzeJobId;
  if (analyzeJobId_) {
    const analyzeJob = await jobStore.get(analyzeJobId_).catch(() => null);
    if (analyzeJob?.result) {
      storyData.youtubeTitle = analyzeJob.result.youtubeTitle || null;
      storyData.storySummary = analyzeJob.result.storySummary || null;
      storyData.movieTitle   = storyData.movieTitle || analyzeJob.result.movieTitle || analyzeJob.result.youtubeTitle || null;
    }
  }

  // ── PRIMARY: enhanced real movie frames from rendered recap ────────────────
  const outputVideo = job.outputPath || path.join(OUTPUT_DIR, `recap-${req.params.jobId}.mp4`);
  let videoOk = false;
  try { await fs.stat(outputVideo); videoOk = true; } catch {}

  if (videoOk) {
    const duration = await new Promise((resolve) => {
      let out = "";
      const fp = spawn("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", outputVideo,
      ], { stdio: ["ignore", "pipe", "ignore"] });
      fp.stdout.on("data", (c) => { out += c; });
      fp.on("close", () => resolve(parseFloat(out.trim()) || 60));
      fp.on("error", () => resolve(60));
    });

    const sceneTs = await findSceneChangeTimestamps(outputVideo, duration);
    const TARGET_REGIONS = {
      dramatic:  { lo: 0.45, hi: 0.78, fallback: 0.62 },
      bold:      { lo: 0.18, hi: 0.58, fallback: 0.42 },
      cinematic: { lo: 0.55, hi: 0.90, fallback: 0.72 },
    };
    const pickTimestamp = (style) => {
      const { lo, hi, fallback } = TARGET_REGIONS[style];
      const inRegion = sceneTs.filter((t) => t >= duration * lo && t <= duration * hi);
      if (inRegion.length > 0) {
        const center = duration * ((lo + hi) / 2);
        return inRegion.reduce((a, b) => Math.abs(b - center) < Math.abs(a - center) ? b : a);
      }
      return Math.max(1, Math.min(duration * fallback, duration - 1));
    };
    await Promise.allSettled(
      VARIANTS.map(async (style) => {
        try {
          const timeSec = pickTimestamp(style);
          const dest = aiThumbPath(req.params.jobId, style);
          await extractStyledFrame(outputVideo, timeSec, dest, style);
          results[style] = `/jobs/${req.params.jobId}/ai-thumbnails/${style}`;
          console.log(`[ai-thumbnails ${req.params.jobId}] real-frame ${style} @ ${timeSec.toFixed(1)}s OK`);
        } catch (e) {
          errors[style] = String(e?.message || e);
          console.warn(`[ai-thumbnails ${req.params.jobId}] real-frame ${style} failed:`, e?.message || e);
        }
      })
    );
  }

  // ── FALLBACK: DALL-E only for styles where real frame extraction failed ───
  const missingStyles = VARIANTS.filter((style) => !results[style]);
  if (missingStyles.length > 0 && SERVER_OPENAI_KEY) {
    await Promise.allSettled(
      missingStyles.map(async (style) => {
        try {
          const prompt = buildChannelDallEPrompt(style, storyData);
          const dest = aiThumbPath(req.params.jobId, style);
          console.log(`[ai-thumbnails ${req.params.jobId}] DALL-E fallback ${style} prompt: ${prompt.slice(0, 120)}…`);
          await generateDalleThumbnail(SERVER_OPENAI_KEY, prompt, dest);
          results[style] = `/jobs/${req.params.jobId}/ai-thumbnails/${style}`;
          console.log(`[ai-thumbnails ${req.params.jobId}] DALL-E fallback ${style} OK`);
        } catch (e) {
          errors[style] = (errors[style] ? errors[style] + " | " : "") + String(e?.message || e);
          console.warn(`[ai-thumbnails ${req.params.jobId}] DALL-E fallback ${style} failed:`, e?.message || e);
        }
      })
    );
  }

  if (Object.keys(results).length === 0) {
    return res.status(502).json({ error: "All thumbnail variants failed", details: errors });
  }
  const thumbPaths = {};
  for (const [style] of Object.entries(results)) {
    thumbPaths[style] = aiThumbPath(req.params.jobId, style);
  }
  await jobStore.update(req.params.jobId, { aiThumbnailPaths: thumbPaths }).catch(() => {});
  res.json({ thumbnails: results, errors: Object.keys(errors).length ? errors : undefined });
});

/* ---------- GET /jobs/:jobId/ai-thumbnails/:style: serve stored variant ---- */
app.get("/jobs/:jobId/ai-thumbnails/:style", requireAuth, async (req, res) => {
  const { jobId, style } = req.params;
  if (!AI_THUMB_STYLES.includes(style)) return res.status(400).json({ error: "Unknown style" });
  const thumbPath = aiThumbPath(jobId, style);
  try { await fs.stat(thumbPath); } catch { return res.status(404).json({ error: "Not generated yet" }); }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=86400");
  createReadStream(thumbPath).pipe(res);
});

/* ---------- helper: assemble SuperShortSummary description template ------- */
/* ---------- Fixed channel tags sent on every upload ----------------------- */
const MASTER_TAGS = [
  "Story Summary", "Film Summary", "movie recap", "movie recaps", "movie summary",
  "movie recapped", "recapped", "minute movies", "full movie", "motivational movies",
  "storytime", "story time", "film explained", "movie explained",
  "TheCutFrame", "mrrecapfromyoutube", "mr recap from youtube",
  "story recapped", "film recaps", "flick out", "movies in short", "mr recapp",
  "movies in minutes", "recap junction",
];

function buildSSSDescription({ movieTitle, storySummary, cast, directorWriter, chapters }) {
  const castLines = Array.isArray(cast) && cast.length
    ? cast.map(String).join("\n")
    : "[Cast]";
  const chapterLines = Array.isArray(chapters) && chapters.length
    ? chapters.map(String).join("\n")
    : "0:00 Opening";
  const dirLine = typeof directorWriter === "string" && directorWriter.trim()
    ? directorWriter.trim()
    : "[Director]";
  const titleLine = typeof movieTitle === "string" && movieTitle.trim()
    ? movieTitle.trim()
    : "[Movie Title]";
  const summaryText = typeof storySummary === "string" && storySummary.trim()
    ? storySummary.trim()
    : "";

  return [
    `Hey there! I'm SuperShortSummary! Today, I'm gonna recap the movie, ${titleLine}.`,
    "",
    "Become a channel supporter and unlock exclusive bonuses. Read more: /@SuperShortSummary",
    "",
    summaryText,
    "",
    "Hey! Welcome to my channel SuperShortSummary, where you'll find fast-paced, carefully written recaps of the most intense and gripping films. I'm a fellow movie fan, and I bring you top picks in short, thrilling summaries.",
    "",
    "Cast:",
    castLines,
    "",
    "Director & Writer:",
    dirLine,
    "",
    "📍 Chapters",
    chapterLines,
    "",
    "___________________________",
    "",
    "Here you can find: movie recaps, story recaps, thriller recaps, action movie summaries, film explained, movie highlights, story recap, movie summary, movie on, mrrecapfromyoutube, Mr recapp. TheCutFrame, Movies in short",
    "",
    "#movierecap\n#storyrecapped\n#movierecaps",
  ].join("\n");
}

/* ---------- POST /jobs/:jobId/regenerate-youtube-meta -------------------- */
// Re-calls Claude Haiku with the stored beats to produce a fresh title/description/tags.
app.post("/jobs/:jobId/regenerate-youtube-meta", requireAuth, async (req, res) => {
  const job = await jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  const beats = job.result?.beats || [];
  if (beats.length < 3) return res.status(409).json({ error: "Not enough story beats — run analysis first" });
  if (!SERVER_ANTHROPIC_KEY) return res.status(400).json({ error: "No Claude API key on server" });
  try {
    const beatSummary = beats
      .slice(0, 30)
      .map((b, i) => `${i + 1}. ${String(b.narration || b.reason || "").trim().slice(0, 120)}`)
      .join("\n");
    const _beatCount = Math.min(beats.length, 30);
    const _estMins = Math.max(4, Math.round(_beatCount * 0.5));
    const ytPrompt =
`You generate YouTube metadata for the channel "SuperShortSummary". Use ONLY the story beats below — do NOT add invented information.

Story beats (${_beatCount} total, estimated video length: ${_estMins}–${_estMins + 2} minutes):
${beatSummary}

Return valid JSON ONLY — no prose, no markdown fences:
{
  "youtubeTitle": "<max 60 chars — TABLOID SHOCK HOOK. Two patterns: (A) VILLAIN/THREAT + brutal verb + innocent victim — e.g. 'Thugs Brutally Kill an Ordinary Clerk\\'s Son', 'Gang Forces an Innocent Girl to Choose Death', 'Racist Bullies Target the Wrong Quiet Old Man', 'Corrupt Cops Frame a Helpless Man for Murder'. (B) ALL-CAPS flaw/emotion + person + self-destructive action — e.g. 'OBSESSED Man Ruins His Body and Family', 'DESPERATE Father Crosses Every Line to Save His Son'. STRONG VERBS: Kill, Murder, Destroy, Betray, Hunt, Ruin, Beat, Force, Crush, Frame, Torture. VICTIM ADJECTIVES: Ordinary, Innocent, Helpless, Quiet, Simple, Poor. NEVER use: recap, review, analysis, breakdown, explained. NEVER reveal who wins or the ending.>",
  "movieTitle": "<full movie name and year, e.g. Magazine Dreams (2023). Infer from the story content. If unknown write 'Unknown Movie'>",
  "storySummary": "<2–3 sentences. Introduce the hero and their world, the conflict that shatters it, and the impossible stakes. Storytelling voice — NOT a review. Do NOT mention 'this video' or 'this recap'.>",
  "cast": ["<Actor Name (as Character Name)>", "<Actor Name>"],
  "directorWriter": "<Director full name>",
  "chapters": ["0:00 <Chapter 1 title>", "<M:SS> <Chapter 2 title>", "<M:SS> <Chapter 3 title>", "<M:SS> <Chapter 4 title>", "<M:SS> <Chapter 5 title>", "<M:SS> <Chapter 6 title>"],
  "movieTags": ["<6–10 movie-specific tags only — actor names, character names, director name, movie title words, genre, mood. Examples: 'Jonathan Majors', 'Killian Maddox', 'bodybuilding', 'Elijah Bynum', 'Magazine Dreams'. Lowercase. No # prefix.>"]
}

For cast and directorWriter: use your training knowledge of the movie. If unknown, write an empty array / empty string.
Timestamps in chapters must be evenly spaced across the ${_estMins}-minute estimated duration.`;
    const ytRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": SERVER_ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1400, messages: [{ role: "user", content: ytPrompt }] }),
      signal: AbortSignal.timeout(25_000),
    });
    const ytData = await ytRes.json();
    const ytRaw = ytData?.content?.[0]?.text?.trim() || null;
    if (!ytRaw) throw new Error("Empty response from Claude");
    const fence = ytRaw.match(/```(?:json)?\s*([\s\S]+?)```/);
    const src = fence ? fence[1].trim() : ytRaw;
    const yt = JSON.parse(src);
    const assembledDescription = buildSSSDescription({
      movieTitle: yt.movieTitle,
      storySummary: yt.storySummary,
      cast: yt.cast,
      directorWriter: yt.directorWriter,
      chapters: yt.chapters,
    });
    const movieTags = Array.isArray(yt.movieTags) ? yt.movieTags.map(String).slice(0, 15) : [];
    const result = {
      youtubeTitle: typeof yt.youtubeTitle === "string" ? yt.youtubeTitle.trim().slice(0, 100) : undefined,
      youtubeDescription: assembledDescription,
      masterTags: MASTER_TAGS,
      movieTags,
      youtubeTags: [...MASTER_TAGS, ...movieTags],
    };
    console.log(`[regen-yt-meta ${req.params.jobId}] "${result.youtubeTitle}" | movie: ${yt.movieTitle} | movieTags: ${movieTags.length}`);
    res.json(result);
  } catch (err) {
    console.error(`[regen-yt-meta ${req.params.jobId}]`, err?.message || err);
    res.status(502).json({ error: String(err?.message || err) });
  }
});

/* ---------- /music/:mood.mp3: stream a built-in royalty-free mood bed ---------- */
app.get("/music/:mood", async (req, res) => {
  const safe = String(req.params.mood || "").toLowerCase().replace(/\.mp3$/, "").replace(/[^a-z]/g, "");
  if (!safe) return res.status(400).json({ error: "bad mood" });
  const p = path.join(MUSIC_DIR, `${safe}.mp3`);
  try { await fs.access(p); } catch { return res.status(404).json({ error: "mood not found" }); }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  createReadStream(p).pipe(res);
});

/* ---------- /transcribe: whisper-1 transcript with segment timestamps ----------
 *
 * Reuses an already-ingested movie at /data/uploads/<fileId>. Extracts mono
 * 16 kHz audio, chunks by duration, transcribes each chunk via OpenAI whisper-1
 * (verbose_json), offsets + merges segment timestamps to movie-absolute time,
 * and caches the result. The OpenAI key is supplied per-request and never
 * persisted server-side.
 */
app.post("/transcribe", requireAuth, async (req, res) => {
  const { fileId, language } = req.body || {};
  let { openaiApiKey } = req.body || {};
  if (!openaiApiKey && SERVER_OPENAI_KEY) openaiApiKey = SERVER_OPENAI_KEY;
  if (!fileId) return res.status(400).json({ error: "fileId required" });
  if (!openaiApiKey) return res.status(400).json({ error: "openaiApiKey required (no server key configured)" });
  const filePath = path.join(UPLOADS_DIR, fileId);
  try { await fs.access(filePath); } catch { return res.status(404).json({ error: "fileId not found" }); }

  const jobId = nanoid(10);
  await jobStore.create(jobId, { status: "running", progress: 0, message: "Queued", kind: "transcribe" });

  (async () => {
    try {
      const result = await transcribeMovie({
        fileId,
        uploadsDir: UPLOADS_DIR,
        apiKey: openaiApiKey,
        language: typeof language === "string" && language.trim() ? language.trim() : undefined,
        // translate:true → Whisper /translations endpoint → any language to English.
        // This is the safe default: Claude always needs English text.
        translate: true,
        onProgress: (pct, message) => {
          jobStore.update(jobId, { progress: pct, message }).catch(() => {});
        },
      });
      await jobStore.update(jobId, {
        status: "done",
        progress: 100,
        message: result.cached ? "Loaded cached transcript" : "Transcript ready",
        result: {
          fullText: result.fullText,
          segments: result.segments,
          durationSec: result.durationSec,
          chunkCount: result.chunkCount,
          cached: result.cached,
          segmentCount: result.segments.length,
        },
      });
    } catch (err) {
      console.error(`[transcribe ${jobId}]`, err);
      await jobStore.update(jobId, { status: "failed", message: String(err.message || err) });
    }
  })();

  res.json({ jobId });
});

/* ---------- /admin/cookies: upload a YouTube cookies.txt without SSH ----------
 *
 * The mobile app opens /admin/cookies-upload?token=... in an in-app browser,
 * the user picks the file someone exported on a desktop, the page POSTs to
 * /admin/cookies with the same bearer token, and we drop the file at
 * /data/cookies/cookies.txt where the yt-dlp wrapper picks it up on every
 * download. No container restart needed.
 */
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

app.get("/admin/cookies-upload", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "cookies-upload.html"));
});

const cookieUpload = multer({
  dest: COOKIES_DIR,
  limits: { fileSize: 2 * 1024 * 1024 }, // a real YouTube cookies.txt is ~30KB; cap at 2MB
});

app.post("/admin/cookies", requireAuth, cookieUpload.single("cookies"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "cookies file missing" });
  try {
    const buf = await fs.readFile(req.file.path);
    const text = buf.toString("utf8").trim();
    // Sanity check — a Netscape cookies.txt always starts with '# Netscape HTTP Cookie File'
    // OR has at least one tab-delimited line with .youtube.com / youtube.com domain.
    const looksValid =
      /^# Netscape HTTP Cookie File/i.test(text) ||
      /\byoutube\.com\b/i.test(text) ||
      /\bgoogle\.com\b/i.test(text);
    if (!looksValid) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(400).json({
        error:
          "That doesn't look like a Netscape cookies.txt for YouTube. Export it with the 'Get cookies.txt LOCALLY' extension on a logged-in youtube.com tab.",
      });
    }
    const target = path.join(COOKIES_DIR, "cookies.txt");
    await fs.rename(req.file.path, target);
    const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).length;
    res.json({ ok: true, savedTo: target, cookieLines: lines, bytes: buf.length });
  } catch (err) {
    console.error("[cookies-upload]", err);
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/admin/cookies", requireAuth, async (_req, res) => {
  const target = path.join(COOKIES_DIR, "cookies.txt");
  try {
    const stat = await fs.stat(target);
    res.json({
      present: true,
      bytes: stat.size,
      modified: stat.mtime.toISOString(),
    });
  } catch {
    res.json({ present: false });
  }
});

app.delete("/admin/cookies", requireAuth, async (_req, res) => {
  const target = path.join(COOKIES_DIR, "cookies.txt");
  try {
    await fs.unlink(target);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    if (err.code === "ENOENT") return res.json({ ok: true, deleted: false });
    res.status(500).json({ error: String(err.message || err) });
  }
});

/* ---------- /ingest: accept a URL or a multipart upload ---------- */
// Async job-based — returns { jobId } immediately so the app can poll
// for progress instead of blocking on a silent HTTP connection for minutes.
app.post("/ingest/url", requireAuth, async (req, res) => {
  const { sourceUrl } = req.body || {};
  if (typeof sourceUrl !== "string" || !sourceUrl.trim()) {
    return res.status(400).json({ error: "sourceUrl required" });
  }

  const jobId = nanoid(10);
  await jobStore.create(jobId, {
    status: "running",
    progress: 2,
    message: "Connecting to server…",
    kind: "ingest-url",
  });
  res.json({ jobId });

  // Fire-and-forget background download with live progress updates.
  (async () => {
    try {
      const onProgress = ({ phase, received, total, percent }) => {
        if (phase === "cached") {
          jobStore.update(jobId, { progress: 100, message: "Already cached — using existing file" }).catch(() => {});
        } else if (phase === "http-start" || phase === "ytdlp-start") {
          jobStore.update(jobId, { progress: 5, message: "Downloading movie…" }).catch(() => {});
        } else if (phase === "http-progress") {
          const pct = (total > 0) ? Math.round((received / total) * 90) + 5 : 10;
          const mb  = (received / 1048576).toFixed(0);
          const msg = total > 0
            ? `Downloading… ${mb} MB / ${(total / 1048576).toFixed(0)} MB`
            : `Downloading… ${mb} MB`;
          jobStore.update(jobId, { progress: Math.min(pct, 94), message: msg }).catch(() => {});
        } else if (phase === "ytdlp-progress") {
          const pct = Math.round((percent / 100) * 90) + 5;
          jobStore.update(jobId, { progress: Math.min(pct, 94), message: `Downloading… ${percent.toFixed(1)}%` }).catch(() => {});
        } else if (phase === "http-done" || phase === "ytdlp-done") {
          jobStore.update(jobId, { progress: 96, message: "Finalising…" }).catch(() => {});
        }
      };

      const result = await ingestFromUrl({ sourceUrl, uploadsDir: UPLOADS_DIR, onProgress });
      await jobStore.update(jobId, {
        status: "done",
        progress: 100,
        message: result.cached ? "Ready (cached)" : "Download complete",
        result: { fileId: result.fileId, bytes: result.bytes, cached: result.cached, detectedSource: result.plan?.detectedSource },
      });
      console.log(`[ingest/url] done — jobId=${jobId} fileId=${result.fileId} cached=${result.cached}`);
    } catch (err) {
      console.error("[ingest/url]", err?.message || err);
      await jobStore.update(jobId, {
        status: "error",
        progress: 0,
        message: err?.message || String(err),
      }).catch(() => {});
    }
  })();
});

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /ingest/torrent  { magnetUrl }  → { jobId }
 *
 * Downloads a magnet link or .torrent URL directly on the VPS using aria2c,
 * then registers the downloaded file as a fileId ready for /analyze.
 * This avoids the user having to download the movie to their phone and re-upload.
 *
 * Requirements: aria2c must be installed in the Docker container.
 *   apt-get install -y aria2   (already in Dockerfile, or add it)
 *
 * The job polls like any other job via GET /jobs/:jobId. On completion the
 * job result contains { fileId } which the app can use directly for /analyze.
 * ─────────────────────────────────────────────────────────────────────────────*/
app.post("/ingest/torrent", requireAuth, async (req, res) => {
  const { magnetUrl } = req.body || {};
  if (typeof magnetUrl !== "string" || !magnetUrl.trim()) {
    return res.status(400).json({ error: "magnetUrl is required (magnet: URI or https:// .torrent link)" });
  }
  const mag = magnetUrl.trim();
  if (!mag.startsWith("magnet:") && !/^https?:\/\//i.test(mag)) {
    return res.status(400).json({ error: "magnetUrl must be a magnet: URI or a URL" });
  }

  const jobId = nanoid(10);
  await jobStore.create(jobId, {
    status: "queued",
    progress: 0,
    message: "Torrent download queued",
    type: "torrent",
  });
  res.json({ jobId });

  // Run torrent download in the background — do not await.
  // Strategy:
  //   1. If REAL_DEBRID_API_KEY is set → use Real-Debrid (works even when Contabo
  //      blocks all outbound UDP/BitTorrent traffic).
  //   2. Otherwise → fall back to direct aria2c (requires open UDP ports).
  (async () => {
    try {
      await jobStore.update(jobId, { status: "running", progress: 0.02, message: "Starting torrent download…" });

      // ── Step 1: Resolve web page URL → magnet link ──────────────────────
      // If the user pastes a torrent-site page URL (1337x, YTS, etc.) instead
      // of a magnet link, fetch the page and extract the first magnet: URI.
      let resolvedMag = mag;
      if (!mag.startsWith("magnet:") && !/\.torrent$/i.test(mag)) {
        await jobStore.update(jobId, { progress: 0.01, message: "Fetching torrent page to extract magnet link…" });
        try {
          const pageRes = await fetch(mag, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" },
            redirect: "follow",
            signal: AbortSignal.timeout(15000),
          });
          const html = await pageRes.text();
          const magnetMatch = html.match(/href="(magnet:[^"]+)"/i)
            || html.match(/href='(magnet:[^']+)'/i)
            || html.match(/(magnet:\?xt=urn:btih:[A-Za-z0-9]+[^"'\s<>]*)/i);
          if (magnetMatch) {
            resolvedMag = magnetMatch[1];
            console.log(`[ingest/torrent] extracted magnet: ${resolvedMag.slice(0, 80)}…`);
            await jobStore.update(jobId, { progress: 0.02, message: "Magnet link extracted — starting download…" });
          } else {
            throw new Error("Could not find a magnet link on the provided page. Paste the magnet link directly instead.");
          }
        } catch (fetchErr) {
          if (fetchErr.message.startsWith("Could not find")) throw fetchErr;
          throw new Error(`Failed to fetch torrent page: ${fetchErr.message}`);
        }
      }

      // ── Step 2a: Real-Debrid path (preferred — works on Contabo) ─────────
      const RD_KEY = process.env.REAL_DEBRID_API_KEY || "";
      const RD_BASE = "https://api.real-debrid.com/rest/1.0";

      if (RD_KEY) {
        console.log(`[ingest/torrent] using Real-Debrid`);

        const rdFetch = async (method, endpoint, body) => {
          const res = await fetch(`${RD_BASE}${endpoint}`, {
            method,
            headers: {
              Authorization: `Bearer ${RD_KEY}`,
              ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
            },
            body: body ? new URLSearchParams(body).toString() : undefined,
            signal: AbortSignal.timeout(20000),
          });
          const text = await res.text();
          if (!res.ok) throw new Error(`Real-Debrid ${endpoint} → HTTP ${res.status}: ${text.slice(0, 200)}`);
          return text ? JSON.parse(text) : {};
        };

        // 2a-1: Add magnet to Real-Debrid
        await jobStore.update(jobId, { progress: 0.05, message: "Sending magnet to Real-Debrid…" });
        const { id: rdId } = await rdFetch("POST", "/torrents/addMagnet", { magnet: resolvedMag });
        if (!rdId) throw new Error("Real-Debrid did not return a torrent ID. Check your API key.");

        // 2a-2: Select all files for download
        await rdFetch("POST", `/torrents/selectFiles/${rdId}`, { files: "all" });

        // 2a-3: Poll until Real-Debrid has downloaded the torrent on their side
        await jobStore.update(jobId, { progress: 0.07, message: "Real-Debrid is fetching the torrent (waiting for seeders)…" });
        let rdInfo;
        const RD_POLL_MAX = 720; // 60 min max (720 × 5s)
        for (let i = 0; i < RD_POLL_MAX; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          rdInfo = await rdFetch("GET", `/torrents/info/${rdId}`);
          const pct = (rdInfo.progress || 0) / 100;
          const seeders = rdInfo.seeders ?? "?";
          const speed = rdInfo.speed ? ` · ${(rdInfo.speed / 1e6).toFixed(1)} MB/s` : "";
          await jobStore.update(jobId, {
            progress: 0.07 + pct * 0.60,
            message: `Real-Debrid: ${rdInfo.progress ?? 0}%${speed} (${seeders} seeders) — ${rdInfo.status}`,
            recentLogs: [{ ts: Date.now(), msg: `[RD] ${rdInfo.status} ${rdInfo.progress}%${speed}` }],
          });
          if (rdInfo.status === "downloaded") break;
          if (["error", "virus", "dead", "magnet_error"].includes(rdInfo.status)) {
            throw new Error(`Real-Debrid rejected the torrent: status="${rdInfo.status}". Try a different source.`);
          }
        }
        if (rdInfo?.status !== "downloaded") {
          throw new Error("Real-Debrid timed out waiting for the torrent. The torrent may have no seeders.");
        }

        // 2a-4: Unrestrict all links, pick the largest video file
        const VIDEO_EXTS = /\.(mkv|mp4|avi|mov|wmv|flv|m4v|ts|m2ts|webm)$/i;
        const links = rdInfo.links || [];
        if (!links.length) throw new Error("Real-Debrid returned no download links.");

        await jobStore.update(jobId, { progress: 0.68, message: "Resolving direct download links…" });
        const unrestricted = await Promise.all(
          links.map((link) =>
            rdFetch("POST", "/unrestrict/link", { link }).catch((e) => {
              console.warn(`[ingest/torrent] RD unrestrict failed for link: ${e.message}`);
              return null;
            })
          )
        );
        const videoLinks = unrestricted
          .filter(Boolean)
          .filter((u) => VIDEO_EXTS.test(u.filename || "") || VIDEO_EXTS.test(u.download || ""))
          .sort((a, b) => (b.filesize || 0) - (a.filesize || 0));

        const chosen = videoLinks[0] || unrestricted.find(Boolean);
        if (!chosen?.download) throw new Error("Real-Debrid: could not resolve a direct download URL.");

        const rdFilename = chosen.filename || `movie-${nanoid(8)}.mkv`;
        const rdOutPath = path.join(UPLOADS_DIR, rdFilename);
        console.log(`[ingest/torrent] RD direct URL → ${chosen.download.slice(0, 80)}… size=${chosen.filesize}`);

        // 2a-5: Download the direct HTTPS link via yt-dlp (handles redirects + auth cookies)
        await jobStore.update(jobId, { progress: 0.70, message: `Downloading from Real-Debrid CDN: ${rdFilename}` });

        await new Promise((resolve, reject) => {
          const dl = spawn("yt-dlp", [
            "--no-playlist",
            "--retries", "5",
            "--fragment-retries", "5",
            "-o", rdOutPath,
            chosen.download,
          ], { stdio: ["ignore", "pipe", "pipe"] });

          let dlBuf = "";
          dl.stdout.on("data", (chunk) => {
            dlBuf += chunk.toString();
            const lines = dlBuf.split("\n");
            dlBuf = lines.pop();
            for (const l of lines) {
              const pctM = l.match(/(\d+\.\d+)%\s+of\s+([\d.]+\w+)\s+at\s+([\d.]+\w+)/);
              if (pctM) {
                const pct = parseFloat(pctM[1]) / 100;
                jobStore.update(jobId, {
                  progress: 0.70 + pct * 0.28,
                  message: `Downloading: ${pctM[1]}% of ${pctM[2]} at ${pctM[3]}/s`,
                }).catch(() => {});
              }
            }
          });
          dl.stderr.on("data", (chunk) => {
            const l = chunk.toString().trim();
            if (l) console.warn(`[yt-dlp/rd] ${l}`);
          });
          dl.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`yt-dlp exited with code ${code} while downloading from Real-Debrid CDN.`));
          });
        });

        // 2a-6: Rename to stable fileId
        const rdExt = path.extname(rdOutPath).toLowerCase() || ".mkv";
        const fileId = `movie-${nanoid(12)}${rdExt}`;
        const finalPath = path.join(UPLOADS_DIR, fileId);
        // yt-dlp may have added an extension; find the actual output file
        let actualPath = rdOutPath;
        try { await fs.access(rdOutPath); } catch {
          const candidates = (await fs.readdir(UPLOADS_DIR))
            .filter((f) => f.startsWith(path.basename(rdFilename, path.extname(rdFilename))))
            .map((f) => path.join(UPLOADS_DIR, f));
          if (candidates.length) actualPath = candidates[0];
        }
        await fs.rename(actualPath, finalPath);
        const stat = await fs.stat(finalPath);

        await jobStore.update(jobId, {
          status: "done",
          progress: 1,
          message: `Download complete — ${(stat.size / 1e9).toFixed(2)} GB`,
          result: { fileId, bytes: stat.size },
          recentLogs: [{ ts: Date.now(), msg: `[RD] Done — fileId=${fileId} (${(stat.size / 1e9).toFixed(2)} GB)` }],
        });
        console.log(`[ingest/torrent] RD done — jobId=${jobId} fileId=${fileId} size=${stat.size}`);
        return; // ← success, skip aria2c fallback
      }

      // ── Step 2b: Seedr.cc path (free 2 GB tier — auto-deletes after download) ──
      // Seedr downloads the torrent on their own servers (full P2P access),
      // then serves a direct HTTPS link. After we copy to the VPS, we
      // immediately delete the Seedr folder so the 2 GB resets automatically.
      const SEEDR_USER = process.env.SEEDR_USERNAME || "";
      const SEEDR_PASS = process.env.SEEDR_PASSWORD || "";

      if (SEEDR_USER && SEEDR_PASS) {
        console.log(`[ingest/torrent] using Seedr.cc`);
        const SEEDR_API = "https://www.seedr.cc";

        // Helper: call Seedr API with Bearer token
        let seedrToken = null;
        const seedrFetch = async (method, endpoint, body) => {
          const headers = { ...(seedrToken ? { Authorization: `Bearer ${seedrToken}` } : {}) };
          if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
          const res = await fetch(`${SEEDR_API}${endpoint}`, {
            method,
            headers,
            body: body ? new URLSearchParams(body).toString() : undefined,
            signal: AbortSignal.timeout(20000),
          });
          const text = await res.text();
          if (!res.ok) throw new Error(`Seedr ${endpoint} → HTTP ${res.status}: ${text.slice(0, 200)}`);
          return text ? JSON.parse(text) : {};
        };

        // 2b-1: Authenticate
        await jobStore.update(jobId, { progress: 0.03, message: "Authenticating with Seedr.cc…" });
        const authData = await seedrFetch("POST", "/oauth_test/token", {
          grant_type: "password",
          client_id: "seedr_chrome",
          device_id: "cinerecap-server",
          username: SEEDR_USER,
          password: SEEDR_PASS,
        });
        if (!authData.access_token) throw new Error("Seedr login failed — check SEEDR_USERNAME and SEEDR_PASSWORD.");
        seedrToken = authData.access_token;

        // 2b-2: Clear ALL existing Seedr content first (free up the 2 GB)
        await jobStore.update(jobId, { progress: 0.04, message: "Clearing Seedr storage space…" });
        const existing = await seedrFetch("GET", "/api/folder");
        for (const folder of existing.folders || []) {
          await seedrFetch("DELETE", `/api/folder/${folder.id}`).catch(() => {});
        }
        for (const file of existing.files || []) {
          await seedrFetch("DELETE", `/api/file/${file.id}`).catch(() => {});
        }

        // 2b-3: Send the magnet/torrent to Seedr
        await jobStore.update(jobId, { progress: 0.05, message: "Sending torrent to Seedr.cc…" });
        const addBody = resolvedMag.startsWith("magnet:")
          ? { magnet_link: resolvedMag }
          : { url: resolvedMag };
        const addData = await seedrFetch("POST", "/api/folder/add_torrent", addBody);
        if (addData.error) throw new Error(`Seedr rejected the torrent: ${addData.error}. The file may exceed the 2 GB free limit.`);

        // 2b-4: Poll until Seedr has downloaded the torrent (folder + files appear)
        await jobStore.update(jobId, { progress: 0.07, message: "Seedr.cc is downloading the torrent…" });
        let seedrFolderId = null;
        let seedrFiles = [];
        const SEEDR_POLL_MAX = 360; // 30 min max (360 × 5 s)
        for (let i = 0; i < SEEDR_POLL_MAX; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const listing = await seedrFetch("GET", "/api/folder");
          const folders = listing.folders || [];
          if (folders.length > 0) {
            // Peek inside the first (newest) folder for files
            const detail = await seedrFetch("GET", `/api/folder/${folders[0].id}`);
            const files = detail.files || [];
            if (files.length > 0) {
              seedrFolderId = folders[0].id;
              seedrFiles = files;
              break;
            }
          }
          const elapsedMin = Math.round((i * 5) / 60);
          await jobStore.update(jobId, {
            progress: Math.min(0.07 + (i / SEEDR_POLL_MAX) * 0.60, 0.65),
            message: `Seedr.cc is downloading the torrent… (${elapsedMin} min elapsed)`,
            recentLogs: [{ ts: Date.now(), msg: `[SEEDR] waiting… ${elapsedMin}m` }],
          });
        }
        if (!seedrFolderId) {
          throw new Error("Seedr.cc timed out. The torrent may have no seeders, or the file exceeds the 2 GB free storage limit. Try a 720p version.");
        }

        // 2b-5: Pick the largest video file
        const VIDEO_EXTS_RE = /\.(mkv|mp4|avi|mov|wmv|flv|m4v|ts|m2ts|webm)$/i;
        const videoFiles = seedrFiles
          .filter((f) => VIDEO_EXTS_RE.test(f.name || ""))
          .sort((a, b) => (b.size || 0) - (a.size || 0));
        const chosen = videoFiles[0] || seedrFiles.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
        const downloadUrl = chosen.download_url || chosen.url;
        if (!downloadUrl) throw new Error("Seedr: no download URL found for the video file.");

        // 2b-6: Download from Seedr CDN → VPS via aria2c (with auth header)
        const seedrOutName = chosen.name || `seedr-movie-${nanoid(8)}.mkv`;
        const seedrOutPath = path.join(UPLOADS_DIR, seedrOutName);
        await jobStore.update(jobId, { progress: 0.68, message: `Downloading from Seedr CDN: ${seedrOutName}` });

        await new Promise((resolve, reject) => {
          const dl = spawn("aria2c", [
            "--dir", UPLOADS_DIR,
            "--out", seedrOutName,
            "--max-connection-per-server=4",
            "--split=4",
            "--summary-interval=5",
            `--header=Authorization: Bearer ${seedrToken}`,
            downloadUrl,
          ], { stdio: ["ignore", "pipe", "pipe"] });

          let buf = "";
          dl.stdout.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n"); buf = lines.pop();
            for (const l of lines) {
              const pctM = l.match(/\((\d+)%\)/);
              if (pctM) {
                const pct = Number(pctM[1]) / 100;
                const dlMatch = l.match(/DL:([\d.]+\w+)/);
                const etaMatch = l.match(/ETA:([\w]+)/);
                jobStore.update(jobId, {
                  progress: 0.68 + pct * 0.30,
                  message: `Downloading: ${pctM[1]}%${dlMatch ? ` · ${dlMatch[1]}/s` : ""}${etaMatch ? ` · ETA ${etaMatch[1]}` : ""}`,
                }).catch(() => {});
              }
            }
          });
          dl.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`aria2c exited ${code} while downloading from Seedr CDN.`))
          );
        });

        // 2b-7: Auto-delete from Seedr immediately (frees 2 GB for next download)
        await seedrFetch("DELETE", `/api/folder/${seedrFolderId}`).catch(() => {});
        console.log(`[ingest/torrent] Seedr folder ${seedrFolderId} deleted — 2 GB freed`);

        // 2b-8: Rename to stable fileId
        const seedrExt = path.extname(seedrOutName).toLowerCase() || ".mkv";
        const fileId = `movie-${nanoid(12)}${seedrExt}`;
        const finalPath = path.join(UPLOADS_DIR, fileId);
        // aria2c writes to exact --out path
        await fs.rename(seedrOutPath, finalPath).catch(async () => {
          const candidates = (await fs.readdir(UPLOADS_DIR))
            .filter((f) => f.startsWith(path.basename(seedrOutName, seedrExt)))
            .map((f) => path.join(UPLOADS_DIR, f));
          if (candidates.length) await fs.rename(candidates[0], finalPath);
          else throw new Error("Downloaded file not found after Seedr transfer.");
        });
        const stat = await fs.stat(finalPath);

        await jobStore.update(jobId, {
          status: "done",
          progress: 1,
          message: `Download complete — ${(stat.size / 1e9).toFixed(2)} GB`,
          result: { fileId, bytes: stat.size },
          recentLogs: [{ ts: Date.now(), msg: `[SEEDR] Done — fileId=${fileId} (${(stat.size / 1e9).toFixed(2)} GB)` }],
        });
        console.log(`[ingest/torrent] Seedr done — jobId=${jobId} fileId=${fileId} size=${stat.size}`);
        return; // ← success, skip aria2c fallback
      }

      // ── Step 2c: aria2c fallback (requires open UDP ports) ───────────────
      // NOTE: Contabo VPS blocks outbound UDP, so this path will fail on that
      // host. Set REAL_DEBRID_API_KEY to use the reliable path above.
      console.log(`[ingest/torrent] REAL_DEBRID_API_KEY not set — falling back to aria2c`);
      const PUBLIC_TRACKERS = [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.tracker.cl:1337/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "udp://opentracker.i2p.rocks:6969/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://open.stealth.si:80/announce",
        "https://tracker.tamersunion.org/announce",
      ].join(",");
      const aria2 = spawn("aria2c", [
        "--dir", UPLOADS_DIR,
        "--seed-time=0",
        "--max-tries=3",
        "--retry-wait=3",
        "--connect-timeout=15",
        "--timeout=30",
        "--bt-stop-timeout=60",
        "--async-dns=false",
        "--console-log-level=warn",
        "--summary-interval=5",
        "--on-bt-download-complete=/bin/true",
        `--bt-tracker=${PUBLIC_TRACKERS}`,
        resolvedMag,
      ], { stdio: ["ignore", "pipe", "pipe"] });

      let downloadedFile = null;
      let lastProgress = 0.02;

      const parseProgress = (line) => {
        const pctMatch = line.match(/\((\d+)%\)/);
        if (pctMatch) {
          const pct = Number(pctMatch[1]) / 100;
          lastProgress = Math.max(lastProgress, 0.02 + pct * 0.95);
          const dlMatch = line.match(/DL:([\d.]+\w+)/);
          const etaMatch = line.match(/ETA:([\w]+)/);
          const speed = dlMatch ? ` · ${dlMatch[1]}/s` : "";
          const eta = etaMatch ? ` · ETA ${etaMatch[1]}` : "";
          jobStore.update(jobId, {
            progress: lastProgress,
            message: `Downloading torrent: ${Math.round(pct * 100)}%${speed}${eta}`,
            recentLogs: [{ ts: Date.now(), msg: `[TORRENT] ${Math.round(pct * 100)}%${speed}${eta}` }],
          }).catch(() => {});
        }
        const fileMatch = line.match(/Download complete: (.+)/i);
        if (fileMatch) downloadedFile = fileMatch[1].trim();
      };

      let stdoutBuf = "";
      aria2.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop();
        lines.forEach(parseProgress);
      });
      let stderrBuf = "";
      aria2.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop();
        for (const l of lines) {
          if (l.includes("ERROR") || l.includes("error")) {
            jobStore.update(jobId, {
              recentLogs: [{ ts: Date.now(), msg: `[aria2c] ${l.trim()}` }],
            }).catch(() => {});
          }
        }
      });

      const ARIA2_HARD_TIMEOUT_MS = 20 * 60 * 1000;
      let aria2KillTimer;
      const exitCode = await new Promise((resolve) => {
        aria2.on("close", resolve);
        aria2KillTimer = setTimeout(() => {
          try { aria2.kill("SIGKILL"); } catch { /* already exited */ }
          resolve(-1);
        }, ARIA2_HARD_TIMEOUT_MS);
      });
      clearTimeout(aria2KillTimer);

      if (exitCode !== 0) {
        if (exitCode === -1) {
          throw new Error("Torrent download timed out after 20 minutes. The VPS cannot reach torrent trackers. Add a REAL_DEBRID_API_KEY in server settings to fix this.");
        }
        if (exitCode === 7) {
          throw new Error("Torrent failed: no peers found — the VPS blocks BitTorrent UDP traffic. Add a REAL_DEBRID_API_KEY in server settings to enable torrent downloads.");
        }
        if (exitCode === 13) {
          throw new Error("Torrent failed: trackers unreachable — UDP is blocked on this VPS. Add a REAL_DEBRID_API_KEY in server settings.");
        }
        throw new Error(`aria2c exited with code ${exitCode}. Add REAL_DEBRID_API_KEY to enable torrent support on this server.`);
      }

      if (!downloadedFile) {
        const files = await fs.readdir(UPLOADS_DIR);
        const stats = await Promise.all(
          files.map(async (f) => {
            const s = await fs.stat(path.join(UPLOADS_DIR, f)).catch(() => null);
            return s ? { name: f, mtime: s.mtimeMs, size: s.size } : null;
          }),
        );
        const newest = stats
          .filter(Boolean)
          .filter((f) => f.size > 10 * 1024 * 1024)
          .sort((a, b) => b.mtime - a.mtime)[0];
        if (!newest) throw new Error("aria2c finished but no large file found in uploads dir.");
        downloadedFile = path.join(UPLOADS_DIR, newest.name);
      }

      const ext = path.extname(downloadedFile).toLowerCase() || ".mkv";
      const fileId = `movie-${nanoid(12)}${ext}`;
      const finalPath = path.join(UPLOADS_DIR, fileId);
      await fs.rename(downloadedFile, finalPath);
      const stat = await fs.stat(finalPath);

      await jobStore.update(jobId, {
        status: "done",
        progress: 1,
        message: `Download complete — ${(stat.size / 1e9).toFixed(2)} GB`,
        result: { fileId, bytes: stat.size },
        recentLogs: [{ ts: Date.now(), msg: `[TORRENT] Done — fileId=${fileId} (${(stat.size / 1e9).toFixed(2)} GB)` }],
      });
      console.log(`[ingest/torrent] done — jobId=${jobId} fileId=${fileId} size=${stat.size}`);
    } catch (err) {
      console.error("[ingest/torrent] error:", err?.message || err);
      await jobStore.update(jobId, {
        status: "failed",
        progress: 0,
        message: String(err?.message || err),
        error: String(err?.message || err),
      }).catch(() => {});
    }
  })();
});

/* ---------- /analyze: server-side frame sample + Claude call ---------- */
app.post("/analyze", requireAuth, async (req, res) => {
  const { fileId, movie, channelName, anthropicApiKey, model, frameBudget, maxClipSeconds, targetClipCount, targetMinutes: analyzeTargetMinutes, language, forceRefresh } = req.body || {};
  // Derive beat target from targetMinutes (1 beat per 15s of recap, clamped 40–120).
  // Falls back to app-supplied targetClipCount, then to 80 (≈20 min default).
  const effectiveTargetClipCount = Number(targetClipCount) ||
    (analyzeTargetMinutes ? Math.max(40, Math.min(120, Math.round(Number(analyzeTargetMinutes) * 60 / 15))) : 80);
  let { useTranscript, openaiApiKey } = req.body || {};
  const openaiKeyPreview = req.body?.openaiApiKey ? req.body.openaiApiKey.slice(0, 10) + '...' : 'none';
  const debugMsg = `[/analyze] Incoming: useTranscript=${useTranscript}, openaiKey=${openaiKeyPreview}, serverKey=${!!SERVER_OPENAI_KEY}`;
  console.log(debugMsg);
  await fs.appendFile(path.join(STORAGE_DIR, 'debug.log'), debugMsg + '\n').catch(() => {});
  // Prefer the app-supplied key, but fall back to the server's own key so
  // transcription ALWAYS runs (true dialogue-grounded sync) without the user
  // pasting a key in the app. If any OpenAI key is available, force transcript on.
  if (!openaiApiKey && SERVER_OPENAI_KEY) openaiApiKey = SERVER_OPENAI_KEY;
  if (openaiApiKey) useTranscript = true;
  const debugMsg2 = `[/analyze] After fallback: useTranscript=${useTranscript}, hasKey=${!!openaiApiKey}`;
  console.log(debugMsg2);
  await fs.appendFile(path.join(STORAGE_DIR, 'debug.log'), debugMsg2 + '\n').catch(() => {});
  // Server-side Anthropic key override:
  //   key  — server key wins outright (keeps user key private, no app config needed)
  //   model — always use server-pinned model; app-provided model is ignored.
  //           Override via ANTHROPIC_MODEL env var if needed.
  let effectiveAnthropicKey   = anthropicApiKey   || SERVER_ANTHROPIC_KEY;
  // claude-opus-4-5: used instead of Sonnet because Sonnet 4.5 hallucinated
  // character names (e.g. "Hector" instead of "Jonathan") and misidentified
  // scene timestamps by 5–10s in tested renders. Opus has significantly better
  // factual recall and scene sequencing for long films.
  // Override via ANTHROPIC_MODEL env var on the server if cost is a concern.
  let effectiveAnthropicModel = SERVER_ANTHROPIC_MODEL || "claude-opus-4-5";
  if (SERVER_ANTHROPIC_KEY) {
    effectiveAnthropicKey = SERVER_ANTHROPIC_KEY;
    console.log(`[analyze] server Anthropic key active — model: ${effectiveAnthropicModel}`);
  }
  if (!fileId) return res.status(400).json({ error: "fileId required" });
  if (!effectiveAnthropicKey) return res.status(400).json({ error: "anthropicApiKey required (or set ANTHROPIC_API_KEY on server)" });
  if (!movie || typeof movie.title !== "string") return res.status(400).json({ error: "movie.title required" });
  const filePath = path.join(UPLOADS_DIR, fileId);
  try { await fs.access(filePath); } catch { return res.status(404).json({ error: "fileId not found" }); }

  const jobId = nanoid(10);
  await jobStore.create(jobId, { status: "running", progress: 5, message: "Probing duration", kind: "analyze", sourceFileId: fileId });

  // Fire-and-forget; client polls /jobs/:jobId.
  (async () => {
    try {
      // ── ANALYSIS CACHE: skip heavy work if a completed job exists ──────────
      // The app polls this new job (running → done) so it sees the proper
      // transition. We just fill the result from the previous job instantly
      // instead of re-running frame extraction + Claude (10+ min).
      // Pass forceRefresh:true in the request body to bypass.
      if (!forceRefresh) {
        try {
          const allJobs = await jobStore.list();
          const prev = allJobs
            .filter((j) => j.id !== jobId && j.kind === "analyze" && j.status === "done" &&
              (j.sourceFileId === fileId || j.result?.sourceFileId === fileId) &&
              j.result?.beats?.length > 0)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
          if (prev) {
            console.log(`[analyze ${jobId}] cache HIT — copying result from ${prev.id}, skipping heavy work`);
            await jobStore.update(jobId, { status: "done", progress: 100, message: "Analysis complete (cached)", result: prev.result });
            return;
          }
        } catch (cacheErr) {
          console.warn(`[analyze ${jobId}] cache lookup failed, running fresh:`, cacheErr?.message);
        }
      }

      const duration = await probeDurationSec(filePath);

      // Optional: transcribe the movie first so Claude can ground the recap in
      // real dialogue/plot with accurate timestamps (whisper-1).
      let transcriptBlock = "";
      let transcriptSegments = [];
      if (useTranscript && openaiApiKey) {
        await jobStore.update(jobId, { progress: 8, message: "Transcribing audio (whisper-1)" });
        try {
          const transcript = await transcribeMovie({
            fileId,
            uploadsDir: UPLOADS_DIR,
            apiKey: openaiApiKey,
            language: typeof language === "string" && language.trim() ? language.trim() : undefined,
            // translate:true → Whisper /translations endpoint → any language to English.
            // Claude always needs English text; this also avoids crashes on non-Latin
            // scripts that can confuse the transcript parser downstream.
            translate: true,
            onProgress: (pct, message) => {
              // Map transcription progress into the 8–45% band of the analyze job.
              const mapped = 8 + Math.round((pct / 100) * 37);
              jobStore.update(jobId, { progress: mapped, message }).catch(() => {});
            },
          });
          transcriptBlock = buildTranscriptBlock(transcript);
          transcriptSegments = Array.isArray(transcript?.segments) ? transcript.segments : [];
        } catch (tErr) {
          // Transcript is the backbone of an accurate recap. If the caller asked
          // for it (key present) but it failed, FAIL LOUDLY instead of silently
          // building a wrong, frames-only story.
          console.error(`[analyze ${jobId}] transcription failed:`, tErr);
          throw new Error(`Transcription failed: ${String(tErr.message || tErr).slice(0, 160)}`);
        }
      } else if (useTranscript && !openaiApiKey) {
        throw new Error("Transcript grounding requested but no OpenAI key reached the server. Check Settings > OpenAI key.");
      }
      // Narration language: default English; if caller passed a language, narrate in it.
      const narrationLang = (typeof language === "string" && language.trim()) ? language.trim() : "English";

      // ---- HYBRID SCENE-AWARE ANALYSIS (v2.0) ------------------------------
      // Detect real scenes, extract one key frame per scene, fuse each scene
      // with its dialogue, then write ONE continuous character-consistent
      // story. Falls back to the legacy fixed-frame path if scene analysis
      // produces too few scenes or errors.
      const framesDir = path.join(UPLOADS_DIR, `frames-${jobId}`);
      // Scale scene count with movie length — ~1 scene per 40 seconds of film.
      //   90 min  (5 400s) → ~135 scenes
      //    2 hr   (7 200s) → ~180 scenes
      //  2.5 hr   (9 000s) → ~225 scenes
      //    3 hr   (10800s) → ~270 scenes
      // App-supplied targetClipCount is treated as a hint only; the duration-
      // scaled value wins whenever it is larger (prevents under-sampling long films
      // caused by the app sending a hard-coded 50).
      const durationScaled = duration > 0 ? Math.round(duration / 40) : 150;
      const appHint = effectiveTargetClipCount || Number(frameBudget) || 0;
      const targetScenes = Math.max(60, Math.min(350, Math.max(durationScaled, appHint)));
      console.log(`[analyze ${jobId}] beat target: ${effectiveTargetClipCount} (targetMinutes=${analyzeTargetMinutes || 'unset'})`);
      // Use the effective key+model (server override wins over app values).
      const claudeApiKey   = effectiveAnthropicKey;
      const claudeModel    = effectiveAnthropicModel;
      let parsed = null;
      try {
        await jobStore.update(jobId, { progress: 48, message: "Detecting scenes" });
        const { scenes, duration: sceneDuration } = await analyzeScenes(filePath, {
          outDir: framesDir,
          targetCount: targetScenes,
          maxClipSeconds: Number(maxClipSeconds) || 10,
          threshold: SCENE_THRESHOLD,
          keyframeWidth: 512,
          onProgress: (pct, message) => {
            // Map scene analysis into the 48–68% band.
            const mapped = 48 + Math.round((pct / 100) * 20);
            jobStore.update(jobId, { progress: mapped, message }).catch(() => {});
          },
        });
        // sceneDuration is max(container header, actual scan end) — reliable even
        // when yt-dlp produced an HLS-merged MP4 with a wrong moov duration.
        const effectiveDuration = (sceneDuration > 0) ? sceneDuration : duration;
        if (!scenes || scenes.length < 6) throw new Error(`only ${scenes ? scenes.length : 0} scenes detected`);
        await jobStore.update(jobId, { progress: 70, message: `Analyzing ${scenes.length} scenes with Claude` });
        const scenesB64 = [];
        for (const sc of scenes) {
          // Multi-frame support: load all FRAMES_PER_SCENE base64 frames when available.
          // Falls back to single midpoint frame (sc.framePath) for backward compat.
          if (Array.isArray(sc.framePaths) && sc.framePaths.length > 0) {
            const frameBase64s = [];
            for (const fp of sc.framePaths) {
              try { frameBase64s.push(await frameToBase64(fp)); } catch { /* skip failed frames */ }
            }
            // base64 = midpoint frame for legacy consumers; frameBase64s = all frames for Claude.
            const midBase64 = frameBase64s[Math.floor(frameBase64s.length / 2)] || "";
            scenesB64.push({ ...sc, base64: midBase64, frameBase64s });
          } else {
            scenesB64.push({ ...sc, base64: await frameToBase64(sc.framePath) });
          }
        }

        // Write CLIP frame metadata so render can use correct per-scene timestamps.
        // One midpoint frame per scene (framePath). Render reads this file instead
        // of reconstructing timestamps with the wrong even-spacing formula.
        // Without this file, CLIP embeds frames at wrong timestamps (e.g. frame #372
        // at 8s spacing instead of actual 3050s), the ±15% radius check fails, and
        // zero corrections are applied — CLIP silently does nothing every render.
        try {
          const _clipMeta = scenes
            .filter(sc => sc.framePath)
            .map(sc => ({
              file: path.basename(sc.framePath),
              timeSec: (Number(sc.startSec) + Number(sc.endSec)) / 2,
            }));
          await fs.writeFile(
            path.join(framesDir, 'clip-metadata.json'),
            JSON.stringify(_clipMeta),
            'utf8'
          );
          console.log(`[analyze ${jobId}] CLIP metadata: ${_clipMeta.length} scene midpoint frames timestamped`);
        } catch (_cmErr) {
          console.warn(`[analyze ${jobId}] CLIP metadata write failed (non-fatal):`, _cmErr?.message);
        }

        parsed = await analyzeWithScenes({
          apiKey: claudeApiKey,
          model: claudeModel,
          movie: { ...movie, durationSec: effectiveDuration },
          channelName: channelName || "Plotline Panic",
          scenes: scenesB64,
          segments: transcriptSegments,
          transcriptBlock,
          narrationLang,
          targetClipCount: effectiveTargetClipCount,
        });
        await jobStore.update(jobId, { progress: 90, message: `Scene analysis complete (${scenes.length} scenes, ${parsed.characters?.length || 0} characters)` });
      } catch (sceneErr) {
        console.error(`[analyze ${jobId}] scene analysis failed, falling back to fixed frames:`, sceneErr);
        await jobStore.update(jobId, { progress: 50, message: `Scene mode unavailable (${String(sceneErr.message || sceneErr).slice(0, 60)}); using frames` });
        const targetFrames = Math.max(8, Math.min(140, Number(frameBudget) || 60));
        const { frames } = await extractFrames({ filePath, outDir: framesDir, count: targetFrames });
        await jobStore.update(jobId, { progress: 60, message: `Sending ${frames.length} frames to Claude` });
        const withBase64 = [];
        for (const f of frames) withBase64.push({ ...f, base64: await frameToBase64(f.path) });
        parsed = await callClaudeWithFrameBatching({
          apiKey: claudeApiKey,
          model: claudeModel,
          frames: withBase64,
          movie: { ...movie, durationSec: duration },
          channelName: channelName || "Plotline Panic",
          maxClipSeconds: maxClipSeconds,
          targetClipCount: effectiveTargetClipCount,
          transcriptBlock,
        });
        await jobStore.update(jobId, { progress: 90, message: "Parsing response" });
      }
      // Defensive clamp: enforce max clip duration even if Claude ignored it.
      if (Number.isFinite(maxClipSeconds) && maxClipSeconds > 0) {
        const before = parsed.timestamps.length;
        parsed.timestamps = enforceMaxClipDurationServer(parsed.timestamps, maxClipSeconds);
        if (parsed.timestamps.length !== before) {
          await jobStore.update(jobId, { message: `Trimmed clips to ≤ ${maxClipSeconds}s (${before} → ${parsed.timestamps.length})` });
        }
      }

      // Frames directory is intentionally kept on disk after analyze completes.
      // The render step needs frames-{jobId}/ to run CLIP semantic matching,
      // which replaces Claude's transcript-based timestamp guesses with visually-
      // grounded scene windows. Deleting them here broke CLIP for every render.

      // ── HOOK GENERATION ─────────────────────────────────────────────────────
      // Generate a 50-80 word YouTube attention hook from the beat narrations.
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
                  // Convert each returned position to the beat's actual scene index.
                  // This prevents the render from resolving hookSceneId=2 to FFmpeg
                  // scene #2 (~60 s credits) instead of story beat #2.
                  const rawIds = _hj.hookSceneIds.map(Number).filter(Number.isFinite);
                  _hookSceneIds = rawIds.map(pos => {
                    if (pos >= 1 && pos <= _hookBeats.length) {
                      return _hookBeats[pos - 1]?.index ?? pos;
                    }
                    return pos; // already a scene index if larger than beat count
                  }).filter(Number.isFinite);
                }
              } else {
                // Model returned plain text despite instructions — use as-is.
                _hookText = _hookRaw;
              }
            } catch {
              _hookText = _hookRaw;
            }
          }
          if (_hookText) {
            console.log(`[analyze ${jobId}] HOOK: generated ${_hookText.split(/\s+/).filter(Boolean).length} words, hookSceneIds=[${_hookSceneIds.join(",")}]`);
          }
        } catch (hookErr) {
          console.warn(`[analyze ${jobId}] hook generation skipped (non-fatal):`, hookErr?.message || hookErr);
        }
      }
      // ── END HOOK GENERATION ──────────────────────────────────────────────────

      // ── YOUTUBE METADATA GENERATION ─────────────────────────────────────────
      // Claude Haiku generates story-based title, description, and tags.
      // Title style: tabloid/narrative hook — "A Bullied Boy's Brutal Revenge"
      // NOT "Movie Recap" or the film's own title.
      let _ytTitle = null, _ytDescription = null, _ytTags = null, _ytMovieTitle = null;
      if (_hookBeats.length >= 3 && claudeApiKey) {
        try {
          const _beatSummary = _hookBeats
            .slice(0, 30)
            .map((b, i) => `${i + 1}. ${String(b.narration || b.reason || "").trim().slice(0, 120)}`)
            .join("\n");
          const _beatCount2 = Math.min(_hookBeats.length, 30);
          const _estMins2 = Math.max(4, Math.round(_beatCount2 * 0.5));

          const _ytPrompt =
`You generate YouTube metadata for the channel "SuperShortSummary". Use ONLY the story beats below — do NOT add invented information.

Story beats (${_beatCount2} total, estimated video length: ${_estMins2}–${_estMins2 + 2} minutes):
${_beatSummary}

Return valid JSON ONLY — no prose, no markdown fences:
{
  "youtubeTitle": "<max 60 chars — TABLOID SHOCK HOOK. Two patterns: (A) VILLAIN/THREAT + brutal verb + innocent victim — e.g. 'Thugs Brutally Kill an Ordinary Clerk\\'s Son', 'Gang Forces an Innocent Girl to Choose Death', 'Racist Bullies Target the Wrong Quiet Old Man', 'Corrupt Cops Frame a Helpless Man for Murder'. (B) ALL-CAPS flaw/emotion + person + self-destructive action — e.g. 'OBSESSED Man Ruins His Body and Family', 'DESPERATE Father Crosses Every Line to Save His Son'. STRONG VERBS: Kill, Murder, Destroy, Betray, Hunt, Ruin, Beat, Force, Crush, Frame, Torture. VICTIM ADJECTIVES: Ordinary, Innocent, Helpless, Quiet, Simple, Poor. NEVER use: recap, review, analysis, breakdown, explained. NEVER reveal who wins or the ending.>",
  "movieTitle": "<full movie name and year, e.g. Magazine Dreams (2023). Infer from the story content. If unknown write 'Unknown Movie'>",
  "storySummary": "<2–3 sentences. Introduce the hero and their world, the conflict that shatters it, and the impossible stakes. Storytelling voice — NOT a review. Do NOT mention 'this video' or 'this recap'.>",
  "cast": ["<Actor Name (as Character Name)>", "<Actor Name>"],
  "directorWriter": "<Director full name>",
  "chapters": ["0:00 <Chapter 1 title>", "<M:SS> <Chapter 2 title>", "<M:SS> <Chapter 3 title>", "<M:SS> <Chapter 4 title>", "<M:SS> <Chapter 5 title>", "<M:SS> <Chapter 6 title>"],
  "movieTags": ["<6–10 movie-specific tags only — actor names, character names, director name, movie title words, genre, mood. Lowercase. No # prefix.>"]
}

For cast and directorWriter: use your training knowledge of the movie. If unknown, write an empty array / empty string.
Timestamps in chapters must be evenly spaced across the ${_estMins2}-minute estimated duration.`;

          const _ytRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json",
              "x-api-key": claudeApiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1400,
              messages: [{ role: "user", content: _ytPrompt }] }),
            signal: AbortSignal.timeout(25_000),
          });
          const _ytData = await _ytRes.json();
          const _ytRaw = _ytData?.content?.[0]?.text?.trim() || null;
          if (_ytRaw) {
            const _fence = _ytRaw.match(/```(?:json)?\s*([\s\S]+?)```/);
            const _src = _fence ? _fence[1].trim() : _ytRaw;
            const _yt = JSON.parse(_src);
            if (typeof _yt?.youtubeTitle === "string" && _yt.youtubeTitle.trim()) {
              _ytTitle = _yt.youtubeTitle.trim().slice(0, 100);
            }
            if (typeof _yt?.movieTitle === "string" && _yt.movieTitle.trim()) {
              _ytMovieTitle = _yt.movieTitle.trim();
            }
            _ytDescription = buildSSSDescription({
              movieTitle: _yt.movieTitle,
              storySummary: _yt.storySummary,
              cast: _yt.cast,
              directorWriter: _yt.directorWriter,
              chapters: _yt.chapters,
            });
            const _movieTags = Array.isArray(_yt?.movieTags) ? _yt.movieTags.map(String).slice(0, 15) : [];
            _ytTags = [...MASTER_TAGS, ..._movieTags];
          }
          if (_ytTitle) {
            console.log(`[analyze ${jobId}] YT metadata: "${_ytTitle}" | ${(_ytTags || []).length} tags`);
          }
        } catch (ytErr) {
          console.warn(`[analyze ${jobId}] YouTube metadata skipped (non-fatal):`, ytErr?.message || ytErr);
        }
      }
      // ── END YOUTUBE METADATA GENERATION ─────────────────────────────────────

      await jobStore.update(jobId, {
        status: "done",
        progress: 100,
        message: "Analysis complete",
        result: {
          duration, sourceFileId: fileId, ...parsed,
          ...(_hookText ? { hookText: _hookText } : {}),
          ...(_hookSceneIds && _hookSceneIds.length > 0 ? { hookSceneIds: _hookSceneIds } : {}),
          ...(_ytTitle ? { youtubeTitle: _ytTitle } : {}),
          ...(_ytMovieTitle ? { movieTitle: _ytMovieTitle } : {}),
          ...(_ytDescription ? { youtubeDescription: _ytDescription } : {}),
          ...(_ytTags && _ytTags.length > 0 ? { youtubeTags: _ytTags } : {}),
        },
      });
    } catch (err) {
      console.error(`[analyze ${jobId}]`, err);
      await jobStore.update(jobId, { status: "failed", message: String(err.message || err) });
    }
  })();

  res.json({ jobId });
});

/* ---------- /render-from-ingest: trim + concat directly from a cached source ---------- */
app.post("/render-from-ingest", requireAuth, async (req, res) => {
  const {
    fileId,
    timestamps,
    voiceoverFileId,
    voiceoverFileIds,    // new — array of MP3 chunks to concat
    musicFileId,         // new — single MP3 to mix in (uploaded file)
    musicMood,           // new — name of a built-in mood bed in /data/music
    subtitlesSrt,        // new — raw .srt content to burn into video
    musicVolumeDb,       // new — optional, defaults to -14 dB
    beats,               // v2.2 — Option B: [{ startSec, endSec, narration, mood }] in narration order
    sceneAdaptiveMusic,  // v2.2 — when true + beats present, switch music mood per scene span
    analyzeJobId,        // v2.7 — ID of the analyze job whose frames CLIP should search
    settings,
  } = req.body || {};
  if (!fileId) return res.status(400).json({ error: "fileId required" });
  if (!Array.isArray(timestamps) || timestamps.length === 0) {
    return res.status(400).json({ error: "timestamps required" });
  }
  const sourcePath = path.join(UPLOADS_DIR, fileId);
  try { await fs.access(sourcePath); } catch { return res.status(404).json({ error: "fileId not found" }); }

  // Resolve voiceover file IDs into a list. Both legacy single-id and new
  // array form are accepted; the array wins when both are provided.
  const voiceIds = Array.isArray(voiceoverFileIds) && voiceoverFileIds.length > 0
    ? voiceoverFileIds
    : (voiceoverFileId ? [voiceoverFileId] : []);
  for (const id of voiceIds) {
    try { await fs.access(path.join(UPLOADS_DIR, id)); }
    catch { return res.status(400).json({ error: `Missing voiceover: ${id}` }); }
  }
  if (musicFileId) {
    try { await fs.access(path.join(UPLOADS_DIR, musicFileId)); }
    catch { return res.status(400).json({ error: `Missing music: ${musicFileId}` }); }
  }
  // Resolve a built-in mood bed (no upload needed). Sanitise the mood name to a
  // bare filename so it can never escape /data/music.
  let resolvedMusicPath = null;
  if (!musicFileId && typeof musicMood === "string" && musicMood.trim()) {
    const safe = musicMood.trim().toLowerCase().replace(/[^a-z]/g, "");
    const candidate = path.join(MUSIC_DIR, `${safe}.mp3`);
    try { await fs.access(candidate); resolvedMusicPath = candidate; }
    catch { return res.status(400).json({ error: `Unknown music mood: ${musicMood}` }); }
  }

  const jobId = nanoid(10);
  const normalised = normaliseRenderSettings(settings || {});
  await jobStore.create(jobId, {
    status: "queued",
    progress: 0,
    message: "Queued",
    kind: "render",
    sourceFileId: fileId,
    voiceoverFileIds: voiceIds,
    musicFileId: musicFileId || null,
    hasSubtitles: typeof subtitlesSrt === "string" && subtitlesSrt.trim().length > 0,
    timestamps,
    settings: normalised,
  });

  withAutoRetry(jobId, "render", () => runRenderFromIngest(jobId, {
    sourcePath,
    timestamps,
    voiceoverFileIds: voiceIds,
    musicFileId: musicFileId || null,
    musicPathOverride: resolvedMusicPath,
    subtitlesSrt: typeof subtitlesSrt === "string" ? subtitlesSrt : "",
    musicVolumeDb,
    beats: Array.isArray(beats) ? beats : null,
    sceneAdaptiveMusic: sceneAdaptiveMusic !== false, // default ON when beats present
    analyzeJobId: typeof analyzeJobId === "string" && analyzeJobId.trim() ? analyzeJobId.trim() : null,
    settings: normalised,
  })).catch(() => {});

  res.json({ jobId });
});

// Disable the 30-s global socket timeout for large multipart uploads so a
// 2-4 GB movie file doesn't get cut off mid-stream.
app.post("/upload", requireAuth, (req, _res, next) => { req.socket.setTimeout(0); next(); }, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const role = String(req.query.role || "clip");
  const ext = path.extname(req.file.originalname || "").toLowerCase() || (role === "voiceover" ? ".mp3" : ".mp4");
  const fileId = `${role}-${nanoid(12)}${ext}`;
  const finalPath = path.join(UPLOADS_DIR, fileId);
  await fs.rename(req.file.path, finalPath);
  res.json({ fileId, role, size: req.file.size, path: finalPath });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Resumable chunked movie upload
 *
 * Why: a 2-4 GB MKV from a mobile device on a variable connection (home wifi,
 * 4G) can take 10-30 min. A single-shot multipart upload has no resume support
 * so any brief interruption forces a full restart. The chunked protocol lets
 * the app retry individual 50 MB chunks and resume from where it left off.
 *
 * Protocol:
 *   POST /upload/movie/init               { fileName, fileSize, mimeType? }
 *     → { uploadId, fileId }             — creates staging file
 *
 *   PUT  /upload/movie/:id/chunk          binary body
 *     Header: Content-Range: bytes start-end/total
 *     → { received }                     — bytes written so far
 *
 *   GET  /upload/movie/:id/status
 *     → { received, total, complete }    — for resume (find start offset)
 *
 *   POST /upload/movie/:id/complete
 *     → { fileId }                       — moves file to uploads/, ready for /analyze
 * ─────────────────────────────────────────────────────────────────────────────*/

/** Read raw binary body from a request stream. */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

app.post("/upload/movie/init", requireAuth, async (req, res) => {
  const { fileName, fileSize, mimeType } = req.body || {};
  if (!fileName || !Number.isFinite(Number(fileSize)) || Number(fileSize) <= 0) {
    return res.status(400).json({ error: "fileName and fileSize (bytes) are required" });
  }
  const total = Number(fileSize);
  const uploadId = nanoid(16);
  const ext = path.extname(String(fileName)).toLowerCase() || ".mkv";
  const fileId = `movie-${nanoid(12)}${ext}`;
  const stagingDir = path.join(CHUNKS_DIR, uploadId);
  await fs.mkdir(stagingDir, { recursive: true });
  // Pre-create the destination file at full size so random-offset writes work.
  const stagingFile = path.join(stagingDir, "data");
  const fd = await fs.open(stagingFile, "w");
  await fd.truncate(total);
  await fd.close();
  // Write manifest.
  await fs.writeFile(
    path.join(stagingDir, "manifest.json"),
    JSON.stringify({ fileName, fileSize: total, mimeType: mimeType || "video/x-matroska", fileId, uploadId, received: 0, complete: false, createdAt: Date.now() }),
  );
  console.log(`[upload/movie] init uploadId=${uploadId} fileId=${fileId} size=${(total / 1e9).toFixed(2)}GB`);
  res.json({ uploadId, fileId });
});

app.put("/upload/movie/:uploadId/chunk", requireAuth, (req, _res, next) => { req.socket.setTimeout(0); next(); }, async (req, res) => {
  const { uploadId } = req.params;
  const stagingDir = path.join(CHUNKS_DIR, uploadId);
  const manifestPath = path.join(stagingDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return res.status(404).json({ error: "Upload session not found. Call /upload/movie/init first." });
  }
  if (manifest.complete) return res.status(409).json({ error: "Upload already completed." });

  // Parse Content-Range: bytes start-end/total
  const rangeHeader = req.headers["content-range"] || "";
  const match = rangeHeader.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return res.status(400).json({ error: "Content-Range header required: bytes start-end/total" });
  const start = Number(match[1]);
  const end   = Number(match[2]);
  const total = Number(match[3]);
  if (total !== manifest.fileSize) return res.status(400).json({ error: "total in Content-Range doesn't match init fileSize" });
  if (end < start || end >= total) return res.status(400).json({ error: "Invalid Content-Range range" });

  const chunkBuf = await readRawBody(req);
  const expectedLen = end - start + 1;
  if (chunkBuf.length !== expectedLen) {
    return res.status(400).json({ error: `Body length ${chunkBuf.length} doesn't match range length ${expectedLen}` });
  }

  // Write chunk at the correct offset in the staging file.
  const stagingFile = path.join(stagingDir, "data");
  const fd = await fs.open(stagingFile, "r+");
  try {
    await fd.write(chunkBuf, 0, chunkBuf.length, start);
  } finally {
    await fd.close();
  }

  // Update received bytes to the highest byte written + 1.
  const received = Math.max(manifest.received, end + 1);
  manifest.received = received;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  res.json({ received, total });
});

app.get("/upload/movie/:uploadId/status", requireAuth, async (req, res) => {
  const { uploadId } = req.params;
  const manifestPath = path.join(CHUNKS_DIR, uploadId, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return res.status(404).json({ error: "Upload session not found." });
  }
  res.json({ uploadId, fileId: manifest.fileId, received: manifest.received, total: manifest.fileSize, complete: manifest.complete });
});

app.post("/upload/movie/:uploadId/complete", requireAuth, async (req, res) => {
  const { uploadId } = req.params;
  const stagingDir = path.join(CHUNKS_DIR, uploadId);
  const manifestPath = path.join(stagingDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return res.status(404).json({ error: "Upload session not found." });
  }
  if (manifest.complete) return res.json({ fileId: manifest.fileId }); // idempotent
  if (manifest.received < manifest.fileSize) {
    return res.status(409).json({ error: `Upload incomplete: ${manifest.received}/${manifest.fileSize} bytes received. Keep sending chunks.` });
  }
  // Move staging file to the uploads directory.
  const stagingFile = path.join(stagingDir, "data");
  const finalPath = path.join(UPLOADS_DIR, manifest.fileId);
  await fs.rename(stagingFile, finalPath);
  manifest.complete = true;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  console.log(`[upload/movie] complete fileId=${manifest.fileId} size=${(manifest.fileSize / 1e9).toFixed(2)}GB`);
  res.json({ fileId: manifest.fileId, size: manifest.fileSize });
});

app.post("/render", requireAuth, async (req, res) => {
  const { clipFileIds, voiceoverFileId, settings } = req.body || {};
  if (!Array.isArray(clipFileIds) || clipFileIds.length === 0) {
    return res.status(400).json({ error: "clipFileIds is required" });
  }
  // Validate that each file actually exists in uploads/
  for (const id of clipFileIds) {
    const p = path.join(UPLOADS_DIR, id);
    try { await fs.access(p); } catch { return res.status(400).json({ error: `Missing clip: ${id}` }); }
  }
  if (voiceoverFileId) {
    try { await fs.access(path.join(UPLOADS_DIR, voiceoverFileId)); }
    catch { return res.status(400).json({ error: `Missing voiceover: ${voiceoverFileId}` }); }
  }

  const jobId = nanoid(10);
  const normalised = normaliseRenderSettings(settings || {});
  await jobStore.create(jobId, {
    status: "queued",
    progress: 0,
    message: "Queued",
    settings: normalised,
    clipFileIds,
    voiceoverFileId: voiceoverFileId || null,
  });

  // Fire-and-forget: run render in background (with one automatic retry).
  withAutoRetry(jobId, "render", () =>
    runRender(jobId, { clipFileIds, voiceoverFileId, settings: normalised })
  ).catch(() => {});

  res.json({ jobId });
});

app.get("/jobs/:jobId", requireAuth, async (req, res) => {
  const job = await jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * GET /history
 * List all jobs (render + analyze) with file sizes and metadata.
 * Used by the app History tab to show every movie processed on this server.
 * ───────────────────────────────────────────────────────────────────────────── */
app.get("/history", requireAuth, async (req, res) => {
  try {
    const all = await jobStore.list();

    const fileSizeMb = async (p) => {
      if (!p) return null;
      try { return Math.round((await fs.stat(p)).size / 1024 / 1024 * 10) / 10; }
      catch { return null; }
    };

    const items = await Promise.all(all.map(async (job) => {
      const sourceId = job.sourceFileId || job.result?.sourceFileId || null;
      const sourcePath = sourceId ? path.join(UPLOADS_DIR, sourceId) : null;

      // Frames directory size (sum all JPEG frames)
      let framesSizeMb = null;
      const framesDir = path.join(UPLOADS_DIR, `frames-${job.id}`);
      try {
        const frameFiles = await fs.readdir(framesDir);
        let total = 0;
        for (const f of frameFiles) {
          try { total += (await fs.stat(path.join(framesDir, f))).size; } catch {}
        }
        framesSizeMb = Math.round(total / 1024 / 1024 * 10) / 10;
      } catch {}

      const sourceSizeMb = await fileSizeMb(sourcePath);
      const outputSizeMb = await fileSizeMb(job.outputPath);
      const totalSizeMb = Math.round(
        ([sourceSizeMb, outputSizeMb, framesSizeMb].filter(v => v !== null).reduce((a, b) => a + b, 0)) * 10
      ) / 10;

      return {
        id:           job.id,
        kind:         job.kind || "render",
        status:       job.status,
        progress:     job.progress,
        message:      job.message,
        createdAt:    job.createdAt,
        updatedAt:    job.updatedAt,
        sourceFileId: sourceId,
        sourceSizeMb,
        outputSizeMb,
        framesSizeMb,
        totalSizeMb:  totalSizeMb || null,
        hasOutput:    !!(job.outputPath),
        hasPoster:    !!(job.posterPath),
        movieTitle:   job.result?.title || job.settings?.channelName || null,
        beatCount:    Array.isArray(job.result?.beats) ? job.result.beats.length : null,
        syncScore:    job.syncScore || null,
        downloadUrl:  job.outputPath ? `/jobs/${job.id}/download` : null,
        posterUrl:    job.posterPath ? `/jobs/${job.id}/poster` : null,
      };
    }));

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETE /history/:jobId
 * Delete a job and ALL its associated server files:
 *   - rendered output video
 *   - poster / AI thumbnails
 *   - extracted frame JPEGs (frames-{jobId}/ directory)
 *   - per-beat TTS audio clips
 *   - source movie file (only when no other job still references it)
 *   - job JSON record
 * Returns { deleted: string[], errors: string[], jobId }
 * ───────────────────────────────────────────────────────────────────────────── */
app.delete("/history/:jobId", requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const job = await jobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Not found" });

  const deleted = [];
  const errors  = [];

  const tryDelete = async (p, label) => {
    if (!p) return;
    try { await fs.unlink(p); deleted.push(label); }
    catch (e) { if (e.code !== "ENOENT") errors.push(`${label}: ${e.message}`); }
  };

  const tryDeleteDir = async (p, label) => {
    if (!p) return;
    try { await fs.rm(p, { recursive: true, force: true }); deleted.push(label); }
    catch (e) { if (e.code !== "ENOENT") errors.push(`${label}: ${e.message}`); }
  };

  // 1. Output video
  await tryDelete(job.outputPath, "output_video");

  // 2. Poster (stored path + conventional path)
  await tryDelete(job.posterPath, "poster");
  await tryDelete(path.join(OUTPUT_DIR, `recap-${jobId}.jpg`), "poster_conventional");

  // 3. AI thumbnails (thumb-{jobId}-*.jpg)
  try {
    for (const f of await fs.readdir(OUTPUT_DIR)) {
      if (f.startsWith(`thumb-${jobId}-`)) {
        await tryDelete(path.join(OUTPUT_DIR, f), `thumb_${f}`);
      }
    }
  } catch {}

  // 4. Extracted frames directory
  await tryDeleteDir(path.join(UPLOADS_DIR, `frames-${jobId}`), "frames_dir");

  // 5. Per-beat TTS audio clips
  for (const id of (Array.isArray(job.voiceoverFileIds) ? job.voiceoverFileIds : [])) {
    await tryDelete(path.join(UPLOADS_DIR, id), `voice_${id}`);
  }

  // 6. Source movie — only if no other job still references it
  const sourceId = job.sourceFileId || job.result?.sourceFileId;
  if (sourceId) {
    const all = await jobStore.list();
    const otherRefs = all.filter(
      j => j.id !== jobId &&
           (j.sourceFileId === sourceId || j.result?.sourceFileId === sourceId)
    );
    if (otherRefs.length === 0) {
      await tryDelete(path.join(UPLOADS_DIR, sourceId), "source_movie");
    } else {
      deleted.push(`source_movie_kept (${otherRefs.length} other job(s) still reference it)`);
    }
  }

  // 7. Job JSON record (last — so recovery is possible if earlier steps fail)
  try {
    await fs.unlink(jobStore.jobPath(jobId));
    deleted.push("job_record");
  } catch (e) {
    if (e.code !== "ENOENT") errors.push(`job_record: ${e.message}`);
  }

  res.json({ deleted, errors, jobId });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * GET /system/storage
 * Disk-usage snapshot: total / used / free disk, size of uploads (cached source
 * movies) and output (renders), plus a file list of /data/output/ entries.
 * Used by the History tab storage panel.
 * ───────────────────────────────────────────────────────────────────────────── */
app.get("/system/storage", requireAuth, async (req, res) => {
  try {
    const sf = await fs.statfs("/");
    const totalBytes = sf.bsize * sf.blocks;
    const freeBytes  = sf.bsize * sf.bfree;
    const usedBytes  = totalBytes - freeBytes;

    const dirSize = async (dir) => {
      let bytes = 0; let count = 0;
      try {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          const fp = path.join(dir, e.name);
          if (e.isFile()) { try { bytes += (await fs.stat(fp)).size; count++; } catch {} }
          else if (e.isDirectory()) { const s = await dirSize(fp); bytes += s.bytes; count += s.count; }
        }
      } catch {}
      return { bytes, count };
    };

    const [uploadsStats, outputStats] = await Promise.all([
      dirSize(UPLOADS_DIR),
      dirSize(OUTPUT_DIR),
    ]);

    let outputFiles = [];
    try {
      const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
      const mapped = await Promise.all(entries.filter(e => e.isFile()).map(async (e) => {
        const s = await fs.stat(path.join(OUTPUT_DIR, e.name)).catch(() => null);
        return s ? { name: e.name, bytes: s.size, modifiedAt: s.mtime.toISOString() } : null;
      }));
      outputFiles = mapped.filter(Boolean).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    } catch {}

    res.json({
      disk: { totalBytes, usedBytes, freeBytes, usedPercent: Math.round((usedBytes / totalBytes) * 100) },
      uploads: { bytes: uploadsStats.bytes, fileCount: uploadsStats.count, label: "Cached source movies" },
      output:  { bytes: outputStats.bytes,  fileCount: outputStats.count,  label: "Render outputs (MP4s, posters)" },
      outputFiles,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETE /system/clear-renders
 * Free disk space by deleting render artefacts and/or cached source movies.
 *
 * Query param ?mode=
 *   renders  (default) — delete /data/output/* and per-job frames-{id}/ dirs
 *   uploads  — delete cached source movies not in use by a running/queued job
 *   all      — both of the above
 *
 * Returns { deleted: number, freedBytes: number, errors: string[] }
 * ───────────────────────────────────────────────────────────────────────────── */
app.delete("/system/clear-renders", requireAuth, async (req, res) => {
  const mode = req.query.mode || "renders";
  let deleted = 0; let freedBytes = 0; const errors = [];

  const tryDel = async (p) => {
    try { const s = await fs.stat(p); await fs.unlink(p); deleted++; freedBytes += s.size; }
    catch (e) { if (e.code !== "ENOENT") errors.push(`${path.basename(p)}: ${e.message}`); }
  };

  const sizeOf = async (d) => {
    let t = 0;
    try {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isFile()) { try { t += (await fs.stat(fp)).size; } catch {} }
        else if (e.isDirectory()) t += await sizeOf(fp);
      }
    } catch {}
    return t;
  };

  if (mode === "renders" || mode === "all") {
    try {
      for (const f of await fs.readdir(OUTPUT_DIR)) await tryDel(path.join(OUTPUT_DIR, f));
    } catch (e) { errors.push(`output dir: ${e.message}`); }

    try {
      for (const e of await fs.readdir(UPLOADS_DIR, { withFileTypes: true })) {
        if (e.isDirectory() && e.name.startsWith("frames-")) {
          const dp = path.join(UPLOADS_DIR, e.name);
          try { freedBytes += await sizeOf(dp); await fs.rm(dp, { recursive: true, force: true }); deleted++; }
          catch (err) { errors.push(`${e.name}: ${err.message}`); }
        }
      }
    } catch (e) { errors.push(`frames scan: ${e.message}`); }
  }

  if (mode === "uploads" || mode === "all") {
    try {
      const jobs = await jobStore.list();
      const activeIds = new Set(
        jobs.filter(j => j.status === "running" || j.status === "queued")
            .map(j => j.sourceFileId || j.result?.sourceFileId).filter(Boolean)
      );
      for (const e of await fs.readdir(UPLOADS_DIR, { withFileTypes: true })) {
        if (!e.isFile() || activeIds.has(e.name)) continue;
        if (/\.(mp4|mkv|avi|mov|webm|mp3|m4a|flac)$/i.test(e.name))
          await tryDel(path.join(UPLOADS_DIR, e.name));
      }
    } catch (e) { errors.push(`uploads: ${e.message}`); }
  }

  res.json({ deleted, freedBytes, errors });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * GET /uploads/:fileId/download
 * Stream a cached source movie back to the client with HTTP range support.
 * Used by the History tab "Download source" button.
 * ───────────────────────────────────────────────────────────────────────────── */
app.get("/uploads/:fileId/download", requireAuth, async (req, res) => {
  const { fileId } = req.params;
  if (fileId.includes("..") || fileId.includes("/"))
    return res.status(400).json({ error: "Invalid fileId" });
  const filePath = path.join(UPLOADS_DIR, fileId);
  let stat;
  try { stat = await fs.stat(filePath); }
  catch { return res.status(404).json({ error: "File not found" }); }

  const mime = {
    ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
    ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4", ".flac": "audio/flac",
  }[path.extname(fileId).toLowerCase()] || "application/octet-stream";

  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="${fileId}"`);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=60");

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end   = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size)
        return res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      res.status(206)
        .setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`)
        .setHeader("Content-Length", end - start + 1);
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }
  res.setHeader("Content-Length", stat.size);
  createReadStream(filePath).pipe(res);
});

app.get("/jobs/:jobId/download", requireAuth, async (req, res) => {
  const job = await jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.status !== "done" || !job.outputPath) {
    return res.status(409).json({ error: "Not ready" });
  }
  // Stream the MP4 with HTTP range support so expo-video / ExoPlayer can
  // start playback before the whole file is downloaded. Use `inline`
  // disposition (NOT `attachment`) — Android players treat `attachment` as
  // a download hint and refuse to render in-line.
  let stat;
  try {
    stat = await fs.stat(job.outputPath);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `inline; filename="${path.basename(job.outputPath)}"`);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=60");

  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
        res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
        return;
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      res.setHeader("Content-Length", String(chunkSize));
      createReadStream(job.outputPath, { start, end }).pipe(res);
      return;
    }
  }
  res.setHeader("Content-Length", String(stat.size));
  createReadStream(job.outputPath).pipe(res);
});

/* ---------- /jobs/:jobId/poster: serve the generated thumbnail JPG ---------- */
app.get("/jobs/:jobId/poster", requireAuth, async (req, res) => {
  const job = await jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  // Prefer the stored poster path; fall back to the conventional name.
  const posterPath = job.posterPath || path.join(OUTPUT_DIR, `recap-${req.params.jobId}.jpg`);
  let stat;
  try {
    stat = await fs.stat(posterPath);
  } catch {
    return res.status(404).json({ error: "No poster" });
  }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "private, max-age=86400");
  createReadStream(posterPath).pipe(res);
});

app.post("/jobs/:jobId/youtube", requireAuth, async (req, res) => {
  const job = await jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Not found" });
  if (job.status !== "done" || !job.outputPath) return res.status(409).json({ error: "Not ready" });
  const { title, description, tags, privacyStatus } = req.body || {};
  try {
    const result = await uploadToYouTube({
      filePath: job.outputPath,
      title: title || `Movie Recap — ${req.params.jobId}`,
      description: description || "",
      tags: Array.isArray(tags) ? tags : [],
      privacyStatus: privacyStatus || "unlisted",
    });
    await jobStore.update(req.params.jobId, {
      youtube: {
        videoId: result.videoId,
        url: `https://youtu.be/${result.videoId}`,
        uploadedAt: Date.now(),
      },
    });
    res.json({ videoId: result.videoId, url: `https://youtu.be/${result.videoId}` });
  } catch (err) {
    console.error(`[youtube ${req.params.jobId}]`, err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/* ---------- YouTube OAuth flow (browser-based, no SSH needed) ----------
 * GET  /youtube/status               auth, { connected: bool, channel?: string }
 * GET  /youtube/auth-url             auth, { url } — open in browser to grant access
 * GET  /youtube/callback             public (Google redirect) — captures the refresh
 *                                    token and persists it to the token store.
 * The redirect URI is `${PUBLIC_URL}/youtube/callback` and MUST be added as an
 * authorised redirect URI in the Google Cloud OAuth client.
 */
const YT_TOKEN_PATH = path.join(STORAGE_DIR, "youtube-token.json");
const YT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

function ytRedirectUri() {
  const base = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  return base ? `${base}/youtube/callback` : null;
}

async function loadYtRefreshToken() {
  // Env var wins (set-and-forget); otherwise read the persisted token file.
  if (process.env.YT_REFRESH_TOKEN) return process.env.YT_REFRESH_TOKEN;
  try {
    const raw = await fs.readFile(YT_TOKEN_PATH, "utf8");
    return JSON.parse(raw).refresh_token || null;
  } catch {
    return null;
  }
}

app.get("/youtube/status", requireAuth, async (_req, res) => {
  const clientId = process.env.YT_CLIENT_ID;
  const clientSecret = process.env.YT_CLIENT_SECRET;
  const refreshToken = await loadYtRefreshToken();
  if (!clientId || !clientSecret) {
    return res.json({ connected: false, configured: false, reason: "Missing YT_CLIENT_ID/SECRET on server" });
  }
  if (!refreshToken) return res.json({ connected: false, configured: true });
  try {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, ytRedirectUri() || undefined);
    oauth2.setCredentials({ refresh_token: refreshToken });
    const yt = google.youtube({ version: "v3", auth: oauth2 });
    const me = await yt.channels.list({ part: ["snippet"], mine: true });
    const channel = me.data.items?.[0]?.snippet?.title || "YouTube channel";
    res.json({ connected: true, configured: true, channel });
  } catch (err) {
    res.json({ connected: true, configured: true, channel: null, warn: String(err.message || err) });
  }
});

app.get("/youtube/auth-url", requireAuth, async (_req, res) => {
  const clientId = process.env.YT_CLIENT_ID;
  const clientSecret = process.env.YT_CLIENT_SECRET;
  const redirectUri = ytRedirectUri();
  if (!clientId || !clientSecret) return res.status(400).json({ error: "Server missing YT_CLIENT_ID/YT_CLIENT_SECRET" });
  if (!redirectUri) return res.status(400).json({ error: "Server missing PUBLIC_URL for redirect" });
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const url = oauth2.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: YT_SCOPES });
  res.json({ url, redirectUri });
});

app.get("/youtube/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const clientId = process.env.YT_CLIENT_ID;
  const clientSecret = process.env.YT_CLIENT_SECRET;
  const redirectUri = ytRedirectUri();
  if (!code) return res.status(400).send("Missing code");
  if (!clientId || !clientSecret || !redirectUri) return res.status(400).send("Server OAuth not configured");
  try {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send("No refresh token returned. Revoke access at https://myaccount.google.com/permissions and try Connect again.");
    }
    await fs.writeFile(YT_TOKEN_PATH, JSON.stringify({ refresh_token: tokens.refresh_token, savedAt: Date.now() }), "utf8");
    res.setHeader("Content-Type", "text/html");
    res.send("<html><body style='font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:80px'><h2>YouTube connected.</h2><p>You can close this tab and return to CineRecap Studio.</p></body></html>");
  } catch (err) {
    console.error("[youtube callback]", err);
    res.status(500).send("OAuth exchange failed: " + String(err.message || err));
  }
});

/* ---------- render worker ---------- */
/**
 * Run `fn` (an async thunk). If it throws, wait 3 s and run it once more.
 * On second failure mark the job as failed. Handles transient FFmpeg errors
 * (temp file races, occasional codec timeouts) without user intervention.
 */
async function withAutoRetry(jobId, label, fn) {
  try {
    await fn();
  } catch (firstErr) {
    const msg = String(firstErr?.message || firstErr).slice(0, 200);
    console.warn(`[${label} ${jobId}] attempt 1 failed: ${msg} — retrying in 3 s`);
    console.warn(`[${label} ${jobId}] stack: ${firstErr?.stack?.split('\n').slice(0,4).join(' | ')}`);
    try {
      await jobStore.update(jobId, {
        status: 'running',
        progress: 5,
        message: `Retrying (attempt 2) after: ${msg}`,
        retryCount: 1,
      });
    } catch {}
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await fn();
    } catch (secondErr) {
      console.error(`[${label} ${jobId}] retry also failed:`, secondErr);
      try {
        await jobStore.update(jobId, {
          status: 'failed',
          message: String(secondErr?.message || secondErr),
          retryCount: 1,
          failedAt: Date.now(),
        });
      } catch {}
    }
  }
}



/**
 * Auto-generate an SRT subtitle file with character name lower-thirds.
 * Scans each beat's narration/reason text for first-mention intro patterns
 * ("Firstname Lastname, description") and generates a timed SRT entry at
 * the start of the beat in which the character first appears.
 *
 * Timing is derived from cumulative voDurs (output video seconds per beat),
 * so the name appears exactly when that beat's audio begins playing.
 *
 * @param {Array}    beats   per-beat objects with .narration or .reason
 * @param {number[]} voDurs  measured audio duration per beat (seconds)
 * @returns {string}  SRT content, or "" if no characters detected
 */
/**
 * _buildTtsText — extract and sanitise narration text from a beat.
 * Returns "" for SKIP beats (no narration or explicit SKIP label).
 */
function _buildTtsText(beat) {
  let text = (beat.narration || beat.reason || "").trim()
    .replace(/\*[^*]*\*/g, "")
    .replace(/\([^)]{0,120}\)/g, "")
    .replace(/\[[^\]]{0,120}\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!text || text.toUpperCase().startsWith("SKIP")) return "";
  if (text.length > 4000) text = text.slice(0, 4000).replace(/\s+\S*$/, "") + "\u2026";
  return text;
}

/**
 * _toSsml — wrap plain narration text in SSML with natural breathing pauses.
 *
 * Adds:
 *   500ms after every sentence end (. ! ?) before the next capitalised word —
 *     simulates the natural breath a narrator takes between sentences.
 *   250ms after semicolons — a mid-sentence pause for compound clauses.
 *   150ms either side of em-dashes — dramatic micro-beat used in narration.
 *
 * The result is wrapped in <speak>…</speak> which Speechify recognises as
 * SSML and processes accordingly. Plain text (no sentence boundaries) is
 * returned as-is inside <speak> tags so Speechify still accepts it.
 */
function _toSsml(text) {
  if (!text || !text.trim()) return text;

  // Split into individual sentences keeping their trailing punctuation.
  const raw = text.match(/[^.!?]*[.!?]+(?:\s|$)|[^.!?]+$/g) || [text];
  const sentences = raw.map((s) => s.trim()).filter(Boolean);

  const parts = sentences.map((s, i) => {
    const isLast = i === sentences.length - 1;
    let wrapped = s;

    // ── Per-sentence expressiveness ──────────────────────────────────────────
    if (/!+$/.test(s)) {
      // Dramatic / exclamatory → moderate emphasis + slight slow-down
      wrapped = `<prosody rate="95%"><emphasis level="moderate">${s}</emphasis></prosody>`;
    } else if (/\?+$/.test(s)) {
      // Questions → natural rising intonation
      wrapped = `<prosody pitch="+5%">${s}</prosody>`;
    } else if (/\.{2,}$/.test(s) || s.endsWith("\u2026")) {
      // Ellipsis / trailing suspense → slow and lower for tension
      wrapped = `<prosody rate="slow" pitch="-3%">${s}</prosody>`;
    }

    // 500 ms breath between sentences (not after the final one)
    return isLast ? wrapped : `${wrapped} <break time="500ms"/>`;
  });

  let t = parts.join(" ")
    // Short pause after semicolons (compound-clause beat)
    .replace(/;\s+/g, ';<break time="250ms"/> ')
    // Micro-pause around em-dashes for dramatic effect
    .replace(/\s*\u2014\s*/g, '<break time="150ms"/>\u2014<break time="150ms"/>');

  return `<speak>${t}</speak>`;
}

/**
 * _ttsOnceSpeechify — single Speechify TTS request (simba-english model).
 * Writes the audio to outputPath. Throws on any error — caller handles retries.
 */
async function _ttsOnceSpeechify(apiKey, voice, speed, text, outputPath, vsettings = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  let resp;
  try {
    resp = await fetch("https://api.sws.speechify.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: _toSsml(text),
        voice_id: voice,
        model: "simba-english",
        audio_format: "mp3",
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "timed out after 60s" : `fetch: ${err.message}`);
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${msg.slice(0, 120)}`);
  }
  const data = await resp.json();
  if (!data.audio_data) throw new Error("Speechify response missing audio_data");
  const buf = Buffer.from(data.audio_data, "base64");
  await fs.writeFile(outputPath, buf);
}

/**
 * _ttsOnceElevenLabs — ElevenLabs TTS (eleven_turbo_v2_5 model, binary MP3 response).
 */
async function _ttsOnceElevenLabs(apiKey, voice, speed, text, outputPath, vsettings = {}) {
  const voiceId = voice || SERVER_ELEVENLABS_VOICE;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  let resp;
  try {
    resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", "Accept": "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: typeof vsettings.stability === "number" ? vsettings.stability : 0.50,
          similarity_boost: typeof vsettings.similarity === "number" ? vsettings.similarity : 0.80,
          speed: Math.min(Math.max(Number(speed) || 1.0, 0.7), 1.2),
        },
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "timed out after 60s" : `fetch: ${err.message}`);
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${msg.slice(0, 120)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 100) throw new Error("ElevenLabs response too small — likely empty");
  await fs.writeFile(outputPath, buf);
}

/**
 * _ttsOnceOpenAI — OpenAI TTS (tts-1-hd model, binary MP3 response).
 * 4096-character hard limit per request; long narrations are silently truncated.
 */
async function _ttsOnceOpenAI(apiKey, voice, speed, text, outputPath) {
  const oaiVoice = voice || "onyx";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  let resp;
  try {
    resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "tts-1-hd",
        input: text.slice(0, 4096),
        voice: oaiVoice,
        speed: Math.min(Math.max(Number(speed) || 1.0, 0.25), 4.0),
        response_format: "mp3",
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "timed out after 60s" : `fetch: ${err.message}`);
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${msg.slice(0, 120)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 100) throw new Error("OpenAI TTS response too small");
  await fs.writeFile(outputPath, buf);
}

/**
 * _ttsOnceHume — Hume AI TTS (v0/tts endpoint, base64 JSON response).
 */
async function _ttsOnceHume(apiKey, voice, text, outputPath) {
  const humeName = voice || SERVER_HUME_VOICE;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  let resp;
  try {
    resp = await fetch("https://api.hume.ai/v0/tts", {
      method: "POST",
      headers: { "X-Hume-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        utterances: [{ voice: { name: humeName }, text }],
        format: { type: "mp3" },
        num_channels: 1,
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "timed out after 60s" : `fetch: ${err.message}`);
  }
  clearTimeout(timer);
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${msg.slice(0, 120)}`);
  }
  const data = await resp.json();
  const audioB64 = data?.generations?.[0]?.audio;
  if (!audioB64) throw new Error("Hume response missing audio data");
  await fs.writeFile(outputPath, Buffer.from(audioB64, "base64"));
}

/**
 * _ttsOnce — multi-provider TTS router.
 * provider: "speechify" | "elevenlabs" | "openai" | "hume"
 * Dispatches to the matching provider function. Throws on any error — caller retries.
 */
async function _ttsOnce(provider, apiKey, voice, speed, text, outputPath, vsettings = {}) {
  switch (String(provider || "speechify").toLowerCase()) {
    case "elevenlabs": return _ttsOnceElevenLabs(apiKey, voice, speed, text, outputPath, vsettings);
    case "openai":     return _ttsOnceOpenAI(apiKey, voice, speed, text, outputPath);
    case "hume":       return _ttsOnceHume(apiKey, voice, text, outputPath);
    default:           return _ttsOnceSpeechify(apiKey, voice, speed, text, outputPath, vsettings);
  }
}

/**
 * _generateSilenceMp3 — create a silent MP3 of exactly durationSec seconds via ffmpeg.
 * Last-resort padding when TTS is unrecoverable for a beat.
 */
async function _generateSilenceMp3(outputPath, durationSec) {
  const dur = String(Math.max(0.5, Math.min(600, durationSec)));
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
      "-t", dur,
      "-acodec", "libmp3lame", "-q:a", "9",
      outputPath,
    ], { stdio: "ignore" });
    ff.on("close", (code) => code === 0 ? resolve() : reject(new Error(`silence ffmpeg exit ${code}`)));
    ff.on("error", reject);
  });
}

/**
 * _textMatchBeatNotes — zero-cost footage window improvement.
 *
 * For every beat whose footage window is shorter than its TTS duration,
 * scan ALL beat notes (written by Claude during analyze) for the one whose
 * words overlap most with the render beat's narration, then re-centre the
 * footage window around that beat's timestamp.
 *
 * No external API, no embeddings — pure Jaccard word-set similarity on text
 * that was already generated during the analyze phase.
 *
 * @param {object[]} beats   full beat array (.narration, .note, .startSec, .endSec)
 * @param {number[]} voDurs  actual TTS duration per beat (seconds), same length
 * @returns {{ scenes: object[], applied: number, log: string[] }}
 */
function _textMatchBeatNotes(beats, voDurs) {
  const STOP = new Set([
    'the','a','an','is','are','was','were','in','of','to','and','or','at','on',
    'with','for','as','his','her','its','their','he','she','it','this','that',
    'from','by','be','been','have','has','had','will','would','could','should',
    'may','but','not','they','we','you','i','my','your','our','who','what',
    'when','how','then','than','so','up','out','about','into','through','after',
    'before','also','just','even','more','most','all','one','two','three',
  ]);

  const tokenize = (text) => {
    if (!text || typeof text !== 'string') return new Set();
    return new Set(
      text.toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
    );
  };

  const jaccard = (a, b) => {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
  };

  // Pre-tokenize all beat notes and narrations once
  const noteTokens      = beats.map((b) => tokenize(b.note || b.reason || ''));
  const narrationTokens = beats.map((b) => tokenize(b.narration || ''));

  const logLines = [];
  const scenes = beats.map((b, i) => {
    const origStart = Number(b.startSec);
    const origEnd   = Number(b.endSec);
    const winSec    = Math.max(0, origEnd - origStart);
    const ttsSec    = Number(voDurs[i]) || 0;

    // Only improve beats where footage window is clearly tighter than TTS
    if (ttsSec <= winSec * 1.1 || ttsSec < 0.5) {
      return { startSec: origStart, endSec: origEnd, reason: b.reason || b.narration || '' };
    }

    // Find the beat whose note best matches this beat's narration.
    // Limit search to ±5 beats so re-centring never jumps far enough to
    // violate chronological footage order (e.g. beat30→beat39 caused backward
    // jump in the final video — footage appeared earlier than the previous beat).
    const narTok = narrationTokens[i];
    let bestJ = -1, bestScore = 0.08; // minimum meaningful overlap
    const searchLo = Math.max(0, i - 5);
    const searchHi = Math.min(beats.length - 1, i + 5);
    for (let j = searchLo; j <= searchHi; j++) {
      if (j === i) continue;
      const s = jaccard(narTok, noteTokens[j]);
      if (s > bestScore) { bestScore = s; bestJ = j; }
    }

    if (bestJ < 0) {
      // No good match found — keep original window
      return { startSec: origStart, endSec: origEnd, reason: b.reason || b.narration || '' };
    }

    const matchB   = beats[bestJ];
    const center   = (Number(matchB.startSec) + Number(matchB.endSec)) / 2;
    // No hard floor — base purely on TTS with a 10% safety margin.
    // The old 8s floor inflated every re-centred window to ≥16s even for 6s
    // TTS clips, creating 20-40s of surplus footage that drifted into the next
    // beat's narration.
    const halfWin  = Math.max(winSec / 2, ttsSec / 2 * 1.1);

    // Chronological guard: reject re-centring if it would place this beat's
    // footage before the previous beat or after the next beat.
    const prevEnd   = i > 0 ? Number(beats[i - 1].endSec)   : 0;
    const nextStart = i < beats.length - 1 ? Number(beats[i + 1].startSec) : Infinity;
    if (center < prevEnd || center > nextStart) {
      return { startSec: origStart, endSec: origEnd, reason: b.reason || b.narration || '' };
    }

    logLines.push(`beat${i}[txt:${bestScore.toFixed(2)}→beat${bestJ}@${center.toFixed(0)}s win ${winSec.toFixed(1)}s→${(halfWin*2).toFixed(1)}s]`);
    return {
      startSec: Math.max(0, center - halfWin),
      endSec:   center + halfWin,
      reason:   (b.reason || b.narration || '') + ` [txt:${bestScore.toFixed(2)}]`,
    };
  });

  return { scenes, applied: logLines.length, log: logLines };
}

/**
 * generatePerBeatTTS — Segment-Based Voice Generation (Architecture v3)
 * ─────────────────────────────────────────────────────────────────────
 * Generates exactly ONE audio clip per beat. NEVER throws. NEVER falls back
 * to even distribution. Recovery hierarchy for each failed clip:
 *
 *   Phase 1 — Batch TTS         (concurrency=2, 30s timeout per clip)
 *   Phase 2 — Sequential retry  (3 attempts, 3s / 6s / 9s backoff)
 *   Phase 3 — Truncated text    (first 200 chars of narration)
 *   Phase 4 — ffmpeg silence    (sized to beat's own time window)
 *   Phase 5 — SKIP beats        (no narration → silence)
 *
 * Always returns beats.length entries with no nulls.
 *
 * @param {string}   jobId
 * @param {object[]} beats   beat objects with .narration or .reason
 * @param {string}   apiKey  OpenAI API key
 * @param {object}  [opts]   { ttsVoice, ttsSpeed }
 * @returns {Array<{id, duration, _silence?, _skip?}>}
 */
async function generatePerBeatTTS(jobId, beats, apiKey, opts = {}) {
  // Provider routing: speechify | elevenlabs | openai | hume
  const provider = String(opts.ttsProvider || "speechify").toLowerCase();
  const voice = String(opts.ttsVoice || SERVER_SPEECHIFY_VOICE);
  const speed = Math.min(Math.max(Number(opts.ttsSpeed) || 1.0, 0.7), 1.2);
  // CONCURRENCY=1: fully sequential — Speechify rate-limits the second concurrent
  // request in every pair, causing every odd beat to fail and retry (+3s each).
  // Sequential is more reliable and actually faster when retries are eliminated.
  const CONCURRENCY = 1;

  const results = new Array(beats.length).fill(null);
  const failed = new Map(); // index → last error message

  // ── Phase 1: Batch TTS (concurrency=1, 30s hard timeout per clip) ───────────
  for (let batchStart = 0; batchStart < beats.length; batchStart += CONCURRENCY) {
    const batchEnd = Math.min(batchStart + CONCURRENCY, beats.length);
    await Promise.all(
      Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k).map(async (i) => {
        const text = _buildTtsText(beats[i]);
        if (!text) return; // SKIP beat — handled in Phase 5
        const ttsId = `${jobId}-tts-beat-${String(i).padStart(3, "0")}.mp3`;
        const ttsPath = path.join(UPLOADS_DIR, ttsId);
        try {
          await _ttsOnce(provider, apiKey, voice, speed, text, ttsPath, opts.voiceSettings || {});
          const dur = await probeDurationSec(ttsPath);
          if (dur < 0.05) throw new Error("zero-length output");
          results[i] = { id: ttsId, duration: dur };
        } catch (err) {
          failed.set(i, String(err.message));
        }
      }),
    );
    // Fire progress callback after every batch so the app sees live clip count.
    if (opts.onProgress) {
      try { await opts.onProgress(batchEnd, beats.length); } catch {}
    }
  }

  // ── Phase 2: Sequential retry for failed clips (3 attempts, exp backoff) ────
  for (const [i] of [...failed]) {
    const text = _buildTtsText(beats[i]);
    if (!text) continue;
    const ttsId = `${jobId}-tts-beat-${String(i).padStart(3, "0")}.mp3`;
    const ttsPath = path.join(UPLOADS_DIR, ttsId);
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
      try {
        await _ttsOnce(provider, apiKey, voice, speed, text, ttsPath, opts.voiceSettings || {});
        const dur = await probeDurationSec(ttsPath);
        if (dur < 0.05) throw new Error("zero-length");
        results[i] = { id: ttsId, duration: dur };
        failed.delete(i);
        console.log(`[render ${jobId}] PER-BEAT TTS: beat-${i} recovered on retry ${attempt + 1}`);
        break;
      } catch (err) {
        failed.set(i, String(err.message));
      }
    }
  }

  // ── Phase 3: Truncated text (first 200 chars) for still-failed clips ────────
  for (const [i] of [...failed]) {
    const fullText = _buildTtsText(beats[i]);
    if (!fullText) continue;
    const shortText = fullText.slice(0, 200).replace(/\s+\S*$/, "").trim() + "\u2026";
    if (shortText.length < 10) continue;
    const ttsId = `${jobId}-tts-beat-${String(i).padStart(3, "0")}.mp3`;
    const ttsPath = path.join(UPLOADS_DIR, ttsId);
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await _ttsOnce(provider, apiKey, voice, speed, shortText, ttsPath);
      const dur = await probeDurationSec(ttsPath);
      if (dur < 0.05) throw new Error("zero-length");
      results[i] = { id: ttsId, duration: dur };
      failed.delete(i);
      console.log(`[render ${jobId}] PER-BEAT TTS: beat-${i} recovered with truncated text`);
    } catch (err) {
      failed.set(i, String(err.message));
    }
  }

  // ── Phase 4: ffmpeg silence for truly unrecoverable clips ───────────────────
  for (const [i, errMsg] of failed) {
    const winDur = Math.max(1, Number(beats[i].endSec || 0) - Number(beats[i].startSec || 0));
    const silId = `${jobId}-tts-beat-${String(i).padStart(3, "0")}.mp3`;
    const silPath = path.join(UPLOADS_DIR, silId);
    console.warn(`[render ${jobId}] PER-BEAT TTS: beat-${i} silence-padded (${winDur.toFixed(1)}s) — ${errMsg}`);
    try {
      await _generateSilenceMp3(silPath, winDur);
      const dur = await probeDurationSec(silPath).catch(() => winDur);
      results[i] = { id: silId, duration: dur, _silence: true };
    } catch {
      results[i] = { id: silId, duration: winDur, _silence: true };
    }
  }

  // ── Phase 5: Silence for SKIP beats (no narration text) ─────────────────────
  for (let i = 0; i < beats.length; i++) {
    if (results[i] !== null) continue;
    const winDur = Math.max(1, Number(beats[i].endSec || 0) - Number(beats[i].startSec || 0));
    const silId = `${jobId}-tts-beat-${String(i).padStart(3, "0")}.mp3`;
    const silPath = path.join(UPLOADS_DIR, silId);
    try {
      await _generateSilenceMp3(silPath, winDur);
      const dur = await probeDurationSec(silPath).catch(() => winDur);
      results[i] = { id: silId, duration: dur, _skip: true };
    } catch {
      results[i] = { id: silId, duration: winDur, _skip: true };
    }
  }

  return results;
}

/**
 * narSrtTs — format seconds as SRT timestamp HH:MM:SS,mmm
 */
function narSrtTs(sec) {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const ms = totalMs % 1000;
  const ss = Math.floor(totalMs / 1000) % 60;
  const mm = Math.floor(totalMs / 60000) % 60;
  const hh = Math.floor(totalMs / 3600000);
  return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
}

/**
 * buildNarrationSrt — full narration SRT from per-beat TTS durations.
 * @param {object[]} beats        beat objects with .narration or .reason
 * @param {number[]} beatDurations measured TTS duration per beat (seconds)
 */
function buildNarrationSrt(beats, beatDurations) {
  const MAX_CHARS = 80;
  const MAX_LINES = 2;
  const entries = [];
  let t = 0, seq = 1;
  for (let i = 0; i < Math.min(beats.length, beatDurations.length); i++) {
    const dur = Number(beatDurations[i]) || 0;
    if (dur < 0.1) { t += dur; continue; }
    let text = (beats[i].narration || beats[i].reason || "").trim()
      .replace(/\*[^*]*\*/g, "").replace(/\([^)]{0,100}\)/g, "").replace(/\s{2,}/g, " ").trim();
    if (!text) { t += dur; continue; }
    const words = text.split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const c = line ? line + " " + w : w;
      if (c.length > MAX_CHARS && line) { lines.push(line); line = w; }
      else { line = c; }
    }
    if (line) lines.push(line);
    entries.push(`${seq}\n${narSrtTs(t)} --> ${narSrtTs(t + dur)}\n${lines.slice(0, MAX_LINES).join("\n")}`);
    seq++; t += dur;
  }
  return entries.join("\n\n");
}

/**
 * computeSyncScore — pre-render sync validation per ChatGPT Timeline Orchestrator Step 9.
 * Score 100 = TTS fits scene window exactly; <80 = narration pulls into adjacent scenes.
 * @param {object[]} beats         beat objects with .startSec / .endSec
 * @param {number[]} beatDurations TTS duration per beat (seconds)
 */
function computeSyncScore(beats, beatDurations) {
  const n = Math.min(beats.length, beatDurations.length);
  let total = 0;
  const perBeat = [];
  for (let i = 0; i < n; i++) {
    const ttsDur = Number(beatDurations[i]) || 0;
    const winDur = Math.max(0, Number(beats[i].endSec || 0) - Number(beats[i].startSec || 0));
    let score;
    if (winDur <= 0 || ttsDur <= 0) { score = 50; }
    else if (ttsDur <= winDur) { score = 100; }
    else { score = Math.max(0, Math.round(100 - (ttsDur / winDur - 1) * 50)); }
    perBeat.push({ i, ttsDur: ttsDur.toFixed(2), win: winDur.toFixed(2), score });
    total += score;
  }
  return { overall: n > 0 ? Math.round(total / n) : 0, perBeat, n };
}

function buildCharacterIntroSrt(beats, voDurs) {
  const seen = new Set();
  const entries = [];
  let t = 0;
  let seq = 1;

  // PRIMARY: "Firstname [Middle] Lastname, [a/an/the] <role/description>"
  // Requires 2+ capitalised words before the comma to reduce false positives.
  const CHAR_RE = /([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)+)\s*,\s*(?:(?:a|an|the|also|known)\s+)?([A-Za-z][^,.\n]{3,60})/g;

  // SECONDARY: name after intro verbs — "meet/introduce/follows Jim Hanson"
  const INTRO_RE = /(?:meet|meets|introduce[sd]?|following|follows|enters?|named?)\s+([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)+)/g;

  // TERTIARY: 2+ capitalised words at sentence start (after . or at position 0)
  const SENT_RE = /(?:^|[.!?]\s+)([A-Z][A-Za-z'-]+\s+[A-Z][A-Za-z'-]+)(?=[\s,])/gm;

  // Words that indicate a place/org rather than a person — skip these
  const PLACE_WORDS = /\b(City|Street|Avenue|Road|County|State|States|York|Angeles|Francisco|Chicago|London|Paris|Berlin|University|Company|Corporation|Department|Agency|Bureau|Institute|Hospital|School|College|New|North|South|East|West|United|American|National)\b/i;

  const tryAdd = (name, beatStart, dur) => {
    if (PLACE_WORDS.test(name)) return;
    if (name.split(/\s+/).length < 2) return;  // single word — skip
    if (!seen.has(name)) {
      seen.add(name);
      const start = beatStart;
      const end = Math.min(beatStart + 3.5, beatStart + Math.max(dur - 0.15, 0));
      if (end - start >= 0.5) {
        entries.push({ seq: seq++, start, end, name });
      }
    }
  };

  for (let i = 0; i < beats.length; i++) {
    const dur = Number(voDurs[i]) || 0;
    const text = String(beats[i]?.narration || beats[i]?.reason || "");

    // Primary scan
    CHAR_RE.lastIndex = 0;
    let m;
    while ((m = CHAR_RE.exec(text)) !== null) { tryAdd(m[1].trim(), t, dur); }

    // Secondary scan — intro verb followed by name
    INTRO_RE.lastIndex = 0;
    while ((m = INTRO_RE.exec(text)) !== null) { tryAdd(m[1].trim(), t, dur); }

    // Tertiary scan — sentence-start capitalised pairs (only if no primary hit yet)
    if (entries.length === 0 || entries[entries.length - 1].start < t) {
      SENT_RE.lastIndex = 0;
      while ((m = SENT_RE.exec(text)) !== null) { tryAdd(m[1].trim(), t, dur); }
    }

    t += dur;
  }

  if (entries.length === 0) return "";

  const fmtTime = (s) => {
    const h = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.round((s % 1) * 1000);
    return (
      String(h).padStart(2, "0") + ":" +
      String(mins).padStart(2, "0") + ":" +
      String(sec).padStart(2, "0") + "," +
      String(ms).padStart(3, "0")
    );
  };

  return entries
    .map((e) => `${e.seq}\n${fmtTime(e.start)} --> ${fmtTime(e.end)}\n${e.name}`)
    .join("\n\n") + "\n";
}

async function runRender(jobId, { clipFileIds, voiceoverFileId, settings }) {
  await jobStore.update(jobId, { status: "running", progress: 5, message: "Preparing manifest" });

  // Validate that each clip file actually exists (some IDs may be stale/missing).
  const validClipIds = [];
  for (const id of clipFileIds) {
    try { await fs.access(path.join(UPLOADS_DIR, id)); validClipIds.push(id); }
    catch { console.warn(`[render ${jobId}] skipping missing clip: ${id}`); }
  }
  if (validClipIds.length === 0) {
    await jobStore.update(jobId, { status: "failed", message: "No valid clip files found" });
    return;
  }

  // Build the concat manifest.
  const clipAbsPaths = validClipIds.map((id) => path.join(UPLOADS_DIR, id));
  const manifestPath = path.join(UPLOADS_DIR, `concat-${jobId}.txt`);
  await fs.writeFile(manifestPath, buildConcatManifest(clipAbsPaths), "utf8");

  const outputPath = path.join(OUTPUT_DIR, `recap-${jobId}.mp4`);
  const voiceoverPath = voiceoverFileId ? path.join(UPLOADS_DIR, voiceoverFileId) : null;
  const args = buildRenderArgs({ concatListPath: manifestPath, voiceoverPath, outputPath, settings });

  await jobStore.update(jobId, { progress: 15, message: "Encoding video" });

  await new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let lastProgress = 15;
    ff.stderr.on("data", async (chunk) => {
      const line = chunk.toString();
      // Look for time= markers from FFmpeg to estimate progress.
      const m = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m) {
        const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        // We don't know total duration without probing; use a rolling estimate.
        const next = Math.min(90, Math.round(15 + sec * 0.5));
        if (next > lastProgress) {
          lastProgress = next;
          try { await jobStore.update(jobId, { progress: next, message: `Encoding ${m[0]}` }); } catch {}
        }
      }
    });
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });

  await jobStore.update(jobId, {
    status: "done",
    progress: 100,
    message: "Render complete",
    outputPath,
    completedAt: Date.now(),
  });

  // Best-effort cleanup of the concat manifest (clips stay until the user
  // explicitly purges them so we can re-render with the same source).
  try { await fs.unlink(manifestPath); } catch {}
}

/**
 * Build a single scene-adaptive music file (mood switches per span) the length
 * of `totalSec`, by cutting each span from its mood bed and crossfading.
 * Returns the output path, or null if it couldn't be built (caller falls back
 * to a single mood bed).
 */
async function buildSceneAdaptiveMusic({ spans, musicDir, outPath, totalSec, crossfadeSec = 1.0 }) {
  if (!Array.isArray(spans) || spans.length === 0 || !(totalSec > 0)) return null;
  // Single span -> just one bed, no crossfade needed (let the mux loop/clamp it).
  // For each span, extract [0 .. duration(+crossfade)] from its mood bed, looping
  // the bed if the span is longer than the source.
  const partPaths = [];
  try {
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i];
      const bed = path.join(musicDir, `${sp.mood}.mp3`);
      try { await fs.access(bed); } catch { return null; } // missing bed -> bail to fallback
      // Add crossfade overlap to all but the last span so acrossfade has material.
      const extra = i < spans.length - 1 ? crossfadeSec : 0;
      const dur = Math.max(0.5, sp.durationSec + extra);
      const part = path.join(UPLOADS_DIR, `music-part-${path.basename(outPath, '.mp3')}-${String(i).padStart(2, '0')}.mp3`);
      const args = [
        "-y", "-hide_banner", "-loglevel", "error",
        "-stream_loop", "-1", "-i", bed,
        "-t", dur.toFixed(3),
        "-af", "aresample=48000",
        "-ac", "2", "-ar", "48000",
        part,
      ];
      const ok = await new Promise((resolve) => {
        const ff = spawn("ffmpeg", args, { stdio: "ignore" });
        ff.on("close", (c) => resolve(c === 0));
        ff.on("error", () => resolve(false));
      });
      if (!ok) return null;
      partPaths.push(part);
    }

    // Chain the parts with acrossfade so mood transitions are smooth.
    if (partPaths.length === 1) {
      // Just trim the single part to exactly totalSec.
      const args = [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", partPaths[0], "-t", totalSec.toFixed(3),
        "-c", "copy", outPath,
      ];
      const ok = await new Promise((resolve) => {
        const ff = spawn("ffmpeg", args, { stdio: "ignore" });
        ff.on("close", (c) => resolve(c === 0));
        ff.on("error", () => resolve(false));
      });
      if (!ok) return null;
    } else {
      // Build a filter_complex that acrossfades part0->part1->...->partN.
      const inputs = [];
      for (const p of partPaths) { inputs.push("-i", p); }
      const filters = [];
      let prev = "[0:a]";
      for (let i = 1; i < partPaths.length; i++) {
        const out = i === partPaths.length - 1 ? "[mix]" : `[x${i}]`;
        filters.push(`${prev}[${i}:a]acrossfade=d=${crossfadeSec}:c1=tri:c2=tri${out}`);
        prev = out;
      }
      const args = [
        "-y", "-hide_banner", "-loglevel", "error",
        ...inputs,
        "-filter_complex", filters.join(";"),
        "-map", "[mix]",
        "-t", totalSec.toFixed(3),
        "-ac", "2", "-ar", "48000",
        outPath,
      ];
      const ok = await new Promise((resolve) => {
        const ff = spawn("ffmpeg", args, { stdio: "ignore" });
        ff.on("close", (c) => resolve(c === 0));
        ff.on("error", () => resolve(false));
      });
      if (!ok) return null;
    }
    return outPath;
  } finally {
    for (const p of partPaths) { try { await fs.unlink(p); } catch {} }
  }
}

/* ---------- render-from-ingest worker (trims clips out of a cached source) ---------- */
async function runRenderFromIngest(jobId, {
  sourcePath,
  timestamps,
  voiceoverFileIds = [],
  musicFileId = null,
  musicPathOverride = null,
  subtitlesSrt = "",
  musicVolumeDb,
  beats = null,
  sceneAdaptiveMusic = true,
  analyzeJobId: passedAnalyzeJobId = null, // v2.7 — supplied by app so CLIP can find frames
  targetMinutes = 20,                       // user-selected recap duration from the app
  settings,
}) {
  await jobStore.update(jobId, { status: "running", progress: 5, message: "Preparing timeline" });
  let _analyzeJobId = null; // set when beats are auto-loaded; used for CLIP matching
  const HOOK_V2 = true;            // Hook V2: beat-based hook, no scene-detector dependency
  let subtitlesPath    = null;     // path of written .srt file — cleared if subtitle burn runs
  let _hookText        = null;     // hook narration text
  let _hookV2BeatIds   = null;     // sourceBeatIds returned by Claude — footage comes from these beats
  let _hv2ReadyPath    = null;     // merged hook video path, ready to prepend after body trim
  let _hv2ReadyTtsId   = null;     // hook TTS file ID, ready to prepend after body trim
  // Legacy vars kept only to satisfy disabled old-hook blocks below
  let _hookSceneIds        = null;
  let _hookDirectTimestamps = null;
  let _scenesMap    = null;
  let _hookTtsId       = null;
  let _hookFinalDurSec = 0;

  // When the app sends beats directly (bypass path) AND tells us which analyze job
  // produced them, prime CLIP matching now so semantic frame search can run.
  // (If auto-load runs below for the no-beats path, it will overwrite this.)
  if (passedAnalyzeJobId && Array.isArray(beats) && beats.length > 0) {
    _analyzeJobId = passedAnalyzeJobId;
    console.log(`[render ${jobId}] CLIP primed from app-supplied analyzeJobId: ${passedAnalyzeJobId}`);
  }

  // ── CORRUPT TIMESTAMP DETECTION: if the app sends timestamps where >50% are
  // zero-duration (startSec=0, endSec≤1) alongside one entry spanning the whole
  // movie, the data is corrupted (stale cache / race condition on the client).
  // Discard the timestamps and clear beats so AUTO-LOAD picks up the good data
  // from the most recent analyze job for this file instead.
  if (Array.isArray(timestamps) && timestamps.length > 0) {
    const badCount = timestamps.filter(
      (t) => Number(t.startSec) === 0 && Number(t.endSec) <= 1
    ).length;
    const hasWholeMoveEntry = timestamps.some(
      (t) => Number(t.startSec) === 0 && Number(t.endSec) > 1800
    );
    if (badCount > timestamps.length * 0.4 || hasWholeMoveEntry) {
      console.warn(
        `[render ${jobId}] CORRUPT TIMESTAMPS: ${badCount}/${timestamps.length} zero-clips` +
        (hasWholeMoveEntry ? " + whole-movie entry" : "") +
        " — discarding and auto-loading from analyze job"
      );
      await jobStore.update(jobId, {
        message: "Detected corrupted scene timestamps — reloading from analysis…",
      });
      timestamps = [];
      beats = [];
    }
  }

  // ── AUTO-LOAD BEATS: when the render arrives with no beats and no voice files
  // (app did not generate TTS), scan the jobs store for the most recently
  // completed analyze job for the same source file and load its beats so that
  // server-side Speechify TTS can generate per-beat audio automatically.
  if ((!Array.isArray(beats) || beats.length === 0) && voiceoverFileIds.length === 0) {
    try {
      const sourceFileId = path.basename(sourcePath);
      const jobFiles = await fs.readdir(JOBS_DIR);
      let bestJob = null;
      let bestTime = 0;
      for (const fname of jobFiles) {
        if (!fname.endsWith(".json")) continue;
        try {
          const j = JSON.parse(await fs.readFile(path.join(JOBS_DIR, fname), "utf8"));
          if (j.status !== "done") continue;
          if ((j.result?.sourceFileId || j.sourceFileId) !== sourceFileId) continue;
          const t = j.completedAt || j.updatedAt || 0;
          if (t > bestTime && Array.isArray(j.result?.beats) && j.result.beats.length > 0) {
            bestTime = t;
            bestJob = j;
          }
        } catch {}
      }
      if (bestJob) {
        beats = bestJob.result.beats;
        console.log(`[render ${jobId}] AUTO-LOAD: ${beats.length} beats from analyze job (${sourceFileId})`);
        await jobStore.update(jobId, {
          progress: 6,
          message: `Loaded ${beats.length} scenes from analysis — generating narration audio…`,
        });
      } else {
        console.warn(`[render ${jobId}] AUTO-LOAD: no analyze job with beats found for ${sourceFileId}`);
        await jobStore.update(jobId, {
          message: `No scene analysis found for this clip — video will render without narration`,
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
    const _preTrimBeats = beats.slice();
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
        const kept = Array.from({ length: BEATS_TARGET }, (_, b) => {
          const start  = Math.floor(b * bucketSize);
          const end    = Math.min(Math.ceil((b + 1) * bucketSize), original.length);
          const bucket = original.slice(start, end);
          if (bucket.length === 0) return null;
          // Within each bucket prefer the beat with the highest importance score.
          // Falls back to the first beat in the bucket when no scores are present.
          const best = bucket.reduce((top, beat) =>
            +(beat.importance || 0) >= +(top.importance || 0) ? beat : top
          );
          if (seenRefs.has(best)) return null;
          seenRefs.add(best);
          return best;
        }).filter(Boolean);

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
        const _hv2Scored = beats.map((b, i) => {
          const imp = +(b.importance    || 0);
          const emo = +(b.emotionScore  || imp);
          const sur = +(b.surpriseScore || imp);
          return { _idx: i, hookScore: imp * 0.60 + emo * 0.30 + sur * 0.10 };
        });

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
      if (
        voiceoverFileIds.length !== beats.length &&
        beats.length > 0 &&
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
        const _ttsSpeed = (settings && settings.ttsSpeed) || 1.0;
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
      const voDurs = await Promise.all(
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
        const beatTexts = beats.map((b) => (typeof b.narration === "string" ? b.narration : ""));

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
                let srcDurClip = 0;
                try { srcDurClip = await probeDurationSec(sourcePath); } catch {}
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
                    scenes = scenes.map((sc, i) => {
                      const m = matchRes.results[i];
                      // Only apply if score is confident enough (CLIP cosine > 0.22)
                      // and the matched frame is within the general timeline region.
                      if (!m || m.score < 0.22) return sc;
                      const center = m.timeSec;
                      // FIX: Widened window guard. The old strict check (center must be
                      // within sc.startSec..sc.endSec) prevented CLIP from correcting
                      // beats where Claude placed the timestamp in the wrong scene.
                      // New guard: allow CLIP to relocate a beat's window as long as the
                      // matched frame is within ±15% of movie duration from the beat midpoint.
                      // This lets CLIP escape Claude's wrong timestamps (e.g. "Layla scene"
                      // assigned to minute 30 but Layla actually appears at minute 45)
                      // while still staying in the correct chronological region.
                      const _scMid = (Number(sc.startSec) + Number(sc.endSec)) / 2;
                      const _liberalRadius = srcDurClip > 0 ? srcDurClip * 0.15 : 300;
                      if (center < _scMid - _liberalRadius || center > _scMid + _liberalRadius) return sc;
                      const winHalf = Math.max(8, (sc.endSec - sc.startSec) / 2);
                      clipApplied++;
                      return {
                        ...sc,
                        startSec: Math.max(0, center - winHalf),
                        endSec: center + winHalf,
                        reason: (sc.reason || "") + ` [clip:${m.score.toFixed(2)}]`,
                      };
                    });
                    console.log(
                      `[render ${jobId}] CLIP: semantic windows applied to ${clipApplied}/${scenes.length} beats ` +
                      `(frames=${embedRes.frames}, analyzeJob=${_analyzeJobId})`
                    );
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
        // Final multimodal verifier: analyze candidate + CLIP/Whisper candidates →
        // Gemini Flash picks the best clip. Runs only when GEMINI_API_KEY is set.
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
              if (sc.reason && sc.reason.includes('[clip:')) return sc; // CLIP already handled
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
    } catch (e) {
      console.warn(`[render ${jobId}] sync planning failed, falling back to loop align:`, e?.message || e);
    }
  }

  // ── Sync Validator + Subtitle Generation (Steps 9, 11, 12 of Timeline Orchestrator) ──
  let _finalSyncScore = null;
  if (syncMode && Array.isArray(beats) && Array.isArray(syncBeatDurations) && syncBeatDurations.length > 0) {

    // Step 9+12: Pre-render sync score — log per-beat TTS vs scene window alignment
    try {
      const _sv = computeSyncScore(beats, syncBeatDurations);
      const _poor = _sv.perBeat.filter(b => b.score < 80);
      const _good = _sv.perBeat.filter(b => b.score >= 95);
      console.log(
        `[render ${jobId}] SYNC SCORE: ${_sv.overall}% overall ` +
        `(${_good.length}/${_sv.n} beats perfect ≥95%, ${_poor.length} beats <80%)`
      );
      _finalSyncScore = _sv.overall;
      if (_poor.length > 0) {
        const worst = _poor.slice(0, 5)
          .map(b => `beat${b.i}[tts=${b.ttsDur}s win=${b.win}s → ${b.score}%]`).join(", ");
        console.warn(`[render ${jobId}] LOW-SYNC BEATS: ${worst}`);
      }
    } catch (_svErr) {
      console.warn(`[render ${jobId}] sync score error:`, _svErr?.message || _svErr);
    }

    // Step 11: Subtitle generation
    // Per-beat TTS path → full narration SRT timed to exact TTS durations
    //   (override any app-sent SRT: audio changed, old TTS timing is wrong)
    // Original audio path → character-intro lower-thirds only if app sent no SRT
    try {
      if (_perBeatTtsDurations !== null) {
        const narSrt = buildNarrationSrt(beats, _perBeatTtsDurations);
        if (narSrt) {
          subtitlesSrt = narSrt;
          const cnt = (narSrt.match(/\n\n/g) || []).length + 1;
          console.log(`[render ${jobId}] NARRATION SRT: ${cnt} entries timed to per-beat TTS`);
        }
      }
      // Note: character intro lower-thirds removed — narration SRT from per-beat TTS is the only subtitle source
    } catch (_srtErr) {
      console.warn(`[render ${jobId}] SRT generation failed (continuing):`, _srtErr?.message || _srtErr);
    }
  }
  // ── END SYNC VALIDATOR + SUBTITLE GENERATION ─────────────────────────────

  await jobStore.update(jobId, { progress: 6, message: "Trimming clips" });

  // Trim each timestamp range into its own MP4 file.
  // Parallel trimming: process clips in batches of 8 concurrent ffmpeg jobs.
  // This cuts trim time ~8x for large recaps (74+ clips) and avoids timeouts.
  // ---- Sanitize timestamps before trimming (v1.9.1) -------------------------
  // A single clip with end <= start (or NaN / beyond movie length) used to throw
  // "buildTrimArgs: invalid time range" and abort the ENTIRE render. We now probe
  // the source duration once, clamp/drop invalid ranges, and enforce a minimum
  // clip length so one bad clip can never kill the job.
  const MIN_CLIP_SEC = 0.4;
  let sourceDurationSec = 0;
  try {
    sourceDurationSec = await probeDurationSec(sourcePath);
  } catch (e) {
    console.warn(`[render ${jobId}] could not probe duration:`, e?.message || e);
  }
  const hardMax = Number.isFinite(sourceDurationSec) && sourceDurationSec > 0
    ? sourceDurationSec
    : Number.POSITIVE_INFINITY;

  // ── QC: Black frame detection ──────────────────────────────────────────────
  // Run FFmpeg blackdetect once on the source to catalogue black-screen intervals
  // (studio cards, title cards, hard cuts to black). Clips that are >60% black
  // are skipped at the cleanClips stage.  Uses a 2 s minimum so brief fade-to-
  // blacks between scenes are NOT flagged — only sustained blank screens.
  // Hard 30 s timeout so this never blocks the render on a slow VPS.
  let _blackIntervals = [];
  try {
    _blackIntervals = await new Promise((resolve) => {
      const lines = [];
      const ff = spawn("ffmpeg", [
        "-i", sourcePath,
        "-vf", "blackdetect=d=2.0:pix_th=0.1",
        "-an", "-f", "null", "-",
      ], { stdio: ["ignore", "ignore", "pipe"] });
      ff.stderr.on("data", (d) => lines.push(d.toString()));
      ff.on("close", () => {
        const intervals = [];
        const combined = lines.join("");
        const re = /black_start:([\d.]+)\s+black_end:([\d.]+)/g;
        let m;
        while ((m = re.exec(combined)) !== null) {
          intervals.push({ start: parseFloat(m[1]), end: parseFloat(m[2]) });
        }
        resolve(intervals);
      });
      ff.on("error", () => resolve([]));
      setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} resolve([]); }, 30_000);
    });
    if (_blackIntervals.length > 0) {
      console.log(`[render ${jobId}] QC: ${_blackIntervals.length} black interval(s) detected in source`);
    }
  } catch { _blackIntervals = []; }

  // Returns true if a clip overlaps >60% with known black intervals.
  function _isBlackClip(start, end) {
    const dur = end - start;
    if (dur <= 0 || _blackIntervals.length === 0) return false;
    let overlap = 0;
    for (const bi of _blackIntervals) {
      const os = Math.max(start, bi.start);
      const oe = Math.min(end, bi.end);
      if (oe > os) overlap += oe - os;
    }
    return overlap / dur > 0.6;
  }

  const cleanClips = [];
  let droppedCount = 0;
  let blackDropped = 0;
  for (const ts of timestamps) {
    let start = Number(ts?.startSec);
    let end = Number(ts?.endSec);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { droppedCount++; continue; }
    if (start < 0) start = 0;
    if (end < 0) { droppedCount++; continue; }
    // Swap if reversed.
    if (end < start) { const t = start; start = end; end = t; }
    // Clamp to the source length (leave a small epsilon before EOF).
    if (Number.isFinite(hardMax)) {
      const ceil = Math.max(0, hardMax - 0.05);
      if (start >= ceil) { droppedCount++; continue; }
      if (end > ceil) end = ceil;
    }
    // Enforce a minimum visible duration; widen the end if there is room.
    if (end - start < MIN_CLIP_SEC) {
      end = Math.min(start + MIN_CLIP_SEC, Number.isFinite(hardMax) ? Math.max(0, hardMax - 0.05) : start + MIN_CLIP_SEC);
    }
    if (end - start < 0.1) { droppedCount++; continue; }
    // QC: skip clips that are predominantly black screen.
    if (_isBlackClip(start, end)) { blackDropped++; droppedCount++; continue; }
    cleanClips.push({ startSec: start, endSec: end, beatIndex: ts?.beatIndex });
  }
  if (blackDropped > 0) {
    console.log(`[render ${jobId}] QC: dropped ${blackDropped} black-frame clip(s) from timeline`);
  }

  if (cleanClips.length === 0) {
    throw new Error(
      `No valid clip ranges after sanitization (received ${timestamps.length}, all invalid). ` +
      `Re-run Step 2 to regenerate timestamps.`,
    );
  }
  if (droppedCount > 0) {
    await jobStore.update(jobId, { message: `Skipped ${droppedCount} invalid clip range(s)` });
    console.warn(`[render ${jobId}] dropped ${droppedCount}/${timestamps.length} invalid clip ranges`);
  }

  // ── HOOK V2 TTS + FOOTAGE ─────────────────────────────────────────────────
  // Helper: extract N evenly-spaced frames from a video as base64 JPEG strings.
  // Shared by hook and body-beat re-narration to ground Claude Haiku prompts in real footage.
  // Beat-based hook: TTS from _hookText, footage trimmed directly from
  // _hookV2BeatIds beats. Narration and footage reference the same story events.
  if (HOOK_V2 && _hookText && _hookV2BeatIds && _hookV2BeatIds.length > 0) {
    try {
      // Resolve TTS provider + key (same logic as body beats)
      const _hv2TtsProvider = String(settings?.ttsProvider || (() => {
        if (SERVER_SPEECHIFY_KEY)  return "speechify";
        if (SERVER_ELEVENLABS_KEY) return "elevenlabs";
        if (SERVER_HUME_KEY)       return "hume";
        if (SERVER_OPENAI_KEY)     return "openai";
        return "speechify";
      })()).toLowerCase();
      const _hv2TtsKey = (() => {
        switch (_hv2TtsProvider) {
          case "elevenlabs": return SERVER_ELEVENLABS_KEY;
          case "openai":     return SERVER_OPENAI_KEY;
          case "hume":       return SERVER_HUME_KEY;
          default:           return SERVER_SPEECHIFY_KEY || SERVER_OPENAI_KEY;
        }
      })();
      if (!_hv2TtsKey) throw new Error("No TTS key available for hook");
      const _hv2TtsVoice = (settings && settings.ttsVoice) || (
        _hv2TtsProvider === "elevenlabs" ? (SERVER_ELEVENLABS_VOICE || "JBFqnCBsd6RMkjVDRZzb") :
        _hv2TtsProvider === "hume"       ? (SERVER_HUME_VOICE || "Kora") :
        _hv2TtsProvider === "openai"     ? "onyx" : SERVER_SPEECHIFY_VOICE
      );
      const _hv2TtsSpeed = (settings && settings.ttsSpeed) || 1.0;

      // Generate TTS for hook narration
      const _hv2TtsRes = await generatePerBeatTTS(
        `${jobId}-hookv2`,
        [{ narration: _hookText, reason: _hookText }],
        _hv2TtsKey,
        { ttsProvider: _hv2TtsProvider, ttsVoice: _hv2TtsVoice, ttsSpeed: _hv2TtsSpeed },
      );
      if (!(_hv2TtsRes.length > 0 && _hv2TtsRes[0].id)) throw new Error("HOOK-V2 TTS returned no file");

      const _hv2TtsFileId = _hv2TtsRes[0].id;
      const _hv2TtsPath   = path.join(UPLOADS_DIR, _hv2TtsFileId);
      const _hv2VoiceDur  = await probeDurationSec(_hv2TtsPath);
      console.log(`[render ${jobId}] HOOK-V2 TTS: ${_hv2VoiceDur.toFixed(2)}s — id=${_hv2TtsFileId}`);

      // Trim one clip per sourceBeatId (chronological order preserved by selectHookBeats)
      const _hv2ClipPaths = [];
      const _hv2ClipDurs  = [];
      // Each clip gets an equal share of the voice duration so all clips are
      // visible in the final hook. Without this cap, expanded beat windows
      // (30-40s each) make the merged hook video far longer than the TTS;
      // the downstream muxer only shows the first clip's worth of footage.
      const _hv2PerClipMax = Math.max(2.0, _hv2VoiceDur / _hookV2BeatIds.length);
      for (let _ci = 0; _ci < _hookV2BeatIds.length; _ci++) {
        const beatIdx = _hookV2BeatIds[_ci];
        const hBeat   = beats[beatIdx];
        if (!hBeat) { console.warn(`[render ${jobId}] HOOK-V2 beat #${beatIdx} not found — skipping`); continue; }
        const hStart = Number(hBeat.startSec || 0);
        const hEnd   = Math.min(Number(hBeat.endSec || 0), hStart + _hv2PerClipMax);
        if (hEnd - hStart < 0.5) { console.warn(`[render ${jobId}] HOOK-V2 beat #${beatIdx} too short — skipping`); continue; }
        const hClipPath = path.join(UPLOADS_DIR, `hookv2-clip-${jobId}-${_ci}.mp4`);
        await new Promise((res) => {
          const ff = spawn("ffmpeg", buildTrimArgs({
            inputPath: sourcePath, startSec: hStart, endSec: hEnd,
            outputPath: hClipPath, reencode: true,
          }), { stdio: "ignore" });
          const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 60_000);
          ff.on("close", (code) => { clearTimeout(t); if (code === 0) _hv2ClipPaths.push(hClipPath); res(); });
          ff.on("error", () => { clearTimeout(t); res(); });
        });
        if (_hv2ClipPaths[_hv2ClipPaths.length - 1] === hClipPath) {
          _hv2ClipDurs.push(await probeDurationSec(hClipPath).catch(() => hEnd - hStart));
        }
      }
      if (_hv2ClipPaths.length === 0) throw new Error("All HOOK-V2 clip trims failed");

      // Duration matching: adjust last clip so footage ≈ voice ± 0.25s
      const _hv2FootageDurRaw = _hv2ClipDurs.reduce((a, b) => a + b, 0);
      const _hv2Diff = _hv2VoiceDur - _hv2FootageDurRaw;
      if (Math.abs(_hv2Diff) > 0.25) {
        const lastBeatIdx = _hookV2BeatIds[_hookV2BeatIds.length - 1];
        const lastBeat    = beats[lastBeatIdx];
        const lastClipPath = _hv2ClipPaths[_hv2ClipPaths.length - 1];
        if (lastBeat) {
          const lStart      = Number(lastBeat.startSec || 0);
          const lCurDur     = _hv2ClipDurs[_hv2ClipDurs.length - 1];
          const lTargetDur  = Math.max(0.5, lCurDur + _hv2Diff);
          // Cap extension to just before the next beat to avoid bleeding into body
          const nextBeat    = beats[lastBeatIdx + 1];
          const lMaxEnd     = nextBeat
            ? Math.min(Number(nextBeat.startSec) - 0.1, lStart + lTargetDur)
            : lStart + lTargetDur;
          const lNewEnd     = Math.max(lStart + 0.5, Math.min(lMaxEnd, lStart + lTargetDur));
          const adjPath     = path.join(UPLOADS_DIR, `hookv2-adj-${jobId}.mp4`);
          let adjOk = false;
          await new Promise((res) => {
            const ff = spawn("ffmpeg", buildTrimArgs({
              inputPath: sourcePath, startSec: lStart, endSec: lNewEnd,
              outputPath: adjPath, reencode: true,
            }), { stdio: "ignore" });
            const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 60_000);
            ff.on("close", (code) => { clearTimeout(t); adjOk = (code === 0); res(); });
            ff.on("error", () => { clearTimeout(t); res(); });
          });
          if (adjOk) {
            try { await fs.unlink(lastClipPath); } catch {}
            _hv2ClipPaths[_hv2ClipPaths.length - 1] = adjPath;
            _hv2ClipDurs[_hv2ClipDurs.length - 1] = await probeDurationSec(adjPath).catch(() => lTargetDur);
          }
        }
      }

      // Merge hook sub-clips into one video file.
      // Uses a two-stage approach for reliability:
      //   Stage 1: normalize each clip to 1920×1080 @25fps (separate ffmpeg per clip)
      //   Stage 2: concat demuxer (-f concat) — far more reliable than filter_complex
      //            which was always failing silently (empty stderr, non-zero exit).
      let _hv2MergedPath;
      if (_hv2ClipPaths.length === 1) {
        _hv2MergedPath = _hv2ClipPaths[0];
      } else {
        _hv2MergedPath = path.join(UPLOADS_DIR, `hookv2-merged-${jobId}.mp4`);
        let mergeOk = false;
        let _hv2MergeStderr = "";

        // Stage 1: normalize each clip to same resolution/fps so concat works cleanly
        const _normPaths = [];
        for (let _ni = 0; _ni < _hv2ClipPaths.length; _ni++) {
          const _normOut = path.join(UPLOADS_DIR, `hookv2-norm-${jobId}-${_ni}.mp4`);
          let _normStderr = "";
          const _normOk = await new Promise((res) => {
            const ff = spawn("ffmpeg", [
              "-y", "-hide_banner", "-loglevel", "error",
              "-i", _hv2ClipPaths[_ni],
              "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease," +
                     "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,setsar=1",
              "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-an",
              _normOut,
            ], { stdio: ["ignore", "ignore", "pipe"] });
            ff.stderr.on("data", (d) => { _normStderr += d.toString(); });
            const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(false); }, 60_000);
            ff.on("close", (code) => { clearTimeout(t); res(code === 0); });
            ff.on("error", () => { clearTimeout(t); res(false); });
          });
          if (_normOk) {
            _normPaths.push(_normOut);
          } else {
            console.warn(`[render ${jobId}] HOOK-V2 norm clip ${_ni} failed: ${_normStderr.trim().slice(-200)}`);
            _normPaths.push(_hv2ClipPaths[_ni]); // use original on norm failure
          }
        }

        // Stage 2: concat demuxer — write list file, then concat
        const _concatListPath = path.join(UPLOADS_DIR, `hookv2-list-${jobId}.txt`);
        await fs.writeFile(_concatListPath, _normPaths.map((p) => `file '${p}'`).join('\n'));
        await new Promise((res) => {
          const ff = spawn("ffmpeg", [
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", _concatListPath,
            "-c", "copy", "-an",
            _hv2MergedPath,
          ], { stdio: ["ignore", "ignore", "pipe"] });
          ff.stderr.on("data", (d) => { _hv2MergeStderr += d.toString(); });
          const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 90_000);
          ff.on("close", (code) => { clearTimeout(t); mergeOk = (code === 0); res(); });
          ff.on("error", (e) => { clearTimeout(t); console.warn(`[render ${jobId}] HOOK-V2 merge error:`, e?.message); res(); });
        });
        try { await fs.unlink(_concatListPath); } catch {}
        for (const np of _normPaths) { try { await fs.unlink(np); } catch {} }

        if (!mergeOk) {
          console.warn(`[render ${jobId}] HOOK-V2 multi-clip merge failed. FFmpeg stderr: ${_hv2MergeStderr.trim().slice(-400)}`);
          const _hv2BestClip = _hv2ClipPaths.reduce((best, p, i) =>
            (_hv2ClipDurs[i] || 0) > (_hv2ClipDurs[best] || 0) ? i : best, 0);
          console.warn(`[render ${jobId}] HOOK-V2 fallback: using single best clip [${_hv2BestClip}] (${(_hv2ClipDurs[_hv2BestClip] || 0).toFixed(1)}s)`);
          _hv2MergedPath = _hv2ClipPaths[_hv2BestClip];
          for (let _ci = 0; _ci < _hv2ClipPaths.length; _ci++) {
            if (_ci !== _hv2BestClip) { try { await fs.unlink(_hv2ClipPaths[_ci]); } catch {} }
          }
        } else {
          for (const cp of _hv2ClipPaths) { try { await fs.unlink(cp); } catch {} }
        }
      }

      // Store ready hook — prepend happens after body clips are trimmed (clipPaths defined below)
      _hv2ReadyPath  = _hv2MergedPath;
      _hv2ReadyTtsId = _hv2TtsFileId;

      // Validation log
      const _hv2FinalDur = _hv2ClipDurs.reduce((a, b) => a + b, 0);
      console.log(`[render ${jobId}] HOOK-V2 READY ✓`);
      console.log(`  text: "${_hookText.slice(0, 80)}..."`);
      console.log(`  sourceBeatIds: [${_hookV2BeatIds.join(",")}]`);
      console.log(`  footage: ${_hookV2BeatIds.map((idx) => { const b = beats[idx]; return b ? `${idx}→${Math.round(b.startSec)}-${Math.round(b.endSec)}s` : `${idx}→?`; }).join(", ")}`);
      console.log(`  narration=${_hv2VoiceDur.toFixed(2)}s footage=${_hv2FinalDur.toFixed(2)}s diff=${Math.abs(_hv2VoiceDur - _hv2FinalDur).toFixed(2)}s ${Math.abs(_hv2VoiceDur - _hv2FinalDur) <= 0.25 ? "PASS" : "WARN"}`);
    } catch (hv2Err) {
      console.warn(`[render ${jobId}] HOOK-V2 failed (non-fatal, video continues without hook):`, hv2Err?.message || hv2Err);
    }
  }
  // ── END HOOK V2 TTS + FOOTAGE ─────────────────────────────────────────────

  // ---- Parallel trim (6 concurrent ffmpeg jobs, 90s timeout per clip). ----
  // 6 concurrent jobs cuts trimming time ~6x vs sequential on the VPS (which
  // has ≥6 CPU cores). Raised from 3 → 6 after profiling showed 224 clips at
  // 3 parallel was the dominant render bottleneck (~25-40 min alone).
  // Each FFmpeg process has a hard 90s timeout so a single hung/corrupt clip
  // can never freeze the entire render.
  const trimResults = new Array(cleanClips.length).fill(null);
  // Worker-pool trimmer: keeps exactly PARALLEL_JOBS FFmpeg processes running
  // at all times. As soon as any clip finishes, the next one launches immediately.
  // This beats the old batch model (wait for ALL N to finish before starting
  // next N) where one slow clip in a batch blocked all the fast ones.
  const PARALLEL_JOBS   = 6;
  const TRIM_TIMEOUT_MS = 90_000;
  let trimmedCount = 0;

  await new Promise((resolvePool) => {
    let nextIndex   = 0;   // index of next clip to launch
    let active      = 0;   // currently running FFmpeg processes
    let settled     = false;

    const finish = () => {
      if (!settled) { settled = true; resolvePool(); }
    };

    const launchNext = () => {
      // Fill up to PARALLEL_JOBS concurrent processes
      while (active < PARALLEL_JOBS && nextIndex < cleanClips.length) {
        const i  = nextIndex++;
        const ts = cleanClips[i];
        const clipPath = path.join(UPLOADS_DIR, `clip-${jobId}-${String(i).padStart(3, "0")}.mp4`);

        let args;
        try {
          const beatForClip = Array.isArray(beats) && typeof ts.beatIndex === "number" ? beats[ts.beatIndex] : null;
          const clipSpeedFactor = (beatForClip?.slowFactor > 0 && beatForClip.slowFactor < 0.99)
            ? beatForClip.slowFactor : 1.0;
          args = buildTrimArgs({
            inputPath: sourcePath,
            startSec: ts.startSec,
            endSec: ts.endSec,
            outputPath: clipPath,
            reencode: true,
            speedFactor: clipSpeedFactor,
          });
        } catch (e) {
          console.warn(`[render ${jobId}] trim ${i} skipped (buildTrimArgs): ${e?.message || e}`);
          // Still counts as done for progress tracking
          trimmedCount++;
          const pct = 5 + Math.round((trimmedCount / cleanClips.length) * 35);
          jobStore.update(jobId, { progress: pct, message: `Trimmed ${trimmedCount}/${cleanClips.length}` }).catch(() => {});
          if (nextIndex >= cleanClips.length && active === 0) finish();
          continue;
        }

        active++;
        const ff = spawn("ffmpeg", args, { stdio: "ignore" });
        let clipSettled = false;
        const clipDone = () => {
          if (clipSettled) return;
          clipSettled = true;
          active--;
          trimmedCount++;
          const pct = 5 + Math.round((trimmedCount / cleanClips.length) * 35);
          jobStore.update(jobId, { progress: pct, message: `Trimmed ${trimmedCount}/${cleanClips.length}` }).catch(() => {});
          launchNext(); // immediately pull in the next waiting clip
          if (nextIndex >= cleanClips.length && active === 0) finish();
        };

        const timer = setTimeout(() => {
          try { ff.kill("SIGKILL"); } catch {}
          console.warn(`[render ${jobId}] ffmpeg trim ${i} timed out (${TRIM_TIMEOUT_MS / 1000}s) — skipping`);
          clipDone();
        }, TRIM_TIMEOUT_MS);

        ff.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) trimResults[i] = clipPath;
          else console.warn(`[render ${jobId}] ffmpeg trim ${i} failed (code ${code}) — skipping`);
          clipDone();
        });
        ff.on("error", (err) => {
          clearTimeout(timer);
          console.warn(`[render ${jobId}] ffmpeg trim ${i} spawn error: ${err?.message || err} — skipping`);
          clipDone();
        });
      }

      // Edge case: nothing was ever launched (0 clips)
      if (nextIndex >= cleanClips.length && active === 0) finish();
    };

    launchNext(); // kick off the pool
  });

  // Compact to only successfully-trimmed clips (no holes).
  let clipPaths = trimResults.filter((p) => p);
  if (clipPaths.length === 0) {
    throw new Error("All clip trims failed — check the source file and timestamps.");
  }

  // Hook is kept separate — it will be muxed as an independent segment after
  // the body BEAT-MUX completes, then prepended to the final manifest.
  // (No clipPaths / voiceoverFileIds modification here.)

  // ── HOOK FOOTAGE CLIP — DISABLED ─────────────────────────────────────────
  // Legacy hook system. Superseded by HOOK V2 above.
  if (false && _hookTtsId) {
    let _hSrcDur = 0;
    try { _hSrcDur = await probeDurationSec(sourcePath); } catch {}
    if (_hSrcDur > 40) {
      // Cap hook footage at first 35% of movie — prevents picking from the
      // climax/ending region that story beats already cover, which causes the
      // "same scene appears at hook AND near end" problem.
      const _hCeil = Math.min(_hSrcDur * 0.35, _hSrcDur - 60);
      try {
        const _hookMergedPath = path.join(UPLOADS_DIR, `hook-clip-${jobId}.mp4`);
        let _hookSubClips = [];

        // ── DIRECT-TIMESTAMP PATH (on-demand hook) ──────────────────────────
        // When the hook was generated on-demand, _hookDirectTimestamps holds the
        // actual {startSec,endSec} of the beats used to write the narration.
        // Use these directly — no position-index lookup table needed.
        if (_hookDirectTimestamps && _hookDirectTimestamps.length > 0) {
          for (let _di = 0; _di < _hookDirectTimestamps.length; _di++) {
            const dt = _hookDirectTimestamps[_di];
            const mid = (Number(dt.startSec) + Number(dt.endSec)) / 2;
            if (mid < 30 || mid > _hCeil - 5) {
              console.log(`[render ${jobId}] HOOK-DIRECT: idx=${_di} mid=${mid.toFixed(0)}s out of range — skipping`);
              continue;
            }
            const clipLen  = Math.min(6, Math.max(3, Number(dt.endSec) - Number(dt.startSec)));
            const subStart = Math.max(30, mid - clipLen / 2);
            const subEnd   = subStart + clipLen;
            const subPath  = path.join(UPLOADS_DIR, `hook-sub-${jobId}-d${_di}.mp4`);
            const subArgs  = buildTrimArgs({ inputPath: sourcePath, startSec: subStart, endSec: subEnd, outputPath: subPath, reencode: true });
            await new Promise((res) => {
              const ff = spawn("ffmpeg", subArgs, { stdio: "ignore" });
              const t  = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 60_000);
              ff.on("close", (code) => { clearTimeout(t); if (code === 0) _hookSubClips.push(subPath); res(); });
              ff.on("error", () => { clearTimeout(t); res(); });
            });
          }
          if (_hookSubClips.length > 0) {
            console.log(`[render ${jobId}] HOOK: direct-timestamp multi-clips: ${_hookSubClips.length} sub-clips from [${_hookDirectTimestamps.map(t => Math.round(t.startSec)).join(",")}]s`);
          }
        }
        // ── END DIRECT-TIMESTAMP PATH ────────────────────────────────────────

        // Primary lookup: scenesList index → exact detected scene boundaries.
        // Fallback A: _preTrimBeats index map (when scenesList absent from analyze job).
        const _hookSceneLookup = _scenesMap
          ?? (Array.isArray(_preTrimBeats) && _preTrimBeats.length > 0
            ? new Map(_preTrimBeats.map(b => [b.index, b]))
            : null);
        // Fallback B: 1-based beat POSITION map.
        // GPT is given the beat list as "${i+1}. narration" and returns hookSceneIds
        // as 1-based list positions (e.g. "2" means the 2nd beat, not scene index 2).
        // Those values get stored as if they are scene detection indices, so
        // _hookSceneLookup.get(2) finds FFmpeg scene #2 (early credits, ~60 s) instead
        // of the 2nd story beat.  This second map resolves the position interpretation.
        const _hookBeatPosLookup = Array.isArray(_preTrimBeats) && _preTrimBeats.length > 0
          ? new Map(_preTrimBeats.map((b, i) => [i + 1, b]))
          : null;
        console.log(
          `[render ${jobId}] HOOK-DBG: hookSceneIds=${JSON.stringify(_hookSceneIds)}, ` +
          `sceneLookup=${_hookSceneLookup ? _hookSceneLookup.size : 'null'}, ` +
          `beatPosLookup=${_hookBeatPosLookup ? _hookBeatPosLookup.size : 'null'}`
        );

        if (_hookSceneIds && _hookSceneIds.length > 0 && (_hookSceneLookup || _hookBeatPosLookup)) {
          // Multi-clip path: one 5-6 s clip per hookSceneId so footage mirrors
          // each dramatic moment the hook narration actually describes.
          for (let _hi = 0; _hi < _hookSceneIds.length; _hi++) {
            const id = _hookSceneIds[_hi];
            // Try scene-index lookup first.
            let sc = _hookSceneLookup?.get(id);
            // If scene-index lookup returned a very early scene (<90 s) it is probably
            // a credits/logo mismatch (GPT returned a beat position, not a scene index).
            // Fall back to the 1-based beat-position map in that case.
            if (!sc || (Number(sc.startSec) < 90 && _hookBeatPosLookup)) {
              const bpSc = _hookBeatPosLookup?.get(id);
              if (bpSc && Number(bpSc.startSec) >= 90) sc = bpSc;
            }
            if (!sc) {
              console.log(`[render ${jobId}] HOOK-DBG: id=${id} not in any lookup — skipping`);
              continue;
            }
            const mid     = (Number(sc.startSec) + Number(sc.endSec)) / 2;
            if (mid < 30 || mid > _hCeil - 5) {
              console.log(`[render ${jobId}] HOOK-DBG: id=${id} mid=${mid.toFixed(1)}s out of range (30..${(_hCeil-5).toFixed(0)}s) — skipping`);
              continue;
            }
            const clipLen = Math.min(6, Math.max(3, Number(sc.endSec) - Number(sc.startSec)));
            const subStart = Math.max(30, mid - clipLen / 2);
            const subEnd   = subStart + clipLen;
            const subPath  = path.join(UPLOADS_DIR, `hook-sub-${jobId}-${_hi}.mp4`);
            const subArgs  = buildTrimArgs({ inputPath: sourcePath, startSec: subStart, endSec: subEnd, outputPath: subPath, reencode: true });
            await new Promise((res) => {
              const ff = spawn("ffmpeg", subArgs, { stdio: "ignore" });
              const t  = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 60_000);
              ff.on("close", (code) => { clearTimeout(t); if (code === 0) _hookSubClips.push(subPath); res(); });
              ff.on("error", () => { clearTimeout(t); res(); });
            });
          }
          if (_hookSubClips.length > 0) {
            console.log(`[render ${jobId}] HOOK: trimmed ${_hookSubClips.length} sub-clips from hookSceneIds=[${_hookSceneIds.join(",")}]`);
          } else {
            console.log(`[render ${jobId}] HOOK-DBG: all hookSceneIds filtered — will try beat-based emergency clips`);
          }
        }

        // Emergency fallback: hookSceneIds lookup produced nothing.
        // Use the first 5 story beats (past the credits region) as hook footage.
        // These are guaranteed real story content in chronological order.
        if (_hookSubClips.length === 0 && Array.isArray(_preTrimBeats || beats)) {
          const _emergencySource = _preTrimBeats || beats;
          const _emergencyBeats  = _emergencySource
            .filter(b => Number(b.startSec) > 90 && Number(b.startSec) < _hCeil - 30)
            .slice(0, 8);
          for (let _ei = 0; _ei < _emergencyBeats.length && _hookSubClips.length < 5; _ei++) {
            const eb       = _emergencyBeats[_ei];
            const mid      = (Number(eb.startSec) + Number(eb.endSec)) / 2;
            const clipLen  = 5;
            const subStart = Math.max(30, mid - clipLen / 2);
            const subEnd   = subStart + clipLen;
            const subPath  = path.join(UPLOADS_DIR, `hook-sub-${jobId}-e${_ei}.mp4`);
            const subArgs  = buildTrimArgs({ inputPath: sourcePath, startSec: subStart, endSec: subEnd, outputPath: subPath, reencode: true });
            await new Promise((res) => {
              const ff = spawn("ffmpeg", subArgs, { stdio: "ignore" });
              const t  = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 60_000);
              ff.on("close", (code) => { clearTimeout(t); if (code === 0) _hookSubClips.push(subPath); res(); });
              ff.on("error", () => { clearTimeout(t); res(); });
            });
          }
          if (_hookSubClips.length > 0) {
            console.log(`[render ${jobId}] HOOK: emergency beat-clips: ${_hookSubClips.length} sub-clips from first story beats`);
          }
        }

        // Last resort: single clip from most dramatic moment in first 35%.
        // Clip duration matches the final hook TTS duration (after atempo speedup)
        // so the hook video and audio are perfectly aligned with no drift into body.
        if (_hookSubClips.length === 0) {
          // Default to 15% into movie (past credits, before climax)
          let _hDramaSec = Math.min(_hSrcDur * 0.15, _hCeil - 38);
          if (Array.isArray(beats) && beats.length > 2) {
            // Pick highest-importance beat that falls within the first 35% ceiling
            const earlyBeats = beats.filter(b => {
              const tc = (Number(b.startSec) + Number(b.endSec)) / 2;
              return tc > 120 && tc < _hCeil - 38;
            });
            if (earlyBeats.length > 0) {
              const top = earlyBeats.reduce((a, b) => (+(b.importance || 0) > +(a.importance || 0)) ? b : a, earlyBeats[0]);
              const tc  = (Number(top.startSec) + Number(top.endSec)) / 2;
              if (tc > 120 && tc < _hCeil - 38) _hDramaSec = tc;
            }
          }
          // Use the actual TTS duration (post-atempo) so the clip matches the audio exactly
          const _hClipDur = _hookFinalDurSec > 5 ? _hookFinalDurSec + 1 : 30;
          const _hStart  = Math.max(120, Math.min(_hDramaSec - _hClipDur / 2, _hCeil - _hClipDur - 5));
          const fallPath = path.join(UPLOADS_DIR, `hook-sub-${jobId}-0.mp4`);
          const fallArgs = buildTrimArgs({ inputPath: sourcePath, startSec: _hStart, endSec: _hStart + _hClipDur, outputPath: fallPath, reencode: true });
          await new Promise((res) => {
            const ff = spawn("ffmpeg", fallArgs, { stdio: "ignore" });
            const t  = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 60_000);
            ff.on("close", (code) => { clearTimeout(t); if (code === 0) _hookSubClips.push(fallPath); res(); });
            ff.on("error", () => { clearTimeout(t); res(); });
          });
          if (_hookSubClips.length > 0) {
            console.log(`[render ${jobId}] HOOK: last-resort single 32 s clip (drama@${Math.round(_hDramaSec)}s)`);
          }
        }

        if (_hookSubClips.length === 1) {
          clipPaths.unshift(_hookSubClips[0]);
          voiceoverFileIds.unshift(_hookTtsId);
          console.log(`[render ${jobId}] HOOK: single sub-clip prepended + TTS ${_hookTtsId}`);
        } else if (_hookSubClips.length > 1) {
          // Merge sub-clips into one hook track then prepend
          const _hManifest = path.join(UPLOADS_DIR, `hook-manifest-${jobId}.txt`);
          await fs.writeFile(_hManifest, _hookSubClips.map((p) => `file '${p}'`).join("\n"), "utf8");
          await new Promise((res) => {
            const ff = spawn("ffmpeg", [
              "-f", "concat", "-safe", "0", "-i", _hManifest,
              "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-an", "-y", _hookMergedPath,
            ], { stdio: "ignore" });
            const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 90_000);
            ff.on("close", (code) => {
              clearTimeout(t);
              if (code === 0) {
                clipPaths.unshift(_hookMergedPath);
                voiceoverFileIds.unshift(_hookTtsId);
                console.log(`[render ${jobId}] HOOK: ${_hookSubClips.length} sub-clips merged + prepended + TTS ${_hookTtsId}`);
              } else {
                console.warn(`[render ${jobId}] hook merge failed (code ${code}) — skipping hook`);
              }
              res();
            });
            ff.on("error", (e) => { clearTimeout(t); console.warn(`[render ${jobId}] hook merge error:`, e?.message || e); res(); });
          });
          for (const sc of _hookSubClips) { try { await fs.unlink(sc); } catch {} }
          try { await fs.unlink(_hManifest); } catch {}
        }
      } catch (hClipErr) {
        console.warn(`[render ${jobId}] hook clip failed (non-fatal):`, hClipErr?.message || hClipErr);
      }
    } // end if (_hSrcDur > 40)
  }
  // ── END HOOK FOOTAGE CLIP ─────────────────────────────────────────────────

  // ── OUTRO SEGMENT — DISABLED ─────────────────────────────────────────────
  // Outro removed. Video ends cleanly after last body beat.
  if (false) try {
    const _outroText = (typeof settings?.outroText === "string" && settings.outroText.trim())
      ? settings.outroText.trim()
      : "That's the complete story. If you enjoyed this breakdown, hit like and subscribe for more movie recaps every week.";
    if (_hookTtsKey) {
      const _outroTtsSpeed = (settings && settings.ttsSpeed) || 1.0;
      const _outroTtsId    = `${jobId}-outro-tts-beat-000.mp3`;
      const _outroTtsPath  = path.join(UPLOADS_DIR, _outroTtsId);
      let _outroDurSec     = 0;
      let _outroTtsOk      = false;

      // Attempt 1: primary TTS provider (same as story beats)
      try {
        await _ttsOnce(_hookTtsProvider, _hookTtsKey, _hookTtsVoice, _outroTtsSpeed, _outroText, _outroTtsPath);
        _outroDurSec = await probeDurationSec(_outroTtsPath);
        if (_outroDurSec > 0.1) { _outroTtsOk = true; }
      } catch (e1) {
        console.warn(`[render ${jobId}] OUTRO TTS: primary provider failed — ${e1?.message || e1}`);
      }

      // Attempt 2: OpenAI fallback (reliable, always available)
      if (!_outroTtsOk && SERVER_OPENAI_KEY) {
        try {
          await new Promise(r => setTimeout(r, 2000)); // brief pause before fallback
          await _ttsOnce("openai", SERVER_OPENAI_KEY, "onyx", 1.0, _outroText, _outroTtsPath);
          _outroDurSec = await probeDurationSec(_outroTtsPath);
          if (_outroDurSec > 0.1) { _outroTtsOk = true; console.log(`[render ${jobId}] OUTRO TTS: used OpenAI fallback`); }
        } catch (e2) {
          console.warn(`[render ${jobId}] OUTRO TTS: OpenAI fallback also failed — ${e2?.message || e2}`);
        }
      }

      if (!_outroTtsOk) {
        console.warn(`[render ${jobId}] OUTRO TTS: all providers failed — outro skipped`);
      }

      if (_outroTtsOk) {
        console.log(`[render ${jobId}] OUTRO TTS: ${_outroDurSec.toFixed(1)}s — id=${_outroTtsId}`);
        // Use footage from 55% into the film — avoids the climax/ending region
        // that story beats already cover (last 30%), preventing the same footage
        // appearing in the outro that viewers just watched in beats 70-80.
        let _oSrcDur = 0;
        try { _oSrcDur = await probeDurationSec(sourcePath); } catch {}
        if (_oSrcDur > 60) {
          const _oStart    = Math.max(30, _oSrcDur * 0.55);
          const _oEnd      = Math.min(_oSrcDur - 3, _oStart + Math.max(_outroDurSec + 3, 15));
          const _oClipPath = path.join(UPLOADS_DIR, `outro-clip-${jobId}.mp4`);
          const _oArgs     = buildTrimArgs({ inputPath: sourcePath, startSec: _oStart, endSec: _oEnd, outputPath: _oClipPath, reencode: true });
          await new Promise((res) => {
            const ff = spawn("ffmpeg", _oArgs, { stdio: "ignore" });
            const t  = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(); }, 90_000);
            ff.on("close", (code) => {
              clearTimeout(t);
              if (code === 0) {
                clipPaths.push(_oClipPath);
                voiceoverFileIds.push(_outroTtsId);
                console.log(`[render ${jobId}] OUTRO: appended clip (${_oStart.toFixed(0)}–${_oEnd.toFixed(0)}s) + TTS ${_outroTtsId}`);
              } else {
                console.warn(`[render ${jobId}] outro clip failed (code ${code}) — skipping`);
              }
              res();
            });
            ff.on("error", (e) => { clearTimeout(t); console.warn(`[render ${jobId}] outro clip error:`, e?.message || e); res(); });
          });
        }
      }
    }
  } catch (outroErr) {
    console.warn(`[render ${jobId}] outro generation failed (non-fatal):`, outroErr?.message || outroErr);
  }
  // ── END OUTRO SEGMENT ─────────────────────────────────────────────────────

  const outputPath     = path.join(OUTPUT_DIR, `recap-${jobId}.mp4`);
  let musicPath        = musicPathOverride
    ? musicPathOverride
    : (musicFileId ? path.join(UPLOADS_DIR, musicFileId) : null);
  let adaptiveMusicPath = null;
  let outputDurationSec = 0; // used by poster generation below

  // ── BEAT-BY-BEAT MUX ─────────────────────────────────────────────────────
  // GROUP-BY-BEAT MUX: concat each beat's sub-clips into one beat video (video-only),
  // then mux with the beat's full TTS voice file using -shortest.
  // This ensures narration plays CONTINUOUSLY over all visual cuts within a beat —
  // no audio interruption at 6-second sub-clip boundaries.
  //
  // clipPaths layout: [sub1_b0, sub2_b0, sub3_b0, sub1_b1, ...]
  //   Hook is NOT in clipPaths — it is muxed independently after body BEAT-MUX.
  //   cleanClips[j].beatIndex → which beat owns sub-clip j
  //   voiceoverFileIds[beatIndex] → the beat's TTS file

  // Build beat groups: beatIndex → [clipPath, ...] in timeline order
  const _beatGroupMap = new Map();
  for (let _j = 0; _j < cleanClips.length; _j++) {
    const _bi = typeof cleanClips[_j].beatIndex === "number" ? cleanClips[_j].beatIndex : _j;
    if (!_beatGroupMap.has(_bi)) _beatGroupMap.set(_bi, []);
    _beatGroupMap.get(_bi).push(clipPaths[_j]);
  }
  // Ordered list of unique beat indices (preserves timeline order)
  const _beatOrder = [...new Set(cleanClips.map((cc) => typeof cc.beatIndex === "number" ? cc.beatIndex : 0))];
  console.log(`[render ${jobId}] BEAT-MUX MAP: ${cleanClips.length} sub-clips → ${_beatOrder.length} body beats`);

  // Helper: mux a video file with a voice TTS file (no audio seek needed — full beat voice)
  // padSec is dynamic — callers pass the probed TTS-video gap so the pad is exactly what's
  // needed, avoiding 2s of frozen-frame clone on beats where TTS fits the footage tightly.
  const _muxVideoWithVoice = (videoPath, voicePath, outPath, padSec = 0.25) => new Promise((res) => {
    // Video gets tpad=0.6s clone frames so there is always a visual tail after narration.
    // Audio is mapped directly (no apad filter) — apad+filter_complex+shortest caused
    // audio corruption (stammering, silent beats) on this FFmpeg build.
    //
    // -shortest stops at whichever stream ends first:
    //   • Speechify MP3 files carry 0.7–2.6s trailing silence after last word.
    //   • video(phase-A ≈ contentDur) + tpad(0.6s) < audio(contentDur + silence)
    //     → video wins → output = contentDur + 0.6s visual tail  ✓
    //   • If silence < 0.6s: audio wins → output = contentDur + silence  ✓
    //
    // CASE 1 (video ≈ TTS content):  output = contentDur + 0.6s tail   ✓
    // CASE 2 (video > TTS content):  output = audio file duration       ✓
    const ff = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "warning",
      "-i", videoPath,
      "-i", voicePath,
      "-filter_complex",
        `[0:v]tpad=stop_mode=clone:stop_duration=0.600[vpad]`,
      "-map", "[vpad]", "-map", "1:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-shortest", outPath,
    ], { stdio: "ignore" });
    const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(false); }, 180_000);
    ff.on("close", (code) => { clearTimeout(t); res(code === 0); });
    ff.on("error", () => { clearTimeout(t); res(false); });
  });

  // Helper: concat multiple video-only clips into one using filter_complex (robust to VFR)
  const _concatVideoClips = (clips, outPath) => new Promise((res) => {
    const _inputs  = clips.flatMap((p) => ["-i", p]);
    const _filter  = clips.map((_, k) => `[${k}:v]`).join("") +
                     `concat=n=${clips.length}:v=1:a=0[vout]`;
    const ff = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "warning",
      ..._inputs,
      "-filter_complex", _filter,
      "-map", "[vout]",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-an",
      outPath,
    ], { stdio: "ignore" });
    const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(false); }, 120_000);
    ff.on("close", (code) => { clearTimeout(t); res(code === 0); });
    ff.on("error", () => { clearTimeout(t); res(false); });
  });

  await jobStore.update(jobId, { progress: 45, message: "Assembling beat videos" });
  const _muxedPaths = [];

  // ── PHASE A: BUILD BEAT VIDEOS ───────────────────────────────────────────────
  // Concat each beat's sub-clips into a single video-only file.
  // Audio is master: TTS duration drives all footage timing decisions.
  const _beatVideoStore = new Map(); // bi → assembled video path (no audio)

  for (const _bi of _beatOrder) {
    const _beatClips = _beatGroupMap.get(_bi) || [];
    if (_beatClips.length === 0) continue;
    let _beatVidPath;
    if (_beatClips.length === 1) {
      _beatVidPath = _beatClips[0];
    } else {
      _beatVidPath = path.join(UPLOADS_DIR, `beat-concat-${jobId}-${String(_bi).padStart(3, "0")}.mp4`);
      const concatOk = await _concatVideoClips(_beatClips, _beatVidPath);
      if (!concatOk) {
        console.warn(`[render ${jobId}] beat-concat ${_bi} failed — using first sub-clip`);
        _beatVidPath = _beatClips[0];
      }
    }
    _beatVideoStore.set(_bi, _beatVidPath);
  }
  console.log(`[render ${jobId}] PHASE-A: ${_beatVideoStore.size} beat videos assembled`);

  // ── PHASE B: GAP-FILL + VOICE MUX ────────────────────────────────────────────
  // Audio is master. TTS (per-beat, measured from generated audio) drives footage timing.
  // • TTS > video → gap-fill: borrow adjacent scene footage from source.
  // • Video > TTS → -shortest trims to audio end; 0.3s visual tail (lead-out).
  // • Sync validation per beat: drift ≤0.30s PASS / ≤0.75s WARN / >0.75s FIX.
  await jobStore.update(jobId, { progress: 60, message: "Muxing beats" });
  let _beatMuxDone = 0;
  let _syncPass = 0, _syncWarn = 0, _syncFix = 0;
  for (const _bi of _beatOrder) {
    const _beatRawVidPath = _beatVideoStore.get(_bi);
    if (!_beatRawVidPath) {
      const _beatClips = _beatGroupMap.get(_bi) || [];
      _muxedPaths.push(..._beatClips);
      _beatMuxDone++;
      continue;
    }

    // TTS: always from original per-beat voice generated during PER-BEAT TTS step
    const _voId    = voiceoverFileIds[_bi] || null;
    const _voPath  = _voId ? path.join(UPLOADS_DIR, _voId) : null;

    if (!_voPath) {
      _muxedPaths.push(_beatRawVidPath);
      _beatMuxDone++;
      continue;
    }
    let _hasVoice = false;
    try { await fs.access(_voPath); _hasVoice = true; } catch {}
    if (!_hasVoice) {
      _muxedPaths.push(_beatRawVidPath);
      _beatMuxDone++;
      continue;
    }

    let _beatVideoPath = _beatRawVidPath;

    // ── AUDIO-MASTER SYNC ─────────────────────────────────────────────────────
    // Spec: TTS is the master timeline. Video always adapts — never reverse.
    // CASE 1 (video < TTS content): gap-fill via Steps 1→4.
    // CASE 2 (video > TTS content): _muxVideoWithVoice -shortest trims at audio end.
    const _muxPadSec = 0.25;  // spec: 0.2–0.3s visual tail
    {
      const _vidDur = await probeDurationSec(_beatVideoPath).catch(() => 0);

      // Use NARRATION CONTENT duration, not full MP3 file duration.
      // Speechify MP3 files contain 0.7–2.6s of trailing silence after the last
      // spoken word. probeDurationSec(_voPath) returns the full file length, which
      // caused gap-fill to fire on every beat trying to match silence that the mux
      // discards anyway. Use whisperBeatDurations (content-only, from Whisper word
      // alignment) or _perBeatTtsDurations (measured during generation) instead.
      const _tsDurArr = Array.isArray(whisperBeatDurations) ? whisperBeatDurations
                      : Array.isArray(_perBeatTtsDurations) ? _perBeatTtsDurations
                      : null;
      const _voiDur = (_tsDurArr && Number(_tsDurArr[_bi]) > 0.05)
        ? Number(_tsDurArr[_bi])
        : await probeDurationSec(_voPath).catch(() => 0);

      const _gap    = _voiDur - _vidDur;  // +ve = video short, -ve = video long

      if (_gap > 0.30 && _vidDur > 0) {
        // CASE 1: video shorter than TTS by > 0.30s
        const _beat      = beats[_bi];
        const _nextBeat  = beats[_bi + 1];
        const _beatStart = Number(_beat?.startSec || 0);
        const _beatEnd   = Number(_beat?.endSec   || _beatStart + _vidDur);
        const _nextStart = _nextBeat ? Number(_nextBeat.startSec) : _beatEnd + 120;
        const _target    = _voiDur + 0.25;  // desired clip duration

        let _extPath = _beatVideoPath;
        let _extDur  = _vidDur;

        // STEP 1+2: re-trim beat's own source window (same sceneIds), just longer
        {
          const _s1End = Math.min(_beatStart + _target, _nextStart - 0.1);
          if (_s1End > _beatEnd + 0.2 && _beatStart >= 0) {
            const _s1Path = path.join(UPLOADS_DIR, `beat-gf1-${jobId}-${String(_bi).padStart(3,"0")}.mp4`);
            const _s1Ok   = await new Promise((res) => {
              const ff = spawn("ffmpeg", buildTrimArgs({
                inputPath: sourcePath, startSec: _beatStart, endSec: _s1End,
                outputPath: _s1Path, reencode: true,
              }), { stdio: "ignore" });
              const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(false); }, 90_000);
              ff.on("close", (code) => { clearTimeout(t); res(code === 0); });
              ff.on("error", () => { clearTimeout(t); res(false); });
            });
            if (_s1Ok) {
              const _s1Dur = await probeDurationSec(_s1Path).catch(() => 0);
              if (_s1Dur > _extDur) { _extPath = _s1Path; _extDur = _s1Dur; }
            }
          }
        }

        // STEP 3: immediately adjacent scenes from same continuous event (+1, +2 only)
        if (_target - _extDur > 0.30 && _scenesMap && Array.isArray(_beat?.sceneIds) && _beat.sceneIds.length > 0) {
          const _lastScId = _beat.sceneIds[_beat.sceneIds.length - 1];
          for (const adjId of [_lastScId + 1, _lastScId + 2]) {
            if (_target - _extDur <= 0.30) break;
            const adjScene = _scenesMap.get(adjId);
            if (!adjScene) break;
            const adjEnd = Math.min(Number(adjScene.endSec), _nextStart - 0.1);
            if (adjEnd <= _beatStart + _extDur + 0.2) break;
            const _s3Path = path.join(UPLOADS_DIR, `beat-gf3-${jobId}-${String(_bi).padStart(3,"0")}-s${adjId}.mp4`);
            const _s3Ok   = await new Promise((res) => {
              const ff = spawn("ffmpeg", buildTrimArgs({
                inputPath: sourcePath, startSec: _beatStart, endSec: adjEnd,
                outputPath: _s3Path, reencode: true,
              }), { stdio: "ignore" });
              const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(false); }, 90_000);
              ff.on("close", (code) => { clearTimeout(t); res(code === 0); });
              ff.on("error", () => { clearTimeout(t); res(false); });
            });
            if (_s3Ok) {
              const _s3Dur = await probeDurationSec(_s3Path).catch(() => 0);
              if (_s3Dur > _extDur) {
                _extPath = _s3Path; _extDur = _s3Dur;
                console.log(`[render ${jobId}] GAP-FILL beat ${_bi}: Step3 adj scene ${adjId} → ${_extDur.toFixed(1)}s`);
              }
            }
          }
        }

        // STEP 4: slow motion — last resort (spec: 0.85–0.95x, prefer 0.90–0.95x)
        if (_target - _extDur > 0.30 && _extDur > 0.5) {
          const _rawSpeed = _extDur / _target;
          const _speed    = Math.max(0.85, Math.min(0.95, _rawSpeed));
          const _s4Path   = path.join(UPLOADS_DIR, `beat-gf4-${jobId}-${String(_bi).padStart(3,"0")}.mp4`);
          const _s4Ok     = await new Promise((res) => {
            const ff = spawn("ffmpeg", buildTrimArgs({
              inputPath: _extPath, startSec: 0, endSec: _extDur,
              outputPath: _s4Path, reencode: true, speedFactor: _speed,
            }), { stdio: "ignore" });
            const t = setTimeout(() => { try { ff.kill("SIGKILL"); } catch {} res(false); }, 120_000);
            ff.on("close", (code) => { clearTimeout(t); res(code === 0); });
            ff.on("error", () => { clearTimeout(t); res(false); });
          });
          if (_s4Ok) {
            const _s4Dur = await probeDurationSec(_s4Path).catch(() => 0);
            console.log(`[render ${jobId}] GAP-FILL beat ${_bi}: Step4 slow-mo ${_speed.toFixed(2)}x → ${_s4Dur.toFixed(1)}s`);
            if (_s4Dur > _extDur) { _extPath = _s4Path; _extDur = _s4Dur; }
          }
        }

        if (_extPath !== _beatVideoPath) {
          const _finalDrift = Math.abs(_voiDur - _extDur);
          console.log(`[render ${jobId}] GAP-FILL beat ${_bi}: ${_vidDur.toFixed(1)}s→${_extDur.toFixed(1)}s tts=${_voiDur.toFixed(1)}s drift=${_finalDrift.toFixed(2)}s`);
          _beatVideoPath = _extPath;
          if (beats[_bi]) beats[_bi] = { ...beats[_bi], endSec: _beatStart + _extDur };
        }
      }

      // Sync validation — checked AFTER gap-fill; CASE 2 always passes (mux handles it)
      const _postVidDur = _gap > 0.30
        ? await probeDurationSec(_beatVideoPath).catch(() => _vidDur)
        : _vidDur;
      const _drift = _gap > 0.30 ? Math.abs(_voiDur - _postVidDur) : 0;
      if      (_drift <= 0.30) { _syncPass++; }
      else if (_drift <= 0.75) { _syncWarn++; console.warn(`[render ${jobId}] SYNC-WARN beat ${_bi}: post-fill drift=${_drift.toFixed(2)}s`); }
      else                     { _syncFix++;  console.warn(`[render ${jobId}] SYNC-FIX  beat ${_bi}: post-fill drift=${_drift.toFixed(2)}s`); }
    }
    // ── END GAP-FILL ──────────────────────────────────────────────────────────

    // Step 2: mux beat video + voice file
    const _beatMuxPath = path.join(UPLOADS_DIR, `beat-muxed-${jobId}-${String(_bi).padStart(3, "0")}.mp4`);
    const muxOk = await _muxVideoWithVoice(_beatVideoPath, _voPath, _beatMuxPath, _muxPadSec);
    if (!muxOk) {
      console.warn(`[render ${jobId}] beat-mux ${_bi} failed — silent fallback`);
      _muxedPaths.push(_beatVideoPath);
    } else {
      _muxedPaths.push(_beatMuxPath);
    }

    _beatMuxDone++;
    if (_beatMuxDone % 10 === 0) {
      try { await jobStore.update(jobId, {
        progress: Math.round(60 + (_beatMuxDone / _beatOrder.length) * 5),
        message: `Muxing beat ${_beatMuxDone}/${_beatOrder.length}`,
      }); } catch {}
    }
  }
  console.log(`[render ${jobId}] BEAT-MUX: ${_muxedPaths.length} body segments from ${_beatOrder.length} beats`);
  console.log(`[render ${jobId}] SYNC-VALIDATION: ${_syncPass} PASS / ${_syncWarn} WARN / ${_syncFix} FIX`);
  // ── END BEAT-BY-BEAT MUX ─────────────────────────────────────────────────

  // ── HOOK-V2 SEGMENT ───────────────────────────────────────────────────────
  // Hook video and TTS are fully independent of the body pipeline.
  // Mux them here into a self-contained hook segment, then prepend it to the
  // final manifest. FFmpeg sees the hook as a finished MP4 — no shared
  // pipeline state with body beats.
  if (HOOK_V2 && _hv2ReadyPath && _hv2ReadyTtsId) {
    const _hookSegPath = path.join(UPLOADS_DIR, `hookv2-segment-${jobId}.mp4`);
    console.log(`[render ${jobId}] HOOK-V2 SEGMENT: muxing hook video + TTS independently…`);
    const _hookSegOk = await _muxVideoWithVoice(
      _hv2ReadyPath,
      path.join(UPLOADS_DIR, _hv2ReadyTtsId),
      _hookSegPath,
      0.3,
    );
    if (_hookSegOk) {
      _muxedPaths.unshift(_hookSegPath);
      console.log(`[render ${jobId}] HOOK-V2 SEGMENT: done — prepended to final manifest (${_hookSegPath.split("/").pop()})`);
    } else {
      console.warn(`[render ${jobId}] HOOK-V2 SEGMENT: mux failed — hook omitted from output`);
    }
  }
  // ── END HOOK-V2 SEGMENT ───────────────────────────────────────────────────

  const manifestPath  = path.join(UPLOADS_DIR, `concat-${jobId}.txt`);
  await fs.writeFile(manifestPath, buildConcatManifest(_muxedPaths), "utf8");

  // Measure total output duration for poster frame calculation
  try {
    const _mDurs = await Promise.all(_muxedPaths.map(p => probeDurationSec(p).catch(() => 0)));
    outputDurationSec = _mDurs.reduce((a, b) => a + (Number(b) || 0), 0);
  } catch {}

  // ── SCENE-ADAPTIVE MUSIC ─────────────────────────────────────────────────
  // When sceneAdaptiveMusic is true and Claude gave each beat a mood, stitch
  // mood beds together (crossfaded) instead of looping a single bed.
  if (sceneAdaptiveMusic &&
      Array.isArray(syncMoods) && syncMoods.length > 0 &&
      Array.isArray(syncBeatDurations) && syncBeatDurations.length === syncMoods.length) {
    const _amSpans = syncMoods.map((mood, i) => ({ mood, durationSec: syncBeatDurations[i] || 15 }));
    const _amTotal = outputDurationSec > 0
      ? outputDurationSec
      : _amSpans.reduce((s, sp) => s + sp.durationSec, 0);
    try {
      adaptiveMusicPath = await buildSceneAdaptiveMusic({
        spans: _amSpans,
        musicDir: MUSIC_DIR,
        outPath: path.join(UPLOADS_DIR, `adaptive-music-${jobId}.mp3`),
        totalSec: _amTotal,
      });
      if (adaptiveMusicPath) {
        musicPath = adaptiveMusicPath;
        const moodList = [...new Set(_amSpans.map(s => s.mood))].join(", ");
        console.log(`[render ${jobId}] ADAPTIVE MUSIC: ${_amSpans.length} spans (${moodList}) → ${_amTotal.toFixed(0)}s`);
      }
    } catch (_amErr) {
      console.warn(`[render ${jobId}] Adaptive music build failed, using fixed mood fallback:`, _amErr?.message || _amErr);
    }
  }
  // ── END SCENE-ADAPTIVE MUSIC ──────────────────────────────────────────────

  // Build final encode filter: scale/pad/fps + optional music bed
  const _finalS  = normaliseRenderSettings(settings);
  const _finalVf = [
    `scale=${_finalS.width}:${_finalS.height}:force_original_aspect_ratio=decrease`,
    `pad=${_finalS.width}:${_finalS.height}:(ow-iw)/2:(oh-ih)/2:black`,
    `fps=${_finalS.fps}`,
  ].join(",");

  const _hasFinalMusic = !!musicPath;
  // Music volume: default -18 dB (was -14 — felt too loud vs narration).
  // Sidechaincompress ducks it further (~20:1) whenever narration is audible,
  // so music is practically inaudible during speech and rises in pauses.
  const _musicVol = Number.isFinite(Number(musicVolumeDb)) ? Number(musicVolumeDb) : -18;
  const _finalFilter = _hasFinalMusic
    ? `[0:v]${_finalVf}[vout];` +
      // aresample=async=1 → absorbs accumulated AAC encoder-delay drift from
      // 75 individually-muxed beat segments (~21 ms/segment × 75 = ~1.6 s without fix).
      // apad=pad_dur=0.5 → ensures narration audio never ends before the video
      // track (prevents silent final scene when audio is microseconds short).
      // asplit → one copy goes to the output mix, one acts as sidechain detector.
      `[0:a]aresample=async=1,apad=pad_dur=0.5,asplit=2[voice_out][voice_sc];` +
      `[1:a]aloop=loop=-1:size=2147483647,volume=${_musicVol}dB,` +
      `aformat=sample_fmts=fltp:channel_layouts=stereo[music_raw];` +
      // sidechaincompress: threshold=0.02 (voice above 2% amplitude triggers ducking),
      // ratio=20:1 (heavy compression so music is nearly inaudible during speech),
      // attack=100ms (smooth onset), release=800ms (music fades back in gradually).
      `[music_raw][voice_sc]sidechaincompress=threshold=0.02:ratio=20:` +
      `attack=100:release=800:level_sc=0.8[music_ducked];` +
      `[voice_out][music_ducked]amix=inputs=2:duration=first:normalize=0[aout]`
    : `[0:v]${_finalVf}[vout];` +
      `[0:a]aresample=async=1,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`;

  const _encPreset = _finalS.codec === "libx264" ? "ultrafast" : "fast";
  const _finalArgs = [
    "-y", "-hide_banner", "-loglevel", "info", "-stats", "-progress", "pipe:1",
    "-f", "concat", "-safe", "0", "-i", manifestPath,
    ...(_hasFinalMusic ? ["-i", musicPath] : []),
    "-filter_complex", _finalFilter,
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", _finalS.codec, "-crf", String(_finalS.crf), "-preset", _encPreset, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart",
    outputPath,
  ];

  await jobStore.update(jobId, { progress: 62, message: "Encoding final video" });

  await new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", _finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let lastProgress = 62;
    let stderrTail = "";
    let settled = false;

    let lastTick = Date.now();
    const watchdog = setInterval(() => {
      if (settled) return;
      if (Date.now() - lastTick > 120_000) {
        try { ff.kill("SIGKILL"); } catch {}
        finish(new Error("ffmpeg encode stalled: no progress for 120s (killed by watchdog)"));
      }
    }, 10_000);

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      if (err) reject(err); else resolve();
    };

    const bumpProgress = async (sec) => {
      lastTick = Date.now();
      const totalOut = outputDurationSec > 0 ? outputDurationSec : 0;
      const frac = totalOut > 0 ? Math.min(1, sec / totalOut) : 0;
      const next = Math.min(95, Math.round(62 + frac * 33));
      if (next > lastProgress) {
        lastProgress = next;
        const mm = Math.floor(sec / 60), ss = Math.floor(sec % 60);
        try { await jobStore.update(jobId, { progress: next, message: `Encoding ${mm}:${String(ss).padStart(2, "0")}` }); } catch {}
      }
    };

    ff.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      const m = text.match(/out_time_ms=(\d+)/);
      if (m) { bumpProgress(Number(m[1]) / 1_000_000); return; }
      const t = text.match(/out_time=(\d+):(\d+):(\d+\.?\d*)/);
      if (t) bumpProgress(Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]));
    });
    ff.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      const m = text.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (m) bumpProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
    ff.on("error", (e) => finish(new Error(`ffmpeg failed to start: ${e.message}`)));
    ff.on("close", (code) => {
      if (code === 0) return finish();
      const tail = stderrTail.split("\n").slice(-6).join(" · ").slice(0, 600);
      finish(new Error(`ffmpeg encode failed (code ${code}): ${tail || "see server logs"}`));
    });
  });

  // Generate a poster/thumbnail JPG from the finished recap (best-effort, never
  // fails the job). Grab a frame ~10% in (avoids the very first dark frame).
  let posterPath = null;
  try {
    // Grab at 30% — typically mid-Act-1, the first major dramatic scene.
    // Avoids the dark opening-title frames that 10% often lands on.
    const posterSec = Number.isFinite(outputDurationSec) && outputDurationSec > 0
      ? Math.min(Math.max(outputDurationSec * 0.3, 1), outputDurationSec - 0.5)
      : 2;
    posterPath = path.join(OUTPUT_DIR, `recap-${jobId}.jpg`);
    // Extract 5 candidate frames spread across 20-60% of the video and
    // keep the brightest one (avoids dark transitions / letterbox frames).
    const candidatePct = [0.20, 0.30, 0.40, 0.50, 0.60];
    let bestPoster = null;
    let bestBrightness = -1;
    for (const pct of candidatePct) {
      const capSec = Number.isFinite(outputDurationSec) && outputDurationSec > 1
        ? Math.min(outputDurationSec * pct, outputDurationSec - 0.5)
        : pct * 10;
      const candPath = path.join(OUTPUT_DIR, `tmp-poster-${jobId}-${Math.round(pct*100)}.jpg`);
      const ok = await new Promise((resolve) => {
        const ff = spawn("ffmpeg", [
          "-y", "-loglevel", "error",
          "-ss", capSec.toFixed(3),
          "-i", outputPath,
          "-vframes", "1",
          "-vf", "scale=1280:-2",
          "-q:v", "3",
          candPath,
        ], { stdio: "ignore" });
        ff.on("close", (code) => resolve(code === 0));
        ff.on("error", () => resolve(false));
      });
      if (!ok) continue;
      // Measure brightness via ffprobe signalstats.
      const brightness = await new Promise((resolve) => {
        let out = "";
        const fp = spawn("ffprobe", [
          "-v", "error", "-select_streams", "v:0",
          "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
          "-f", "lavfi",
          `movie=${candPath},signalstats`,
          "-of", "default=nw=1:nk=1",
        ], { stdio: ["ignore", "pipe", "ignore"] });
        fp.stdout.on("data", (c) => { out += c.toString(); });
        fp.on("close", () => resolve(parseFloat(out.trim()) || 0));
        fp.on("error", () => resolve(0));
      });
      if (brightness > bestBrightness) {
        bestBrightness = brightness;
        bestPoster = candPath;
      }
    }
    if (bestPoster) {
      try { await fs.rename(bestPoster, posterPath); } catch { bestPoster = null; }
    }
    // Clean up any remaining candidates.
    for (const pct of candidatePct) {
      const c = path.join(OUTPUT_DIR, `tmp-poster-${jobId}-${Math.round(pct*100)}.jpg`);
      try { await fs.unlink(c); } catch {}
    }
    if (!bestPoster) {
      // Fallback: original single-frame extract.
      await new Promise((resolve) => {
        const ff = spawn("ffmpeg", [
          "-y", "-loglevel", "error",
          "-ss", posterSec.toFixed(3),
          "-i", outputPath,
          "-vframes", "1",
          "-vf", "scale=1280:-2",
          "-q:v", "3",
          posterPath,
        ], { stdio: "ignore" });
        ff.on("close", (code) => resolve(code === 0));
        ff.on("error", () => resolve(false));
      });
    }
    // Verify the file actually exists; if not, drop it.
    try { await fs.stat(posterPath); } catch { posterPath = null; }
  } catch {
    posterPath = null;
  }

  // ── ENHANCE POSTER + PRE-GENERATE VARIANTS (best-effort, never fails job) ──
  // Apply a cinematic grade to the real movie frame we already extracted.
  // No DALL-E — thumbnails are always actual frames from the film.
  if (posterPath) {
    try {
      const tmpEnhanced = posterPath + ".enh.jpg";
      const ok = await new Promise((resolve) => {
        const ff = spawn("ffmpeg", [
          "-y", "-loglevel", "error",
          "-i", posterPath,
          "-vf", "eq=contrast=1.25:brightness=-0.03:saturation=0.95,unsharp=5:5:0.6:3:3:0.0,vignette=PI/5",
          "-q:v", "2",
          tmpEnhanced,
        ], { stdio: "ignore" });
        ff.on("close", (c) => resolve(c === 0));
        ff.on("error", () => resolve(false));
      });
      if (ok) {
        try { await fs.rename(tmpEnhanced, posterPath); } catch { try { await fs.unlink(tmpEnhanced); } catch {} }
      }
      console.log(`[render ${jobId}] poster frame enhanced (dramatic grade)`);
    } catch (e) {
      console.warn(`[render ${jobId}] poster enhance failed, using plain frame:`, e?.message || e);
    }
    // Pre-generate bold + cinematic variants in background (non-blocking).
    const durSec = Number.isFinite(outputDurationSec) && outputDurationSec > 2 ? outputDurationSec : 60;
    extractStyledFrame(outputPath, durSec * 0.45, aiThumbPath(jobId, "bold"), "bold")
      .then(() => console.log(`[render ${jobId}] bold variant pre-generated`))
      .catch((e) => console.warn(`[render ${jobId}] bold pre-gen failed:`, e?.message || e));
    extractStyledFrame(outputPath, durSec * 0.25, aiThumbPath(jobId, "cinematic"), "cinematic")
      .then(() => console.log(`[render ${jobId}] cinematic variant pre-generated`))
      .catch((e) => console.warn(`[render ${jobId}] cinematic pre-gen failed:`, e?.message || e));
  }

  await jobStore.update(jobId, {
    status: "done",
    progress: 100,
    message: "Render complete",
    outputPath,
    posterPath: posterPath || undefined,
    completedAt: Date.now(),
    syncScore: _finalSyncScore != null ? _finalSyncScore : undefined,
  });

  // Best-effort cleanup of intermediate clip files + manifest + subs (keep the source).
  try { await fs.unlink(manifestPath); } catch {}
  if (subtitlesPath) { try { await fs.unlink(subtitlesPath); } catch {} }
  if (adaptiveMusicPath) { try { await fs.unlink(adaptiveMusicPath); } catch {} }
  for (const c of clipPaths) { try { await fs.unlink(c); } catch {} }
}

/* ---------- start ---------- */
const server = app.listen(PORT, () => {
  console.log(`CineRecap render server listening on http://0.0.0.0:${PORT}`);
  if (!AUTH_TOKEN) console.log("Auth token: (none — set AUTH_TOKEN in .env before exposing)");
});
// 120 s idle timeout — generous for status polls and small uploads.
// Upload routes (/upload, /upload/movie/:id/chunk) override this per-socket
// to 0 (unlimited) so multi-GB movie transfers are never cut off mid-stream.
server.timeout = 120_000;
// Keep-alive must outlast any load-balancer / proxy idle timeout (typically
// 60 s). 65 s ensures the server never drops a connection the client still
// considers live.
server.keepAliveTimeout = 65_000;
server.headersTimeout    = 66_000; // must exceed keepAliveTimeout

