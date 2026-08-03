/**
 * Whisper-1 transcription pipeline for CineRecap Studio.
 *
 * Flow: ingested movie (/data/uploads/<fileId>)
 *   -> FFmpeg extract mono 16 kHz MP3
 *   -> split into duration-based chunks (size-guarded < 24 MB)
 *   -> OpenAI whisper-1 (response_format=verbose_json) per chunk (retry + backoff)
 *   -> offset each chunk's segment timestamps by its absolute start
 *   -> merge into { fullText, segments:[{start,end,text}] }
 *   -> cache to /data/uploads/transcript-<fileId>.json
 *
 * whisper-1 is used (not gpt-4o-mini-transcribe) because it returns
 * segment-level timestamps via verbose_json, which we need for accurate
 * scene/clip alignment.
 *
 * Node 20+ provides global fetch / FormData / Blob, so no extra deps needed.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

// Transcription: keeps original language, returns segments with timestamps.
// Translation: any language → English, also returns segments with timestamps.
const WHISPER_ENDPOINT            = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_TRANSLATIONS_ENDPOINT = "https://api.openai.com/v1/audio/translations";
const WHISPER_MODEL = "whisper-1";

// OpenAI hard-limits uploads at 25 MB. Stay safely below.
const MAX_CHUNK_BYTES = 24 * 1024 * 1024;
// Chunk by duration; whisper handles long audio but we keep requests bounded.
const CHUNK_SECONDS = 600; // 10 minutes per chunk

/**
 * Probe duration in seconds via ffprobe.
 */
export function probeDurationSec(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ];
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err.trim()}`));
      const n = Number(out.trim());
      if (!Number.isFinite(n)) return reject(new Error(`ffprobe returned non-numeric: ${out}`));
      resolve(n);
    });
  });
}

/**
 * Extract mono 16 kHz MP3 audio optimised for speech recognition.
 */
export function extractAudio({ inputPath, outPath, bitrate = "32k" }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", inputPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", bitrate,
      outPath,
    ];
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.on("close", (code) => code === 0 ? resolve(outPath) : reject(new Error(`ffmpeg audio extract failed: code ${code}`)));
  });
}

/**
 * Split an audio file into fixed-duration segments using FFmpeg's segment muxer.
 * Returns an ordered list of { index, startSec, path }.
 */
export async function chunkAudioByDuration({ audioPath, outDir, chunkSeconds = CHUNK_SECONDS }) {
  await fs.mkdir(outDir, { recursive: true });
  const pattern = path.join(outDir, "chunk_%03d.mp3");
  await new Promise((resolve, reject) => {
    const args = [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", audioPath,
      "-f", "segment",
      "-segment_time", String(chunkSeconds),
      "-c", "copy",
      pattern,
    ];
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg segment failed: code ${code}`)));
  });

  const files = (await fs.readdir(outDir))
    .filter((f) => /^chunk_\d{3}\.mp3$/.test(f))
    .sort();

  const chunks = [];
  for (let i = 0; i < files.length; i++) {
    const p = path.join(outDir, files[i]);
    // Guard: if any chunk exceeds the size limit, it must be re-split smaller.
    const stat = await fs.stat(p);
    if (stat.size > MAX_CHUNK_BYTES) {
      throw new Error(
        `Chunk ${files[i]} is ${(stat.size / 1048576).toFixed(1)} MB (> 24 MB). ` +
        `Lower CHUNK_SECONDS or audio bitrate.`,
      );
    }
    chunks.push({ index: i, startSec: i * chunkSeconds, path: p });
  }
  if (chunks.length === 0) throw new Error("No audio chunks were produced");
  return chunks;
}

/**
 * Transcribe a single chunk via whisper-1 with verbose_json (segment timestamps).
 * Retries up to `maxRetries` with exponential backoff.
 * Returns the raw whisper response object for this chunk.
 */
/**
 * @param {boolean} [translate=false]  When true, use the /translations endpoint
 *   which accepts any language and returns English text + timestamps.
 *   Use this for non-English films so Claude always receives English dialogue.
 */
export async function transcribeChunk({ apiKey, chunkPath, language, translate = false, maxRetries = 3 }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const buf = await fs.readFile(chunkPath);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/mpeg" }), path.basename(chunkPath));
      form.append("model", WHISPER_MODEL);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
      // Translations endpoint always outputs English; it ignores a language hint.
      // Transcriptions endpoint benefits from a language hint for accuracy.
      if (!translate && language) form.append("language", language);

      const endpoint = translate ? WHISPER_TRANSLATIONS_ENDPOINT : WHISPER_ENDPOINT;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      if (res.status === 429 || res.status >= 500) {
        const body = await res.text().catch(() => "");
        throw new Error(`whisper ${res.status}: ${body.slice(0, 200)}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // 4xx (other than 429) are not retryable — fail fast.
        const e = new Error(`whisper ${res.status}: ${body.slice(0, 200)}`);
        e.fatal = true;
        throw e;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.fatal) throw err;
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr || new Error("whisper transcription failed");
}

/**
 * Offset a chunk's segments by its absolute start time and normalise shape.
 */
export function offsetSegments(whisperResponse, startSec) {
  const segs = Array.isArray(whisperResponse?.segments) ? whisperResponse.segments : [];
  return segs
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s) => ({
      start: Number(s.start) + startSec,
      end: Number(s.end) + startSec,
      text: typeof s.text === "string" ? s.text.trim() : "",
    }));
}

/**
 * Extract and offset word-level timestamps from a single Whisper chunk response.
 * Returns [{word, start, end}] with absolute film timestamps.
 */
export function offsetWords(whisperResponse, startSec) {
  const raw = Array.isArray(whisperResponse?.words) ? whisperResponse.words : [];
  return raw
    .filter((w) => Number.isFinite(w.start))
    .map((w) => ({
      word: typeof w.word === "string" ? w.word.replace(/[^a-zA-Z0-9'\-]/g, "").toLowerCase() : "",
      start: Number(w.start) + startSec,
      end: Number.isFinite(w.end) ? Number(w.end) + startSec : Number(w.start) + startSec + 0.3,
    }))
    .filter((w) => w.word.length > 0);
}

/**
 * Merge per-chunk offset segments into a single transcript object.
 */
export function mergeTranscript(allSegments, allWords = []) {
  const segments = allSegments
    .flat()
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.start - b.start);
  const words = allWords
    .flat()
    .filter((w) => w.word && Number.isFinite(w.start))
    .sort((a, b) => a.start - b.start);
  const fullText = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  return { fullText, segments, words };
}

/**
 * Full pipeline. Reports progress via onProgress(pct, message).
 * Returns { fullText, segments, durationSec, chunkCount, cached }.
 */
export async function transcribeMovie({
  fileId,
  uploadsDir,
  apiKey,
  language,
  translate,      // when true: use /translations endpoint (any lang → English)
  onProgress = () => {},
}) {
  // Auto-enable translation when no specific language hint is given OR when
  // the language is explicitly non-English. This ensures Claude always receives
  // an English transcript regardless of what language the film is in.
  const shouldTranslate = translate === true ||
    (translate !== false && (!language || (language.toLowerCase() !== "en" && language.toLowerCase() !== "english")));
  if (shouldTranslate && language && language.toLowerCase() !== "en") {
    console.log(`[transcribe] Non-English audio detected (language="${language}") — translating to English`);
  }
  if (!apiKey) throw new Error("Missing OpenAI API key");
  const sourcePath = path.join(uploadsDir, fileId);
  await fs.access(sourcePath); // throws if missing

  const cachePath = path.join(uploadsDir, `transcript-${fileId}.json`);
  try {
    const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (cached && Array.isArray(cached.segments)) {
      onProgress(100, "Loaded cached transcript");
      return { ...cached, cached: true };
    }
  } catch {
    // no cache — proceed
  }

  const workDir = path.join(uploadsDir, `transcribe-${fileId}`);
  await fs.mkdir(workDir, { recursive: true });

  onProgress(5, "Extracting audio");
  const audioPath = path.join(workDir, "audio.mp3");
  console.log(`[transcribe] Extracting audio from ${sourcePath} to ${audioPath}`);
  await extractAudio({ inputPath: sourcePath, outPath: audioPath });
  console.log(`[transcribe] Audio extracted successfully`);

  onProgress(15, "Splitting audio into chunks");
  console.log(`[transcribe] Splitting audio into chunks (${CHUNK_SECONDS}s each)`);
  const chunks = await chunkAudioByDuration({ audioPath, outDir: workDir });
  console.log(`[transcribe] Created ${chunks.length} chunks`);

  const durationSec = await probeDurationSec(sourcePath).catch(() => 0);
  console.log(`[transcribe] Movie duration: ${durationSec}s`);
  const allSegments = [];
  const allWords = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    onProgress(
      20 + Math.round((i / chunks.length) * 70),
      `Transcribing chunk ${i + 1}/${chunks.length}`,
    );
    console.log(`[transcribe] Transcribing chunk ${i + 1}/${chunks.length}: ${c.path}`);
    const resp = await transcribeChunk({ apiKey, chunkPath: c.path, language, translate: shouldTranslate });
    console.log(`[transcribe] Chunk ${i + 1} done: ${resp.segments?.length || 0} segments, ${resp.words?.length || 0} words`);
    allSegments.push(offsetSegments(resp, c.startSec));
    allWords.push(offsetWords(resp, c.startSec));
  }
  console.log(`[transcribe] All chunks transcribed: ${allSegments.length} segment groups`);

  onProgress(95, "Merging transcript");
  console.log(`[transcribe] Merging ${allSegments.length} segment groups`);
  const merged = mergeTranscript(allSegments, allWords);
  const result = {
    fullText: merged.fullText,
    segments: merged.segments,
    words: merged.words,
    durationSec,
    chunkCount: chunks.length,
  };
  console.log(`[transcribe] Merged: ${result.segments.length} segments, ${result.fullText.length} chars`);

  await fs.writeFile(cachePath, JSON.stringify(result), "utf8");
  console.log(`[transcribe] Cached to ${cachePath}`);

  // Best-effort cleanup of intermediate audio chunks (keep cache only).
  try { await fs.rm(workDir, { recursive: true, force: true }); } catch {}

  onProgress(100, "Transcript ready");
  console.log(`[transcribe] Transcription complete`);
  return { ...result, cached: false };
}

/**
 * Build a compact transcript text block for Claude. Keeps timestamps so Claude
 * can reference exact moments and choose accurate clip windows. Trims to a
 * character budget to avoid blowing the token limit on very long movies.
 */
export function buildTranscriptBlock(transcript, { maxChars = 24000 } = {}) {
  if (!transcript || !Array.isArray(transcript.segments) || transcript.segments.length === 0) {
    return "";
  }
  const lines = transcript.segments.map((s) => {
    const t = Math.round(s.start);
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = String(t % 60).padStart(2, "0");
    return `[${mm}:${ss}] ${s.text}`;
  });
  let block = lines.join("\n");
  if (block.length > maxChars) {
    // Keep beginning and end (hook + ending matter most); compress the middle.
    const head = block.slice(0, Math.floor(maxChars * 0.6));
    const tail = block.slice(block.length - Math.floor(maxChars * 0.35));
    block = `${head}\n...[transcript condensed for length]...\n${tail}`;
  }
  return block;
}

