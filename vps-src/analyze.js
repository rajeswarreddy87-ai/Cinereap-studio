/**
 * Server-side video analysis: probe duration, extract evenly-spaced frames at a
 * downscaled resolution, call Anthropic's Claude API with the frames, and
 * return a normalised { script, timestamps } object.
 *
 * The phone never has to extract frames itself when this path is used.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

// Legacy fallback threshold (seconds): timestamps before this are treated as
// opening-credits/logo and dropped in the non-scene-aware fallback path. The
// primary scene-aware path handles credits via Claude "SKIP" labels instead.
// Defined here because it was referenced but never declared — a latent
// ReferenceError that only fires on the legacy fallback path.
const OPENING_CREDITS_THRESHOLD = 0;

/**
 * Probe a media file with ffprobe; returns the duration in seconds.
 */
export async function probeDurationSec(filePath) {
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
 * Extract `count` evenly-spaced frames from `filePath` and write them as
 * downscaled JPEGs under `outDir`. Returns the array of frame paths in time order.
 */
export async function extractFrames({ filePath, outDir, count, maxWidth = 512 }) {
  await fs.mkdir(outDir, { recursive: true });
  const duration = await probeDurationSec(filePath);
  if (!duration || duration < 1) throw new Error("Video too short to sample");

  const stepSec = duration / (count + 1);
  const frames = [];
  for (let i = 1; i <= count; i++) {
    const tSec = stepSec * i;
    const out = path.join(outDir, `frame-${String(i).padStart(3, "0")}.jpg`);
    await extractSingleFrame(filePath, tSec, out, maxWidth);
    frames.push({ index: i, timeSec: tSec, path: out });
  }
  return { duration, frames };
}

function extractSingleFrame(filePath, tSec, outPath, maxWidth) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-ss", tSec.toFixed(3),
      "-i", filePath,
      "-vframes", "1",
      "-vf", `scale=${maxWidth}:-2`,
      "-q:v", "4",
      outPath,
    ];
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg frame extract failed: code ${code}`)));
  });
}

/**
 * Read a JPEG frame and convert to base64 for inclusion in Anthropic messages.
 */
export async function frameToBase64(framePath) {
  const buf = await fs.readFile(framePath);
  return buf.toString("base64");
}

/**
 * Build the Anthropic messages payload using the same body-only prompt the
 * mobile client uses, plus the extracted frames as image content blocks.
 */
export function buildAnalyzeMessages({ movie, frames, channelName, maxClipSeconds = 6, targetClipCount = 50, transcriptBlock = "" }) {
  const content = [];
  for (const f of frames) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: f.base64 },
    });
  }
  const cast = movie.cast
    ? `\nFilm characters (use these names — NOT the actors' real names): ${movie.cast}.`
    : `\nNo cast list provided — derive character names PRIMARILY from the Whisper dialogue transcript below (characters introducing themselves, being addressed by name, or named by other speakers). Only fall back to your own knowledge of this specific film when the transcript is silent on a name. Never use actor real names. If a name or relationship is genuinely uncertain, use a neutral role label such as "the trainer", "the manager", "the daughter", "one of the men", or "the officer".`;
  const director = movie.director ? `, directed by ${movie.director}` : "";
  const year = movie.year ? ` (${movie.year})` : "";
  const genre = movie.genre ? `${movie.genre} ` : "";

  const maxSec = Math.max(2, Math.round(Number(maxClipSeconds) || 6));
  const target = Math.max(8, Math.round(Number(targetClipCount) || 50));
  const minN = Math.max(8, Math.round(target * 0.7));
  const maxN = Math.round(target * 1.3);

  content.push({
    type: "text",
    text:
      `You are a YouTube ${genre}recap scriptwriter for the channel "${channelName}", specialised in COPYRIGHT-SAFE recaps.\n` +
      `Movie: "${movie.title}"${year}${director}${cast}.\n` +
      `Above are ${frames.length} frames sampled evenly across the film.\n\n` +
      (transcriptBlock
        ? `You ALSO have the movie's full dialogue transcript with [mm:ss] timestamps below. ` +
          `GROUND the recap in this transcript: use the ACTUAL plot, character names, and key ` +
          `lines of dialogue. Do NOT invent events that are not supported by the transcript or frames. ` +
          `When choosing clip windows, align them to the timestamps where important moments occur.\n\n` +
          `TRANSCRIPT:\n${transcriptBlock}\n\n`
        : ``) +
      `Write ONE single, continuous 5-8 minute voiceover script that tells the story IN STRICT ` +
      `CHRONOLOGICAL ORDER — begin directly with the very first scene of the film and move ` +
      `forward in time to the ending. NEVER start with a hook or teaser from the ` +
      `climax or ending. NEVER use flashback framing, "earlier we saw", or any ` +
      `non-linear device. The narration must mirror the movie's own timeline exactly, ` +
      `scene by scene, from opening act to final scene.\n\n` +
      `CHARACTER INTRODUCTIONS — this is mandatory: the FIRST time any character ` +
      `appears in the narration, introduce them by their FULL NAME and a brief ` +
      `one-sentence description of who they are and their role in the story ` +
      `(e.g. "Jim Hanson, a Vietnam veteran turned Arizona rancher", ` +
      `"Sarah Cole, a sharp Border Patrol agent who has known Jim for years"). ` +
      `After that first introduction, always refer to the character by name — ` +
      `NEVER use vague labels like "the man", "the woman", "the hero", ` +
      `"the villain", "the protagonist", or "the antagonist". ` +
      `Derive character names PRIMARILY from the Whisper dialogue transcript above (self-introductions, characters addressed by name, or named by other speakers); fall back to your own knowledge of this film only where the transcript gives no name — NEVER use actor real names.\n\n` +
      `STORY COMPLETENESS — mandatory: do NOT skip, gloss over, or summarise away ` +
      `any major plot event. This includes: murders, deaths, crimes, assaults, ` +
      `betrayals, revelations, confrontations, and any moment that changes the ` +
      `direction of the story. For each such event explain specifically HOW it ` +
      `happens and WHY — not just that it happened. The viewer is watching because ` +
      `they want to understand the FULL story, including its dark moments.\n\n` +
      `CRITICAL — NO [INTRO]: Do NOT output an [INTRO] section, heading, or label under any ` +
      `circumstances. Do NOT write a channel welcome, hook, or teaser. The app has removed the ` +
      `intro template entirely — any [INTRO] text is automatically stripped and wastes your ` +
      `token budget. Begin the narration IMMEDIATELY with the very first line of the movie's ` +
      `story — no preamble, no label, no greeting. Do NOT include any "subscribe" CTA or hashtags.\n` +
      `END the script with a clearly marked [OUTRO] section (2–3 sentences only): a thematic ` +
      `closing reflection on the film's message, tone, or legacy — NOT a channel plug, ` +
      `NOT "thanks for watching", NOT a subscribe request. Just a final thought on the movie.\n\n` +
      `Then pick MANY SHORT visual moments to use as B-roll: between ${minN} and ${maxN} clips total. ` +
      `EACH CLIP MUST BE AT MOST ${maxSec} SECONDS LONG (shorter is fine; never longer). ` +
      `Pick narratively distinct beats: a reaction shot, a key prop, a cut to a new location, ` +
      `a face close-up, a doorway, an action snippet. Avoid long continuous takes from the same scene. ` +
      `Many short cuts dramatically reduce YouTube Content ID copyright matches.\n` +
      `For each clip, give a precise start and end second within the film duration ` +
      `(${Math.round(movie.durationSec)}s) and one short sentence describing why it's a strong cut. ` +
      `Clips must be in chronological order with NO overlap.\n\n` +
      `Respond with valid JSON of the form:\n` +
      `{ "script": "...", "timestamps": [ { "startSec": 0, "endSec": 0, "reason": "..." } ] }\n` +
      `No other text.`,
  });

  return [{ role: "user", content }];
}

/**
 * Defensive clamp: shrink any clip > maxSec from its midpoint, then drop
 * anything that overlaps a neighbour after shrinking.
 */
export function enforceMaxClipDurationServer(timestamps, maxSec) {
  const cap = Math.max(2, Math.round(Number(maxSec) || 6));
  const out = [];
  for (const c of timestamps) {
    const dur = c.endSec - c.startSec;
    if (!(dur > 0)) continue;
    if (dur <= cap) { out.push(c); continue; }
    const mid = (c.startSec + c.endSec) / 2;
    const half = cap / 2;
    const newStart = Math.max(c.startSec, mid - half);
    const newEnd = Math.min(c.endSec, newStart + cap);
    if (newEnd - newStart < 1.5) continue;
    out.push({ startSec: newStart, endSec: newEnd, reason: c.reason });
  }
  out.sort((a, b) => a.startSec - b.startSec);
  const final = [];
  for (const c of out) {
    const prev = final[final.length - 1];
    if (prev && c.startSec < prev.endSec) continue;
    final.push(c);
  }
  return final;
}

/**
 * Parse Claude's response. Tolerant of ```json fences and small whitespace.
 */
function repairJson(s) {
  // Strategy 1: strip code fences
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  // Strategy 2: slice to outermost object braces
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  // Strategy 3: remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, "$1");
  // Strategy 4: balance unclosed brackets/braces (handles truncated responses)
  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  if (opens > closes) s = s + "}".repeat(opens - closes);
  const obkts = (s.match(/\[/g) || []).length;
  const cbkts = (s.match(/\]/g) || []).length;
  if (obkts > cbkts) s = s + "]".repeat(obkts - cbkts);
  return s;
}

/**
 * Last-resort repair for Claude responses truncated mid-array-element.
 * Walks backwards from the end to find the last complete "}, " boundary,
 * strips the incomplete trailing element, then closes any open structure.
 * Handles the case where repairJson fails because the truncation point
 * is inside a JSON string literal (unclosed quotes confuse bracket counting).
 */
function repairTruncatedArray(raw) {
  if (typeof raw !== "string") return raw;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();

  // Find the last "}, " or "},\n" — unambiguous end of a complete array element.
  // Use regex to find all such positions and take the last one.
  let lastBoundary = -1;
  const boundaryRe = /\},\s*[\n\r{]/g;
  let m;
  while ((m = boundaryRe.exec(s)) !== null) lastBoundary = m.index + 1; // position of the ","

  if (lastBoundary > 0) {
    // Truncate at this boundary (keeps the "}" of the last complete element)
    s = s.substring(0, lastBoundary);
  }

  // Close any open array / object structure
  const oArr = (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
  const oObj = (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
  if (oArr > 0) s += "]".repeat(oArr);
  if (oObj > 0) s += "}".repeat(oObj);
  return s;
}

/**
 * Remove any [INTRO] section Claude may produce despite being told not to.
 * Handles multi-line blocks, inline labels, and bare [INTRO] markers.
 * Safe to call on any script string — returns it unchanged if no INTRO found.
 */
function stripIntroSection(script) {
  if (typeof script !== "string") return script;
  return script
    // Multi-line [INTRO] block — from marker to first blank line
    .replace(/^\s*\[INTRO\][^\n]*\n(?:[^\n]+\n)*\n?/im, "")
    // Single-line [INTRO] label (no following body)
    .replace(/^\s*\[INTRO\][^\n]*\n?/im, "")
    // Inline [INTRO] marker anywhere in the text
    .replace(/\[INTRO\]\s*[:：]?\s*/gi, "")
    .trim();
}

// Movie-agnostic safety net: the Pass-1 CREDITS_LABEL_RE filter (above) only
// drops whole beats whose Claude-written NOTE flags a studio/logo/credits
// scene. It does not inspect the final Pass-3 NARRATION text, which is a
// separately-generated field — Claude sometimes still writes a sentence
// describing what it visually saw (a company name, "presents", a copyright
// line) even for a beat that is otherwise legitimate story content. This
// works for ANY movie/studio because it matches generic credit-phrasing
// patterns, not specific studio names, so no per-movie hardcoding is needed.
// Only the offending sentence is dropped — the rest of the beat's narration
// (if any) is preserved.
const CREDIT_LEAK_SENTENCE_RE = new RegExp(
  [
    // "<Company> Pictures/Studios/Entertainment/Productions/Films presents"
    "\\b[A-Z][\\w&'.-]*(?:\\s+[A-Z][\\w&'.-]*){0,3}\\s+(?:pictures|studios?|entertainment|productions?|films?)\\s+(?:proudly\\s+)?presents?\\b",
    "\\bdistributed\\s+by\\b",
    "\\bin\\s+association\\s+with\\b",
    "\\bproduction\\s+company\\b",
    "\\btitle\\s+card\\b",
    "\\b(?:studio|opening|company)\\s+logo\\b",
    "\\bcopyright\\s*(?:\\(c\\)|\u00a9)?\\s*\\d{4}\\b",
    "\\ball\\s+rights\\s+reserved\\b",
  ].join("|"),
  "i"
);

function stripCreditLeakSentences(text) {
  if (typeof text !== "string" || !text.trim()) return text || "";
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const kept = sentences.filter((s) => !CREDIT_LEAK_SENTENCE_RE.test(s));
  const result = kept.join(" ").replace(/\s+/g, " ").trim();
  if (result !== text.trim() && result.length < text.trim().length) {
    console.log(`[analyzeWithScenes] stripped credit-leak sentence from narration: "${text.trim()}" -> "${result}"`);
  }
  return result;
}

export function parseAnalysisResponse(rawText) {
  if (typeof rawText !== "string") throw new Error("Empty Claude response");
  let s = rawText.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  let obj;
  try {
    obj = JSON.parse(s);
  } catch (e) {
    // Attempt JSON repair before giving up (handles truncated/large 100+ frame responses).
    // FIX (2026-07-03): this legacy fallback path handles a FULL-length movie
    // script + up to 100 clip timestamps in ONE response, so it is the call
    // most likely to hit the output-token limit mid-string (unterminated
    // quote), which brace/bracket-balancing repair alone cannot fix. Add the
    // same last-resort repairTruncatedArray step parseSceneNotesResponse
    // already uses — it walks back to the last complete array element and
    // closes the structure there, recovering a truncated response instead of
    // failing the whole analyze job outright.
    try {
      obj = JSON.parse(repairJson(rawText));
    } catch (e2) {
      try {
        obj = JSON.parse(repairTruncatedArray(rawText));
      } catch (e3) {
        throw new Error(`Claude response was not valid JSON: ${e.message}`);
      }
    }
  }
  if (typeof obj.script !== "string" || !Array.isArray(obj.timestamps)) {
    throw new Error("Claude response missing script or timestamps");
  }
  const cleanedTimestamps = obj.timestamps
    .filter((t) => Number.isFinite(t.startSec) && Number.isFinite(t.endSec) && t.endSec > t.startSec)
    .map((t) => ({
      startSec: Number(t.startSec),
      endSec: Number(t.endSec),
      reason: typeof t.reason === "string" ? t.reason : "",
    }));
  return { script: stripIntroSection(obj.script.trim()), timestamps: cleanedTimestamps };
}

/**
 * Stage A prompt: ask Claude ONLY for clip windows + a short beat note for each
 * (NO script). This runs once per frame batch so we can cover all frames
 * without each batch writing its own competing narrative (the old "two
 * stories" bug). The transcript is included only on the first batch.
 */
export function buildClipNotesMessages({ movie, frames, maxClipSeconds = 6, targetClipCount = 50, transcriptBlock = "" }) {
  const content = [];
  for (const f of frames) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: f.base64 },
    });
  }
  const maxSec = Math.max(2, Math.round(Number(maxClipSeconds) || 6));
  const target = Math.max(8, Math.round(Number(targetClipCount) || 50));
  const minN = Math.max(6, Math.round(target * 0.7));
  const maxN = Math.round(target * 1.3);
  content.push({
    type: "text",
    text:
      `You are helping build a COPYRIGHT-SAFE recap of "${movie.title}". ` +
      `Above are ${frames.length} frames sampled in chronological order from a portion of the film ` +
      `(total film duration ${Math.round(movie.durationSec)}s).\n\n` +
      (transcriptBlock
        ? `Here is the movie's dialogue transcript with [mm:ss] timestamps. Use it to understand the real ` +
          `plot and character names when describing beats.\n\nTRANSCRIPT:\n${transcriptBlock}\n\n`
        : ``) +
      `Pick between ${minN} and ${maxN} SHORT, narratively distinct visual moments to use as B-roll. ` +
      `EACH CLIP MUST BE AT MOST ${maxSec} SECONDS (shorter is fine; never longer). ` +
      `Prefer many short cuts (reaction shots, key props, location changes, close-ups) over long takes. ` +
      `For each clip give a precise start and end second within the film duration and a SHORT factual ` +
      `note (max ~12 words) describing what happens — this note feeds the scriptwriter. ` +
      `Clips must be in chronological order with NO overlap.\n\n` +
      `Respond with valid JSON ONLY of the form:\n` +
      `{ "timestamps": [ { "startSec": 0, "endSec": 0, "reason": "..." } ] }\n` +
      `No prose, no script, no other keys.`,
  });
  return [{ role: "user", content }];
}

/**
 * Stage B prompt: write ONE continuous voiceover script from the full transcript
 * plus the ordered beat notes collected across all batches. Text-only (no
 * images) so it is cheap and produces a single coherent story.
 */
export function buildScriptFromNotesMessages({ movie, channelName, beatNotes, transcriptBlock = "" }) {
  const cast = movie.cast
    ? `\nFilm characters (use these names — NOT the actors' real names): ${movie.cast}.`
    : `\nNo cast list provided — derive character names PRIMARILY from the Whisper dialogue transcript below (characters introducing themselves, being addressed by name, or named by other speakers). Only fall back to your own knowledge of this specific film when the transcript is silent on a name. Never use actor real names. If a name or relationship is genuinely uncertain, use a neutral role label such as "the trainer", "the manager", "the daughter", "one of the men", or "the officer".`;
  const director = movie.director ? `, directed by ${movie.director}` : "";
  const year = movie.year ? ` (${movie.year})` : "";
  const genre = movie.genre ? `${movie.genre} ` : "";
  const notesText = beatNotes && beatNotes.length
    ? beatNotes.map((n, i) => `${i + 1}. [${n.t}] ${n.reason}`).join("\n")
    : "(no beat notes available — rely on the transcript)";
  return [{
    role: "user",
    content: [{
      type: "text",
      text:
        `You are a YouTube ${genre}recap scriptwriter for the channel "${channelName}", specialised in ` +
        `COPYRIGHT-SAFE recaps.\n` +
        `Movie: "${movie.title}"${year}${director}${cast}. Film duration ${Math.round(movie.durationSec)}s.\n\n` +
        (transcriptBlock
          ? `Ground the recap in this ACTUAL dialogue transcript (use real plot, character names, key lines). ` +
            `Do NOT invent events not supported by it.\n\nTRANSCRIPT:\n${transcriptBlock}\n\n`
          : ``) +
        `These are the ordered on-screen beats (chronological) that the B-roll will show:\n${notesText}\n\n` +
        `Write ONE single, continuous 5-8 minute voiceover script that tells the WHOLE story ` +
        `IN STRICT CHRONOLOGICAL ORDER — begin directly with the OPENING SCENE of the film ` +
        `and narrate events exactly as they occur in the film's own timeline, ending with the final scene. ` +
        `STRICT RULES: (1) Do NOT open with a teaser, hook, or moment from later in the film. ` +
        `(2) Do NOT use flashback structure or "earlier we saw..." devices. ` +
        `(3) Do NOT jump back in time at any point — the script must move forward only. ` +
        `(4) The beat notes above are already in chronological order — follow that exact sequence. ` +
        `(5) CHARACTER INTRODUCTIONS — mandatory: the FIRST time any named character ` +
        `appears in the script, introduce them by FULL NAME plus a short description ` +
        `of who they are (e.g. "Jim Hanson, a Vietnam veteran and struggling rancher", ` +
        `"Sarah Cole, a Border Patrol agent who has looked out for Jim for years"). ` +
        `All subsequent mentions must use the character's name — NEVER write ` +
        `"the man", "the woman", "the hero", "the villain", "the protagonist", ` +
        `"the antagonist", or any other anonymous label once you know their name. ` +
        `CRITICAL — RELATIONSHIPS: NEVER substitute a character's actual name with a ` +
        `relationship descriptor alone. Do NOT write "his uncle", "her father", "his brother", ` +
        `"her mother", etc. as standalone references — always use the character's ` +
        `actual name. You may add the relationship in parentheses on first mention only ` +
        `(e.g. "Siddharth — Ramana's father"), but every subsequent mention must use the ` +
        `name only. If the transcript uses a relationship word (e.g. "nanna", "anna", ` +
        `"amma", "mama", "chacha") cross-reference the dialogue transcript to find the character's ` +
        `real name and use that name in the script. ` +
        `Draw character names PRIMARILY from the Whisper dialogue transcript, falling back to your own knowledge of this film only when the transcript gives no name. NEVER use actor real names. NEVER use vague labels like "the protagonist" once you know a character's name.\n` +
        `(6) STORY COMPLETENESS — mandatory: do NOT skip, summarise away, or ` +
        `gloss over any major dramatic event. Include murders, deaths, crimes, ` +
        `betrayals, confrontations, and revelations. For each one explain specifically ` +
        `HOW it happens and WHY — not just that it occurred. Every major plot ` +
        `turning point must be described in at least 2-3 sentences.\n` +
        `Do NOT write multiple separate summaries or restart the story. ` +
        `CRITICAL — NO [INTRO]: Do NOT output an [INTRO] section, heading, or label under any ` +
        `circumstances. Do NOT write a channel welcome, hook, or teaser. The intro template has ` +
        `been removed from the app — any [INTRO] text is automatically stripped server-side and ` +
        `wastes your token budget. Begin the narration IMMEDIATELY with the first line of the ` +
        `movie's story. Do NOT include any "subscribe" CTA or hashtags.\n` +
        `END the script with a clearly marked [OUTRO] section (2–3 sentences only): a thematic ` +
        `closing reflection on the film's message, tone, or legacy — NOT a channel plug, ` +
        `NOT "thanks for watching", NOT a subscribe request. Just a final thought on the movie.\n\n` +
        `Respond with valid JSON ONLY of the form:\n{ "script": "..." }\nNo other text or keys.`,
    }],
  }];
}

/**
 * Parse a Stage A clip-notes response: { timestamps: [...] }.
 */
export function parseClipNotesResponse(rawText) {
  if (typeof rawText !== "string") throw new Error("Empty Claude response");
  let s = rawText.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  let obj;
  try { obj = JSON.parse(s); }
  catch { obj = JSON.parse(repairJson(rawText)); }
  const arr = Array.isArray(obj?.timestamps) ? obj.timestamps : [];
  return arr
    .filter((t) => Number.isFinite(t.startSec) && Number.isFinite(t.endSec) && t.endSec > t.startSec)
    .map((t) => ({
      startSec: Number(t.startSec),
      endSec: Number(t.endSec),
      reason: typeof t.reason === "string" ? t.reason : "",
    }));
}

/**
 * Parse a Stage B script response: { script: "..." }.
 */
export function parseScriptResponse(rawText) {
  if (typeof rawText !== "string") throw new Error("Empty Claude response");
  let s = rawText.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  let obj;
  try { obj = JSON.parse(s); }
  catch { obj = JSON.parse(repairJson(rawText)); }
  if (typeof obj?.script !== "string" || !obj.script.trim()) {
    throw new Error("Claude script response missing script");
  }
  return stripIntroSection(obj.script.trim());
}

function secToMmSs(sec) {
  const v = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Return the maximum safe output token count for a given Claude model.
 * These are Anthropic's documented hard limits per model family.
 * We cap our maxTokens to this so we never send an impossible request.
 */
export function getModelMaxOutputTokens(model = "") {
  const m = String(model).toLowerCase();
  // Claude 4 family (Opus 4, Sonnet 4, Haiku 4) — released 2025
  if (m.includes("opus-4"))   return 32000;  // claude-opus-4-5 → 32 768 tokens
  if (m.includes("sonnet-4")) return 16000;  // claude-sonnet-4-5 → 16 384 tokens
  if (m.includes("haiku-4"))  return 8000;
  // Claude 3.x family
  if (m.includes("3-7"))      return 8000;   // claude-3-7-sonnet (non-thinking)
  if (m.includes("3-5"))      return 8000;   // claude-3-5-sonnet / haiku
  if (m.includes("3-opus"))   return 4000;   // claude-3-opus-20240229
  if (m.includes("3-haiku"))  return 4000;
  if (m.includes("3-sonnet")) return 4000;
  return 8000; // safe conservative default for unknown future models
}

function sleepMs(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Call Anthropic's /v1/messages endpoint with the given messages.
 * Caller supplies the API key and model.
 *
 * maxTokens is automatically capped to the model's documented hard limit
 * so callers can safely pass a large value (e.g. 32000) without worrying
 * about which model is actually in use.
 */
export async function callClaude({ apiKey, model, messages, maxTokens = 4000 }) {
  // Cap to the model's actual output limit; never exceed it or the API errors.
  const hardLimit = getModelMaxOutputTokens(model);
  const effectiveMax = Math.min(maxTokens, hardLimit);
  const maxAttempts = 4;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: effectiveMax, messages }),
    });
    if (res.ok) {
      const data = await res.json();
      const text = (data?.content || []).map((b) => b?.text || "").join("\n");
      if (!text) throw new Error("Claude returned an empty text block");
      return text;
    }
    const body = await res.text().catch(() => "");
    lastErr = new Error(`Claude ${res.status}: ${body.slice(0, 300)}`);
    const overloaded = res.status === 529 || /overloaded|rate.?limit|temporarily/i.test(body);
    if (!overloaded || attempt === maxAttempts - 1) break;
    const waitMs = [10_000, 25_000, 45_000][attempt] || 60_000;
    console.warn(`[callClaude] overloaded (${res.status}), retry ${attempt + 1}/${maxAttempts - 1} after ${waitMs}ms`);
    await sleepMs(waitMs);
  }
  throw lastErr || new Error("Claude request failed");
}

/**
 * Return the maximum safe output token count for a Gemini model. Gemini 2.5
 * Flash / Flash-Lite document a 65,536-token hard ceiling; keep a small
 * safety margin below that so we never send an impossible request.
 */
export function getGeminiMaxOutputTokens(model = "") {
  return 60000;
}

/**
 * Translate the Anthropic-shaped `messages` array (role + content blocks,
 * or a plain string for `content`) that every build*Messages() function and
 * ad-hoc call site in this codebase already produces into Gemini's
 * `contents` shape. Anthropic image blocks become Gemini `inline_data`;
 * text blocks/strings pass through unchanged. This is the ONLY place that
 * needs to know about Gemini's wire format — callers never do.
 */
function toGeminiContents(messages) {
  return messages.map((m) => {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: blocks.map((block) => {
        if (block.type === "image") {
          return { inline_data: { mime_type: block.source?.media_type || "image/jpeg", data: block.source?.data } };
        }
        return { text: block.text || "" };
      }),
    };
  });
}

/**
 * Call Gemini's generateContent endpoint with the same Anthropic-shaped
 * `messages` used for Claude everywhere else in this file. Retries on 429
 * (free-tier RPM ceiling) and 503 (model overloaded) with backoff tuned for
 * Gemini 2.5 Flash's 15 RPM free-tier limit.
 *
 * thinkingConfig.thinkingBudget=0 is REQUIRED — without it Gemini 2.5 spends
 * its output token budget on invisible "thinking" tokens and can return an
 * empty text block at MAX_TOKENS even for simple prompts.
 */
export async function callGemini({ apiKey, model, messages, maxTokens = 4000, jsonMode = false }) {
  const effectiveMax = Math.min(maxTokens, getGeminiMaxOutputTokens(model));
  const contents = toGeminiContents(messages);
  const maxAttempts = 4;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents,
            generationConfig: {
              maxOutputTokens: effectiveMax,
              thinkingConfig: { thinkingBudget: 0 },
              ...(jsonMode ? { responseMimeType: "application/json" } : {}),
            },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
            ],
          }),
          signal: AbortSignal.timeout(180_000),
        }
      );
    } catch (networkErr) {
      // FIX (2026-07-03): DNS blips, connection resets, and the 180s
      // AbortSignal timeout firing are transient exactly like a 429/503 HTTP
      // response — previously these threw immediately with zero retries,
      // which could fail a whole analyze job over one flaky connection.
      lastErr = new Error(`Gemini request error: ${networkErr.message || networkErr}`);
      if (attempt === maxAttempts - 1) break;
      const waitMs = [8_000, 20_000, 40_000][attempt] || 60_000;
      console.warn(`[callGemini] network error, retry ${attempt + 1}/${maxAttempts - 1} after ${waitMs}ms: ${networkErr.message}`);
      await sleepMs(waitMs);
      continue;
    }
    if (res.ok) {
      const data = await res.json();
      const blockReason = data?.promptFeedback?.blockReason;
      if (blockReason) {
        // Prompt-level block: Gemini's safety classifier rejected the INPUT
        // before generation ever started. This is deterministic for a given
        // prompt + config, so retrying the identical request to Gemini would
        // reliably reproduce the same verdict — no same-provider retry here.
        // The caller (index.js) escalates to a different provider instead.
        throw new Error(`Gemini blocked the request: ${blockReason}`);
      }
      const cand = data?.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p) => p?.text || "").join("\n");
      const finishReason = cand?.finishReason || "unknown";
      if (!text) {
        // FIX (2026-07-03): an output-side block (SAFETY/RECITATION) is a
        // verdict on the GENERATED text, which varies run-to-run with the
        // model's own sampling — unlike blockReason above, a same-provider
        // retry has a real chance of succeeding. Previously this was lumped
        // in with every other empty-response cause and escalated to Claude
        // immediately, burning a Claude call even when Gemini alone could
        // have recovered on attempt 2.
        const outputSideSafety = finishReason === "SAFETY" || finishReason === "RECITATION";
        if (outputSideSafety && attempt < maxAttempts - 1) {
          lastErr = new Error(`Gemini output blocked (finishReason=${finishReason})`);
          console.warn(`[callGemini] output-side block (${finishReason}), retry ${attempt + 1}/${maxAttempts - 1}`);
          await sleepMs(3_000);
          continue;
        }
        throw new Error(`Gemini returned an empty text block (finishReason=${finishReason})`);
      }
      return text;
    }
    const body = await res.text().catch(() => "");
    lastErr = new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
    const throttled = res.status === 429 || res.status === 503;
    if (!throttled || attempt === maxAttempts - 1) break;
    const waitMs = [8_000, 20_000, 40_000][attempt] || 60_000;
    console.warn(`[callGemini] throttled (${res.status}), retry ${attempt + 1}/${maxAttempts - 1} after ${waitMs}ms`);
    await sleepMs(waitMs);
  }
  throw lastErr || new Error("Gemini request failed");
}

/**
 * Provider-agnostic dispatcher used by every call site in this file (and by
 * index.js for the ad-hoc hook/YouTube-metadata calls). Defaults to Claude
 * so existing callers that never pass `provider` see zero behaviour change.
 */
export async function callLLM({ provider = "claude", apiKey, model, messages, maxTokens, jsonMode = false }) {
  if (provider === "gemini") return callGemini({ apiKey, model, messages, maxTokens, jsonMode });
  return callClaude({ apiKey, model, messages, maxTokens });
}

/**
 * Two-stage analysis that produces ONE coherent, transcript-grounded story
 * regardless of how many frame batches are needed.
 *
 * Why two stages: Claude's Vision API rejects > 100 images per request, so a
 * long film needs multiple batches. The OLD code asked each batch to write a
 * full script and then concatenated them — which read as "two stories" and
 * left later batches ungrounded (no transcript). Now:
 *   Stage A (per batch, with images): return ONLY clip windows + short beat
 *            notes. Transcript is attached to batch 0 for plot grounding.
 *   Stage B (one text-only call): write a SINGLE continuous script from the
 *            full transcript + the ordered beat notes from every batch.
 */
export async function callClaudeWithFrameBatching({
  apiKey,
  model,
  provider = "claude",
  frames,
  movie,
  channelName,
  maxClipSeconds,
  targetClipCount,
  transcriptBlock = "",
}) {
  const BATCH_SIZE = 100;
  const batches = [];
  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    batches.push(frames.slice(i, i + BATCH_SIZE));
  }
  if (batches.length === 0) batches.push([]);

  // ---- Stage A: collect clip windows + beat notes across all batches -------
  let allTimestamps = [];
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const messages = buildClipNotesMessages({
      movie,
      frames: batches[batchIdx],
      maxClipSeconds,
      targetClipCount: Math.ceil(targetClipCount / batches.length),
      // Transcript only on batch 0 to avoid blowing the token budget.
      transcriptBlock: batchIdx === 0 ? transcriptBlock : "",
    });
    const text = await callLLM({ provider, apiKey, model, messages });
    allTimestamps = allTimestamps.concat(parseClipNotesResponse(text));
  }
  allTimestamps.sort((a, b) => a.startSec - b.startSec);

  // FILTER: Drop beats Claude labelled as studio logos / title cards only.
  // No hard time threshold — story content starts at different points per film.
  allTimestamps = allTimestamps.filter((ts) => {
    const r = (ts.reason || "").trim();
    return r && !r.toUpperCase().startsWith("SKIP") && !/\b(studio|logo|production\s*company|distributor|credit|title\s*card)\b/i.test(r);
  });

  // ---- Stage B: write ONE continuous script from transcript + beat notes ---
  const beatNotes = allTimestamps.map((t) => ({ t: secToMmSs(t.startSec), reason: t.reason }));
  const scriptMessages = buildScriptFromNotesMessages({ movie, channelName, beatNotes, transcriptBlock });
  let script = "";
  try {
    const scriptText = await callLLM({ provider, apiKey, model, messages: scriptMessages, maxTokens: 8000 });
    script = parseScriptResponse(scriptText);
  } catch (e) {
    // Fallback: a single combined analyze call (old behaviour) if Stage B fails.
    const fallbackFrames = frames.slice(0, BATCH_SIZE);
    const messages = buildAnalyzeMessages({ movie, frames: fallbackFrames, channelName, maxClipSeconds, targetClipCount, transcriptBlock });
    const text = await callLLM({ provider, apiKey, model, messages });
    const parsed = parseAnalysisResponse(text);
    script = parsed.script;
    if (allTimestamps.length === 0) {
      allTimestamps = parsed.timestamps;
      // Apply opening credits filter to fallback timestamps too
      allTimestamps = allTimestamps.filter((ts) => ts.startSec >= OPENING_CREDITS_THRESHOLD);
    }
  }

  return { script, timestamps: allTimestamps };
}

// ===========================================================================
// HYBRID SCENE-AWARE ANALYSIS (v2.0)
// ===========================================================================
// Instead of fixed-interval frames, the caller passes a list of detected
// SCENES (each with a key frame + a clip window). We fuse each scene with the
// slice of the whisper transcript spoken during that scene's time window, so
// Claude understands the real plot/characters per beat. Then we write ONE
// continuous, character-consistent story.

/**
 * Return the transcript text spoken within [startSec, endSec], trimmed to a
 * sane length. Pure function — easy to unit test.
 */
export function transcriptForWindow(segments, startSec, endSec, maxChars = 600) {
  if (!Array.isArray(segments) || segments.length === 0) return "";
  const hits = [];
  for (const s of segments) {
    const a = Number(s.start);
    const b = Number(s.end ?? s.start);
    if (!Number.isFinite(a)) continue;
    // Overlap test between [a,b] and [startSec,endSec] (use a small pad).
    if (b >= startSec - 0.5 && a <= endSec + 0.5) {
      const t = typeof s.text === "string" ? s.text.trim() : "";
      if (t) hits.push(t);
    }
  }
  let joined = hits.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length > maxChars) joined = joined.slice(0, maxChars).trim() + "…";
  return joined;
}

/**
 * Stage A (scene-aware): show Claude every scene's key frame paired with that
 * scene's dialogue, and ask it to (a) extract a character list and (b) for each
 * scene return a one-line beat note + which scenes to KEEP as B-roll clips.
 * Images are batched (<=100 per Claude call); the character list is requested
 * only on the first batch.
 */
export function buildSceneNotesMessages({ movie, scenes, segments, isFirstBatch = true }) {
  const content = [];
  for (const sc of scenes) {
    // Multi-frame support: when frameBase64s[] is present, push up to 5 frames
    // (start, 25%, mid, 75%, end) so Claude sees temporal scene progression.
    // Fall back to the single legacy base64 field for backward compatibility.
    if (Array.isArray(sc.frameBase64s) && sc.frameBase64s.length > 0) {
      const LABELS = ["start", "25%", "mid", "75%", "end"];
      for (let fi = 0; fi < sc.frameBase64s.length; fi++) {
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: sc.frameBase64s[fi] } });
        // Add a short positional label between frames (not after the last one;
        // the SCENE N text block below serves as the closing anchor).
        if (fi < sc.frameBase64s.length - 1) {
          content.push({ type: "text", text: `[scene ${sc.index} – ${LABELS[fi] ?? fi}]` });
        }
      }
    } else {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: sc.base64 } });
    }
    // v5: Ground the note in exactly the footage Claude can see and the renderer
    // may use. The old full-scene span could include dialogue minutes beyond a
    // capped 10s clip window, causing the note/narration to describe off-screen
    // events.
    const dialogue = transcriptForWindow(segments, sc.startSec, sc.endSec);
    content.push({
      type: "text",
      text: `SCENE ${sc.index} @ [${secToMmSs(sc.startSec)}] (window ${sc.startSec.toFixed(1)}-${sc.endSec.toFixed(1)}s).` +
        (dialogue ? ` Dialogue: "${dialogue}"` : ` Dialogue: (none)`),
    });
  }
  const cast = movie.cast
    ? ` Film characters (use these names in beat notes — NOT actors' real names): ${movie.cast}.`
    : ` No cast list provided — derive character names in beat notes PRIMARILY from the dialogue shown above (self-introductions, characters addressed by name, or named by other speakers). Only fall back to your own knowledge of this film when the dialogue gives no name. Never use actor real names. If uncertain, use neutral labels such as "the trainer", "the manager", "the daughter", "one of the men", or "the officer" in beat notes.`;
  content.push({
    type: "text",
    text:
      `These are CHRONOLOGICAL key scenes from "${movie.title}" (film length ${Math.round(movie.durationSec)}s).` +
      cast + `\n\n` +
      `For EACH scene above, write ONE short factual beat note (max ~14 words) describing what happens, ` +
      `using REAL character names from the dialogue when possible.\n` +
      `IMPORTANT: Skip any scenes showing studio logos, production company credits, or opening title cards. ` +
      `Only describe scenes with actual plot/character content.\n` +
      (isFirstBatch
        ? `ALSO return a "characters" array: the main characters and a 3-6 word note on who they are / their ` +
          `relationships, inferred from the dialogue.\n`
        : ``) +
      `Respond with valid JSON ONLY:\n` +
      `{ ${isFirstBatch ? `"characters": [ { "name": "...", "note": "..." } ], ` : ``}` +
      `"beats": [ { "index": 0, "note": "..." } ] }\n` +
      `Echo the EXACT scene indexes shown above, in the SAME order. Do not renumber them.\n` +
      `No prose, no script.`,
  });
  return [{ role: "user", content }];
}

/**
 * Fix C — Stage A validation pass.
 * Re-shows the same scene frames + proposed notes to Claude. Claude checks
 * whether each note describes what is ACTUALLY VISIBLE in the frames — not
 * what it knows about the film from memory. Corrected notes replace hallucinated
 * ones. Fails gracefully: if the call errors, original notes are kept.
 */
export function buildValidationMessages({ movie, scenes, noteByIndex }) {
  const content = [];
  for (const sc of scenes) {
    if (Array.isArray(sc.frameBase64s) && sc.frameBase64s.length > 0) {
      const LABELS = ["start", "25%", "mid", "75%", "end"];
      for (let fi = 0; fi < sc.frameBase64s.length; fi++) {
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: sc.frameBase64s[fi] } });
        if (fi < sc.frameBase64s.length - 1) {
          content.push({ type: "text", text: `[scene ${sc.index} – ${LABELS[fi] ?? fi}]` });
        }
      }
    } else if (sc.base64) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: sc.base64 } });
    }
    const note = noteByIndex.get(sc.index) || "(no note)";
    content.push({
      type: "text",
      text: `SCENE ${sc.index} @ [${secToMmSs(sc.startSec)}] (${sc.startSec.toFixed(1)}-${sc.endSec.toFixed(1)}s).\nNOTE: "${note}"`,
    });
  }
  content.push({
    type: "text",
    text:
      `These are scene frames from "${movie.title}" with their proposed beat notes.\n` +
      `For EACH scene, verify: does the note describe what is ACTUALLY VISIBLE in the frames?\n` +
      `VALIDATION RULES:\n` +
      `- ok=false if the note names characters, events, or actions NOT confirmed by what is visible.\n` +
      `- ok=false if the note describes something that could only come from knowing the plot (not from seeing the frames).\n` +
      `- ok=true if the note describes a location, action type, or mood that the frames clearly support.\n` +
      `- ok=true if names in the note match faces visible or timestamps on-screen.\n` +
      `For ok=false, provide a corrected note (max 14 words) describing ONLY what the frames show.\n\n` +
      `Respond with valid JSON ONLY:\n` +
      `{ "validations": [ { "index": 0, "ok": true } ] }\n` +
      `Add "note": "corrected text" for ok=false entries only. No prose.`,
  });
  return [{ role: "user", content }];
}

/**
 * v5 independent semantic QC. A separate multimodal review pass examines the
 * same approved scene frames
 * against the finished narration, but can only score/reject — it never chooses
 * timestamps or relocates footage.
 */
export function buildNarrationQcMessages({ scenes, narrationByIndex }) {
  const content = [];
  for (const sc of scenes) {
    const frames = Array.isArray(sc.frameBase64s) ? sc.frameBase64s : (sc.base64 ? [sc.base64] : []);
    // Three frames are enough for QC and keep Gemini request size predictable.
    const picks = frames.length <= 3 ? frames : [frames[0], frames[Math.floor(frames.length / 2)], frames[frames.length - 1]];
    for (const data of picks) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    }
    content.push({
      type: "text",
      text: `SCENE ${sc.index} (${sc.startSec.toFixed(1)}-${sc.endSec.toFixed(1)}s)\n` +
        `NARRATION: ${String(narrationByIndex.get(sc.index) || "").slice(0, 900)}`,
    });
  }
  content.push({
    type: "text",
    text:
      `Act as a strict movie-recap visual QC reviewer. For every SCENE, score how well the narration ` +
      `describes what is visibly shown in that scene's frames. Dialogue/plot knowledge may clarify names, ` +
      `but do not accept narration about an event not visible here. Return JSON only:\n` +
      `{"results":[{"index":0,"score":0.0,"ok":false,"reason":"short reason"}]}\n` +
      `score 0.85-1.0 = direct visible match; 0.65-0.84 = acceptable same-event context; below 0.65 = reject.`,
  });
  return [{ role: "user", content }];
}

export function buildNarrationRepairMessages({ scene, note, narration, maxWords }) {
  const content = [];
  const frames = Array.isArray(scene.frameBase64s) ? scene.frameBase64s : (scene.base64 ? [scene.base64] : []);
  const picks = frames.length <= 3 ? frames : [frames[0], frames[Math.floor(frames.length / 2)], frames[frames.length - 1]];
  for (const data of picks) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
  }
  content.push({
    type: "text",
    text:
      `Rewrite this movie-recap narration so every event is directly visible in the attached frames. ` +
      `Use the factual note as ground truth. Preserve names only when supported. Maximum ${maxWords} words; ` +
      `complete sentences; present tense; no meta-commentary.\n\n` +
      `NOTE: ${note}\nCURRENT NARRATION: ${narration}\n\n` +
      `Return JSON only: {"narration":"corrected text"}`,
  });
  return [{ role: "user", content }];
}

export function buildContinuityMessages({ beats, characters, previousEnding = "", nextOpening = "" }) {
  const cast = (characters || []).map((c) => `- ${c.name}: ${c.note}`).join("\n");
  const rows = (beats || []).map((b) => {
    const maxWords = Math.max(6, Math.min(45, Math.floor((Number(b.endSec) - Number(b.startSec)) * 2.05)));
    return `${b.index} | MAX ${maxWords} WORDS | VISIBLE NOTE: ${b.reason} | CURRENT: ${b.narration}`;
  }).join("\n");
  return [{
    role: "user",
    content:
`Edit these consecutive movie-recap beats into one naturally continuing story while preserving exact visual grounding.

CANONICAL CHARACTERS:
${cast}

${previousEnding ? `PREVIOUS BATCH ENDING: ${previousEnding}\n` : ""}
${nextOpening ? `NEXT BATCH OPENING (context only): ${nextOpening}\n` : ""}
BEATS:
${rows}

RULES:
1. Return every numeric index exactly once and in the same order.
2. Preserve the visible event/fact in each beat. Never move an event to another beat or add an off-screen event.
3. Make each beat continue naturally from the previous one. Add only a short truthful time/location/causal bridge when needed.
4. Use canonical proper names for recurring principals from their first appearance. Never use "a man", "the man",
   "a blonde woman", "the older man", or similar generic labels for a named main character.
5. Resolve note/transcript aliases to canonical names by role and chronology. Do not invent names for truly minor unnamed people.
6. Stay within each MAX word budget. Complete sentences, active present tense, no headings or meta-commentary.

Return JSON only:
{"beats":[{"index":0,"narration":"..."}]}`,
  }];
}

export function parseValidationResponse(rawText) {
  if (typeof rawText !== "string") return [];
  let s = rawText.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  let obj;
  try { obj = JSON.parse(s); }
  catch { try { obj = JSON.parse(repairJson(rawText)); } catch { return []; } }
  return Array.isArray(obj?.validations) ? obj.validations
    .filter((v) => Number.isFinite(v.index))
    .map((v) => ({
      index: Number(v.index),
      ok: v.ok !== false,
      note: typeof v.note === "string" ? v.note.trim() : null,
    })) : [];
}

/** Parse Stage-A scene notes: { characters?, beats:[{index,note}] }. */
export function parseSceneNotesResponse(rawText) {
  if (typeof rawText !== "string") throw new Error("Empty Claude response");
  let s = rawText.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  let obj;
  try { obj = JSON.parse(s); }
  catch { try { obj = JSON.parse(repairJson(rawText)); }
  catch { obj = JSON.parse(repairTruncatedArray(rawText)); } }
  const beats = Array.isArray(obj?.beats) ? obj.beats
    .filter((b) => Number.isFinite(b.index))
    .map((b) => ({ index: Number(b.index), note: typeof b.note === "string" ? b.note.trim() : "" })) : [];
  const characters = Array.isArray(obj?.characters) ? obj.characters
    .map((c) => ({ name: String(c?.name || "").trim(), note: String(c?.note || "").trim() }))
    .filter((c) => c.name) : [];
  return { beats, characters };
}

// ── Character name-drift merge (2026-07-03) ─────────────────────────────────
// Stage A runs per-batch (each batch of ~15-20 scenes is a SEPARATE Claude
// call), so the same person can be re-identified under a different spelling,
// nickname, or relationship label each time (observed on a real job: "Jordan"
// / "Jordan Mains" for the same promoter; "Layla" / "Leyla" / "Leila" /
// "Daughter" / "Tanja" / "Layla Ray Hope" all for the same daughter character;
// "Maureen" / "Maureen Hope" / "Baby" for the same wife, with CONTRADICTORY
// notes — one batch says she's already dead, another says she's alive and
// "concerned"). The old merge only deduped on an EXACT lowercased name match,
// so all of these variants ended up as separate, sometimes contradictory,
// entries in the cast sheet Stage B is told to "use consistently" — which
// directly caused inconsistent/wrong character naming in the narration.
//
// This heuristic catches the common PREFIX-style variants deterministically
// (free, no extra API call). It intentionally does NOT try to catch
// non-prefix aliases (different spellings, relationship labels like "Baby")
// — that needs semantic judgement, which `canonicalizeCharacterCast` below
// handles with one extra LLM call per analyze job.
const _HEDGE_NOTE_RE = /\b(possibly|maybe|perhaps|unclear|unsure|uncertain)\b|\bor\s+\w+\?/i;

function _charMergeKey(name) {
  return String(name || "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** Find an existing charByName key whose words are a whole-word prefix match of `key`, or vice versa. */
function _findPrefixAliasKey(charByName, key) {
  if (charByName.has(key)) return key;
  const words = key.split(" ").filter(Boolean);
  for (const existingKey of charByName.keys()) {
    const existingWords = existingKey.split(" ").filter(Boolean);
    if (words.length === existingWords.length) continue; // exact-length mismatch already handled by .has()
    const [shorter, longer] = words.length < existingWords.length ? [words, existingWords] : [existingWords, words];
    if (longer.slice(0, shorter.length).join(" ") === shorter.join(" ")) return existingKey;
  }
  return null;
}

function _mergeCharacterCandidate(charByName, c) {
  const key = _charMergeKey(c.name);
  if (!key) return;
  const matchKey = _findPrefixAliasKey(charByName, key);
  if (!matchKey) {
    charByName.set(key, { name: String(c.name).trim(), note: String(c.note || "").trim() });
    return;
  }
  const existing = charByName.get(matchKey);
  const candidateName = String(c.name).trim();
  const canonicalName = candidateName.length > existing.name.length ? candidateName : existing.name;
  const candidateNote = String(c.note || "").trim();
  const existingHedged = _HEDGE_NOTE_RE.test(existing.note || "");
  const candidateHedged = _HEDGE_NOTE_RE.test(candidateNote);
  let canonicalNote = existing.note;
  if (existingHedged && !candidateHedged && candidateNote) canonicalNote = candidateNote;
  else if (!existingHedged && candidateHedged) canonicalNote = existing.note;
  else if (candidateNote.length > (existing.note || "").length) canonicalNote = candidateNote;
  charByName.set(matchKey, { name: canonicalName, note: canonicalNote });
}

/**
 * Pass 1.5 (character canonicalization): after all Stage-A batches are
 * merged (prefix-alias merge above), send the raw candidate cast list PLUS
 * sample beat-note context back to Claude for a semantic dedup pass. This
 * catches non-prefix aliases the string heuristic can't (different
 * spellings, relationship labels standing in for a named character,
 * contradictory notes about the same person). Runs ONCE per analyze job.
 */
export function buildCanonicalizeCharactersMessages({ movie, characters, beatNotes = [] }) {
  const castList = characters.map((c, i) => `${i + 1}. ${c.name}: ${c.note}`).join("\n");
  const contextNotes = beatNotes.slice(0, 140)
    .map((b) => `- [${b.index}] ${b.note}`)
    .filter(Boolean)
    .join("\n");
  return [{
    role: "user",
    content: [{
      type: "text",
      text:
        `You extracted this RAW candidate character list from "${movie.title}" by analyzing scenes in ` +
        `separate independent batches. Because each batch was processed without seeing the others, the ` +
        `SAME person may appear multiple times under different spellings, nicknames, misspellings, or ` +
        `relationship labels (e.g. "Jordan" and "Jordan Mains" could be the same promoter; "Layla", ` +
        `"Leyla", "Leila", "the daughter", and a first name could all be the same character if the notes ` +
        `describe the same role/relationship). Some notes may also directly CONTRADICT each other about ` +
        `the same person (e.g. one says deceased, another says alive) — this is a sign they are the same ` +
        `character with an unresolved fact, not two different people.\n\n` +
        `RAW CANDIDATES:\n${castList}\n\n` +
        (contextNotes ? `SCENE CONTEXT (sample beat notes, use to identify who is who):\n${contextNotes}\n\n` : ``) +
        `Produce a CLEAN, DEDUPLICATED canonical cast list:\n` +
        `  1. Merge every candidate that plausibly refers to the SAME person into ONE entry.\n` +
        `  2. Choose the most complete, correctly-spelled proper CHARACTER name as canonical. You may use ` +
        `     established knowledge of "${movie.title}" only to resolve the main cast's proper character names ` +
        `     and obvious transcript misspellings; never use actor names.\n` +
        `  3. GENERIC-ALIAS RULE (critical): merge labels such as "the blonde woman", "the older man", ` +
        `     "the driver", "the wife", "the father", or "the protagonist" into an existing named character ` +
        `     whenever relationship, location, chronology, or context shows they are the same person. Do not ` +
        `     leave a generic duplicate beside its named counterpart (for example, a protagonist's named wife ` +
        `     and "the blonde woman" viewing a house with him must be one entry).\n` +
        `  4. Every recurring lead, spouse, child, parent, ally, and principal antagonist must use a proper ` +
        `     character name when the film identity is established. Keep a neutral role label only for truly ` +
        `     unnamed/minor people.\n` +
        `  5. Write ONE factual note per character (5-10 words). If candidates conflict, use whichever fact is ` +
        `     supported by the majority, or the LATER-appearing note if truly a toss-up. NEVER hedge with ` +
        `     "possibly"/"maybe"/"unclear" in the final note — pick a side or state the role only.\n` +
        `  6. Do NOT invent new minor characters or facts. Proper names for established main characters are ` +
        `     allowed only to resolve candidates already present in the scenes.\n` +
        `  7. Keep at most 20 entries — drop truly minor one-off mentions with no narrative weight.\n\n` +
        `Respond with valid JSON ONLY: { "characters": [ { "name": "...", "note": "..." } ] }\nNo prose.`,
    }],
  }];
}

export function parseCanonicalCharactersResponse(rawText) {
  if (typeof rawText !== "string") throw new Error("Empty Claude response");
  let s = rawText.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  let obj;
  try { obj = JSON.parse(s); }
  catch { try { obj = JSON.parse(repairJson(rawText)); }
  catch { obj = JSON.parse(repairTruncatedArray(rawText)); } }
  const characters = Array.isArray(obj?.characters) ? obj.characters
    .map((c) => ({ name: String(c?.name || "").trim(), note: String(c?.note || "").trim() }))
    .filter((c) => c.name) : [];
  return characters;
}

/**
 * Pass 1-B (multi-pass v3 – story outline):
 * After all Stage-A batches are done, synthesise ONE story outline from the
 * merged beat notes + transcript. This shared narrative contract prevents
 * plot drift when Stage B writes per-beat narration across multiple Claude
 * batches: characters are introduced in the right order, revelations appear
 * only once, and the emotional arc is consistent across the whole video.
 *
 * Called once, after all Stage-A batches complete.
 */
export function buildStoryOutlineMessages({ movie, beatNotes, transcriptBlock = "", overview = "" }) {
  const notesText = Array.isArray(beatNotes) && beatNotes.length
    ? beatNotes.map((n) => `[${n.t}] beat ${n.index}: ${n.note || "(no note)"}`).join("\n")
    : "(no beat notes available)";
  return [{
    role: "user",
    content: [{
      type: "text",
      text:
        `You are preparing a YouTube movie recap for "${movie.title}" (film length ${Math.round(movie.durationSec)}s).\n\n` +
        (overview
          ? `OFFICIAL PLOT SUMMARY (authoritative — use it to get character relationships and major plot facts right):\n${overview}\n\n`
          : "") +
        (transcriptBlock
          ? `TRANSCRIPT (real dialogue — treat as authoritative):\n${transcriptBlock}\n\n`
          : "") +
        `CHRONOLOGICAL SCENE NOTES (one per detected scene):\n${notesText}\n\n` +
        `Produce a STORY OUTLINE: 3–5 acts that divide the film into clear narrative phases ` +
        `(e.g. Setup, Rising Action, Midpoint, Climax, Resolution). For each act:\n` +
        `  • State the approximate timestamp range (startSec / endSec)\n` +
        `  • List the main characters present\n` +
        `  • Describe the central conflict or plot event in 2–3 sentences\n` +
        `  • Name the emotional tone (tense, hopeful, tragic, etc.)\n\n` +
        `This outline will be used in the next pass to keep the narration consistent — ` +
        `so be precise about WHO does WHAT, WHEN, and WHY. ` +
        `Reference actual transcript lines where possible. Do NOT invent events.\n\n` +
        `Respond with valid JSON ONLY:\n` +
        `{ "storyOutline": [ { "act": "Act 1 – Setup", "startSec": 0, "endSec": 0, ` +
        `"characters": ["..."], "summary": "...", "tone": "..." } ] }\n` +
        `No prose, no other keys.`,
    }],
  }];
}

/** Parse the story outline response. Returns outline array (empty on failure). */
export function parseStoryOutlineResponse(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) return [];
  let s = rawText.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  try {
    let obj;
    try { obj = JSON.parse(s); } catch { obj = JSON.parse(repairJson(rawText)); }
    const arr = Array.isArray(obj?.storyOutline) ? obj.storyOutline : [];
    return arr.map((a) => ({
      act: String(a.act || "").trim(),
      startSec: Number(a.startSec) || 0,
      endSec: Number(a.endSec) || 0,
      characters: Array.isArray(a.characters) ? a.characters.map(String) : [],
      summary: String(a.summary || "").trim(),
      tone: String(a.tone || "").trim(),
    })).filter((a) => a.act || a.summary);
  } catch {
    return [];
  }
}

/**
 * Stage B (scene-aware): write ONE continuous script grounded in the FULL
 * transcript, the ordered scene beats, and the extracted character list (so
 * names/relationships stay consistent). Text-only.
 */
export function buildSceneScriptMessages({ movie, channelName, beats, characters, segments = [], transcriptBlock = "", narrationLang = "English", storyOutline = [], batchInfo = null, overview = "", keywords = "" }) {
  const cast = movie.cast
    ? `\nFilm characters (use these names — NOT the actors' real names): ${movie.cast}.`
    : `\nNo cast list provided — derive character names PRIMARILY from the Whisper dialogue transcript below (characters introducing themselves, being addressed by name, or named by other speakers). Only fall back to your own knowledge of this specific film when the transcript is silent on a name. Never use actor real names. If a name or relationship is genuinely uncertain, use a neutral role label such as "the trainer", "the manager", "the daughter", "one of the men", or "the officer".`;
  const director = movie.director ? `, directed by ${movie.director}` : "";
  const year = movie.year ? ` (${movie.year})` : "";
  const genre = movie.genre ? `${movie.genre} ` : "";
  const charText = characters && characters.length
    ? `CHARACTERS (this is the FINAL, canonicalized cast list — use EXACTLY these names, every time, for every ` +
      `mention of these people; do not introduce a different spelling, nickname, or shortened form even if the ` +
      `transcript uses one — treat the transcript's variant as the SAME person listed here):\n` +
      characters.map((c) => `- ${c.name}: ${c.note}`).join("\n") + "\n\n"
    : "";
  // Pass 3 context: story outline from the intermediate outline pass.
  const outlineText = Array.isArray(storyOutline) && storyOutline.length
    ? `STORY OUTLINE (mandatory narrative contract — keep narration consistent with this arc):\n` +
      storyOutline.map((a) => `  ${a.act} [${a.startSec}–${a.endSec}s] ${a.characters?.join(", ") || ""}: ${a.summary} (tone: ${a.tone || "dramatic"})`).join("\n") + "\n\n"
    : "";
  // List the beats WITH their index + timecode so Claude returns narration per beat, in order.
  // v5 WORD BUDGET: narration must fit the exact approved clip window at normal
  // speed. It may not use the gap to the next selected scene. Speechify's real
  // measured pace is ~2.0–2.2 words/sec, so 2.05 wps leaves a small transition
  // margin. Short clips get short narration instead of freeze-frame padding.
  // Fix D: embed per-beat windowed dialogue directly in the beat list so
  // Stage B can only reference what was actually spoken at each beat's timestamp,
  // rather than reading ahead in the full 2-hour transcript and narrating events
  // that haven't appeared on screen yet.
  const beatText = beats && beats.length
    ? beats.map((b, bi) => {
        const spanSec = Math.max(1.5, Number(b.endSec) - Number(b.startSec));
        const wordBudget = Math.max(6, Math.min(45, Math.floor(spanSec * 2.05)));
        let line = `- beatId ${b.beatId || `beat-${String(b.index).padStart(4, "0")}`} | index ${b.index} @ [${b.t}] ` +
          `(${b.startSec.toFixed(1)}-${b.endSec.toFixed(1)}s, narration budget ≤${wordBudget} words): ${b.note || "(no note)"}`;
        if (Array.isArray(segments) && segments.length > 0) {
          const dlg = transcriptForWindow(segments, b.startSec - 5, b.endSec + 5, 350);
          if (dlg) line += `\n  Dialogue: "${dlg}"`;
        }
        return line;
      }).join("\n")
    : "(rely on the transcript)";
  // Batch context: when Pass 3 is split into chunks, tell Claude where it is in the story.
  const batchText = batchInfo
    ? `BATCH CONTEXT: You are writing beats ${batchInfo.start + 1}–${batchInfo.start + beats.length} of ${batchInfo.total} total beats.\n` +
      (batchInfo.prevEnding
        ? `The previous batch ended with this narration (continue seamlessly — do NOT repeat it):\n"...${batchInfo.prevEnding}"\n\n`
        : `This is the FIRST batch — begin the narration here.\n\n`)
    : "";
  const MOODS = "calm, tense, dramatic, emotional, epic, mysterious, dark, upbeat";
  return [{
    role: "user",
    content: [{
      type: "text",
      text:
        batchText +
        `You are a YouTube ${genre}recap scriptwriter for "${channelName}", specialised in COPYRIGHT-SAFE recaps.\n` +
        `Movie: "${movie.title}"${year}${director}${cast}. Film length ${Math.round(movie.durationSec)}s.\n\n` +
        charText +
        (overview
          ? `OFFICIAL PLOT SUMMARY (authoritative — reconcile the narration with this; use it to get character relationships correct and to avoid inventing events):\n${overview}\n\n`
          : "") +
        (keywords ? `THEMES (for tone/emphasis, not to be stated literally): ${keywords}.\n\n` : "") +
        outlineText +
        `CHARACTER / RELATIONSHIP ACCURACY CONTRACT (mandatory):
` +
        `- Do NOT infer family relationships unless the transcript or character list explicitly confirms them.
` +
        `- Do NOT invent names for unnamed people. Use neutral labels when uncertain.
` +
        `- Do NOT swap character names between people in the same scene.
` +
        `- MAIN-CHARACTER NAMING: once the canonical cast above identifies a recurring lead, spouse, child, ` +
        `parent, ally, or antagonist, use that character's proper name from their FIRST on-screen beat. ` +
        `Do not call a named principal "a man", "the man", "a blonde woman", "the older man", or another ` +
        `generic descriptor. Scene notes may contain transcript aliases/misspellings; reconcile them to the ` +
        `canonical cast by role and chronology.
` +
        `- If a transcript line is ambiguous, say "one of them" or describe the action without naming.
` +
        `- FIGHTER IDENTITY RULE (v3.0.0): boxing / sports films feature multiple fighters. ` +
        `DO NOT call every opposing fighter by the villain's name (e.g. "Escobar"). ` +
        `Use the correct opponent name for each fight/scene: if the transcript or beat note says ` +
        `"Brady", "Garcia", "opponent", or a different name, use THAT name — not a recurring ` +
        `antagonist. Reserve the villain's name only for beats where they are confirmed on screen ` +
        `by transcript dialogue or a beat note. When the opponent is unknown, use "his opponent", ` +
        `"the challenger", "the other fighter", etc.

` +
        `- CHRONOLOGICAL NAME-INTRODUCTION GUARD (v3.0.1, mandatory): a named character (especially ` +
        `a rival/antagonist) must NOT appear by name in any beat that occurs before their own ` +
        `canonical first on-screen appearance/confrontation with the protagonist. A character's ` +
        `name being mentioned in passing dialogue, commentary, or foreshadowing EARLIER in the ` +
        `transcript does NOT count as that character being "on screen" in an earlier, unrelated ` +
        `scene — it only means the audience has heard OF them, not that they are physically present. ` +
        `Concretely: if an early beat shows the protagonist sparring, training, or fighting an opponent ` +
        `BEFORE the main antagonist's first direct confrontation/press-conference/introduction scene ` +
        `(per the transcript or plot summary), that early opponent is a DIFFERENT person — label them ` +
        `generically ("his opponent", "the reigning champion", "the challenger") or by their own name ` +
        `if the transcript gives one, but NEVER reuse the antagonist's name for them just because it is ` +
        `the most memorable name available. When in doubt, cross-check the OFFICIAL PLOT SUMMARY (if ` +
        `provided) for the correct order in which rivals/opponents actually appear.

` +
        `- Relationship words like father, brother, uncle, wife, daughter, manager, trainer must be used only when confirmed.
` +
        `- Prefer accuracy over dramatic wording; a wrong name is worse than a generic label.
` +
        `- ANTI-HALLUCINATION (mandatory): only state a fact (an event, a prop, a location, a relationship, a ` +
        `character's fate) if it is directly evidenced by this beat's own note, the transcript, or the OFFICIAL ` +
        `PLOT SUMMARY above. Do NOT fill gaps with plausible-sounding invented detail — if the source material ` +
        `does not say it, leave it out or describe only what is generically visible instead of guessing specifics.

` +
        // Fix D: when per-beat dialogue is embedded in beatText (segments provided),
        // suppress the global 2-hour transcript. Stage B only sees dialogue for each
        // beat's own window, preventing read-ahead hallucinations of future events.
        (segments && segments.length > 0
          ? `Each beat's "Dialogue:" line is the Whisper transcript at that beat's exact ` +
            `timestamp window — treat it as the authoritative source for what is spoken in that scene. ` +
            `Do NOT narrate events not supported by the beat's own note and dialogue.\n\n`
          : (transcriptBlock
            ? `Ground the recap in this ACTUAL dialogue transcript (real plot, names, key lines). Do NOT invent ` +
              `events it does not support.\n\nTRANSCRIPT:\n${transcriptBlock}\n\n`
            : ``)) +
        `Here are the CHRONOLOGICAL on-screen beats (each is a real scene window in the film):\n${beatText}\n\n` +
        `Write ONE single, continuous voiceover recap in ${narrationLang} that tells the COMPLETE story ` +
        `from start to finish as a SINGLE coherent narrative arc (clear beginning, middle, end). ` +
        `This must be a THOROUGH, scene-by-scene retelling — NOT a short summary. Cover the setup, EVERY major plot ` +
        `turn, character motivations, key twists, climax, and the full ending. Paraphrase important dialogue and ` +
        `moments in detail. Write as many words as the story requires — do NOT rush, truncate, or skip scenes to ` +
        `hit a time target. A complete recap of a 2-hour film naturally needs 3000-5000+ spoken words; use however ` +
        `many words it takes to tell the whole story properly. ` +
        `PER-BEAT WORD BUDGET (mandatory — narration is spoken over that beat's own footage): each beat line ` +
        `above shows "narration budget ≤N words". Stay within it. N is sized to how much footage that scene ` +
        `actually has — exceeding it forces the video to freeze-frame while your narration keeps talking. ` +
        `If a beat's events need more words than its budget, move the extra detail to a LATER beat that ` +
        `covers the follow-up footage. ` +
        `TRANSCRIPT GROUNDING (mandatory): every sentence must be grounded in the actual dialogue transcript. ` +
        `If the transcript shows character X saying Y at timestamp T, the beat covering T must reference ` +
        `that dialogue. Never invent events the transcript does not support. Never skip or gloss over ` +
        `murders, deaths, betrayals, or confrontations — describe exactly HOW and WHY each one happens. ` +
        `Split the narration STRICTLY across the beats using this rule:\n` +
        `beat[i].narration MUST describe what is VISUALLY SHOWN in beat[i]'s own scene window ` +
        `[startSec-endSec] — the scene note/description for that beat is the SOURCE OF TRUTH for ` +
        `what to narrate. The transcript dialogue at that timestamp is a supporting reference to ` +
        `identify characters and confirm plot facts — it is NOT the primary cue for what to describe.\n` +
        `ANTI-ANTICIPATION RULE (critical — violating this desyncs the entire video): dialogue at a ` +
        `given timestamp often SETS UP or FORESHADOWS an action/event that only becomes visually ` +
        `true in the NEXT beat's footage (e.g. a character says "let's go" while beat[i]'s scene note ` +
        `still shows them standing still, and the walking/leaving only appears in beat[i+1]'s scene ` +
        `note). Do NOT let that dialogue pull beat[i]'s narration forward into describing beat[i+1]'s ` +
        `action. Write beat[i]'s narration to match beat[i]'s OWN scene note — describe the setup/ ` +
        `anticipation ("He turns to leave.") in beat[i], and save the resulting action for beat[i+1] ` +
        `once its scene note actually shows it. When in doubt, trust the scene note over the dialogue ` +
        `for WHAT is on screen, and use the dialogue only for WHO/WHY.\n` +
        `CONTENT SYNC RULES (violating these breaks the video):\n` +
        `  1. The viewer SEES beat[i]'s footage WHILE HEARING beat[i]'s narration — they MUST match. ` +
        `     Before finalizing beat[i]'s narration, re-check it against beat[i]'s own scene note — if ` +
        `     the narration describes something the scene note doesn't mention, rewrite it to match ` +
        `     the scene note instead of the transcript's timing.\n` +
        `  2. Write what is SPECIFICALLY VISIBLE at that timestamp (characters present, action occurring, ` +
        `     dialogue being spoken) — NOT a generic story paragraph that could fit anywhere.\n` +
        `  3. Introduce each character BY FULL NAME the first time they appear on screen, followed by ` +
        `     a brief description: "Jim Hanson, a Vietnam veteran turned rancher, surveys his land."\n` +
        `  3b. CHARACTER ATTRIBUTION PRECISION — when a scene contains multiple named characters ` +
        `     (e.g. a lawyer and their assistant, two siblings, or a protagonist and an ally), ` +
        `     ONLY attribute a specific action or line of dialogue to a character if the transcript ` +
        `     or visual confirms it. If you cannot confirm who said or did something, write ` +
        `     "one of them" or describe the action without naming the actor. NEVER swap names ` +
        `     between two characters who appear together in the same scene.\n` +
        `  4. Every major plot event (murder, death, betrayal, confrontation, revelation, twist) MUST ` +
        `     appear in the beat whose timestamp covers that event — describe HOW and WHY it happens.\n` +
        `  5. Do NOT advance the story beyond what the transcript shows at that timestamp.\n` +
        `  6. Keep each beat's narration proportional to its importance — longer beats (major plot ` +
        `     turns, reveals, climax) warrant more detail; transitional beats can be brief.\n` +
        `Read end-to-end the beats form ONE smooth story — do NOT restart or summarise twice. ` +
        `Keep every beat's narration proportional to that scene's importance. ` +
        `Refer to characters by the names above. ` +
        `CRITICAL — NO [INTRO]: Do NOT output an [INTRO] section, heading, or label under any ` +
        `circumstances. Do NOT write a channel welcome, hook, or teaser. The intro template has ` +
        `been removed from the app — any [INTRO] text is automatically stripped and wastes your ` +
        `token budget. Begin beat[0]'s narration IMMEDIATELY with the first line of the movie's ` +
        `story. Do NOT include any "subscribe" CTA or hashtags.\n` +
        `END the script with a clearly marked [OUTRO] section (2–3 sentences only): a thematic ` +
        `closing reflection on the film's message, tone, or legacy — NOT a channel plug, ` +
        `NOT "thanks for watching", NOT a subscribe request. Just a final thought on the movie.\n\n` +
        `NARRATION QUALITY RULES (violating any of these degrades the recap quality):\n` +
        `  A. VISIBLE ONLY: only describe events, objects, and characters visible in the provided frames ` +
        `     or confirmed by the transcript for that beat's timestamp. NEVER invent dialogue, props, ` +
        `     or actions not evidenced by the frames or transcript.\n` +
        `  B. STRICT CHRONOLOGY: write in story order — never flashback, flash-forward, or reference ` +
        `     future events before their beat's timestamp.\n` +
        `  C. NO REPETITION: if a fact was established in a prior beat (character identity, plot event, ` +
        `     revelation), do NOT restate it verbatim — reference briefly instead.\n` +
        `  D. PER-BEAT LENGTH: obey the exact "narration budget ≤N words" printed on each beat. ` +
        `     It is derived from that beat's available moving footage and overrides every other length target. ` +
        `     Use complete concise sentences, end at a natural pause, and never pad a short event to a minimum length.\n` +
        `  E. YOUTUBE NARRATION STYLE: punchy, direct, present-tense active voice. Specific nouns and ` +
        `     actions. No film-theory commentary, no meta-references to "the film" or "the scene". ` +
        `     Speak as if narrating the events AS they happen on screen.\n\n` +
        `ALSO choose a music mood for each beat from EXACTLY this set: ${MOODS}.\n\n` +
        `ALSO assign an importance score 1–10 to each beat:\n` +
        `  1–3 = transitional/establishing shot, 4–6 = regular story beat,\n` +
        `  7–8 = significant moment (confrontation, discovery), 9–10 = climax or major reveal.\n` +
        `Footage identity is server-controlled. Do NOT choose sceneIds or timestamps.\n\n` +
        `ALSO assign confidence (0.0–1.0): how confident you are that the narration accurately\n` +
        `  matches the visible footage at this beat's timestamp.\n` +
        `  0.9–1.0 = strong match (you can clearly identify the action from transcript + frames).\n` +
        `  0.7–0.89 = reasonable match (some ambiguity but story is consistent).\n` +
        `  Below 0.7 = uncertain (scene is ambiguous, transition, or hard to read).\n\n` +
        `ALSO assign beatType from EXACTLY this set: setup | mystery | danger | investigation | action | reveal | emotion | climax | resolution\n` +
        `  Choose the single type that best describes the dominant mood/action of this beat's on-screen content.\n` +
        `  action = fights/chases/escapes, danger = threat/tension/confrontation, climax = peak moment of the story,\n` +
        `  investigation = detective/analysis/discovery-in-progress, mystery = unresolved/unknown/atmosphere,\n` +
        `  reveal = twist/revelation/information disclosed, emotion = grief/joy/love/loss visible on screen,\n` +
        `  resolution = aftermath/conclusion/normalcy restored, setup = introduction/establishing/travel.\n\n` +
        `Respond with valid JSON ONLY of the form:\n` +
        `{ "beats": [ { "index": 0, "narration": "...", "mood": "tense", "importance": 7, "beatType": "action", "confidence": 0.91 } ] }\n` +
        `Include EVERY beat index shown above, in the same order. No prose, no other keys.\n` +
        `CRITICAL — index values: echo the EXACT "index" numbers from the beat list above. ` +
        `They are NOT sequential (filtered scenes leave gaps like 0,1,2,7,8,14). ` +
        `Do NOT renumber them 0,1,2,3,… — a wrong index attaches your narration to the wrong footage.`,
    }],
  }];
}

const VALID_MOODS = new Set(["calm", "tense", "dramatic", "emotional", "epic", "mysterious", "dark", "upbeat"]);

/** Parse Stage-B per-beat script: { beats:[{index,narration,mood}] }. */
export function parseSceneScriptResponse(rawText) {
  if (typeof rawText !== "string") throw new Error("Empty Claude response");
  let s = rawText.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  let obj;
  try { obj = JSON.parse(s); }
  catch { try { obj = JSON.parse(repairJson(rawText)); }
  catch { obj = JSON.parse(repairTruncatedArray(rawText)); } }
  const arr = Array.isArray(obj?.beats) ? obj.beats : [];
  const beats = arr
    .filter((b) => Number.isFinite(b.index))
    .map((b) => ({
      index: Number(b.index),
      narration: stripIntroSection(typeof b.narration === "string" ? b.narration.trim() : ""),
      mood: VALID_MOODS.has(String(b.mood || "").toLowerCase()) ? String(b.mood).toLowerCase() : "dramatic",
      importance: Number.isFinite(Number(b.importance)) && Number(b.importance) >= 1 && Number(b.importance) <= 10
        ? Math.round(Number(b.importance)) : null,
      sceneIds: Array.isArray(b.sceneIds) && b.sceneIds.length > 0 && b.sceneIds.every((id) => Number.isFinite(Number(id)))
        ? b.sceneIds.map(Number) : null,
      // Confidence: 0.0–1.0 — how well narration matches footage at this beat's timestamp.
      confidence: Number.isFinite(Number(b.confidence)) && Number(b.confidence) >= 0 && Number(b.confidence) <= 1
        ? Math.round(Number(b.confidence) * 100) / 100 : null,
      // Beat type: dominant scene content category for cut-timing overrides (Item 6).
      beatType: (function() {
        const VALID_BT = new Set(["setup","mystery","danger","investigation","action","reveal","emotion","climax","resolution"]);
        const bt = typeof b.beatType === "string" ? b.beatType.trim().toLowerCase() : null;
        return VALID_BT.has(bt) ? bt : null;
      })(),
    }));
  if (beats.length === 0) throw new Error("Claude scene-script response had no beats");
  return beats;
}

/**
 * Reconcile LLM rows against immutable server indexes.
 * Only exact, unique IDs are accepted. Invalid/renumbered/duplicate rows are
 * ignored and their expected scenes remain in `missing` for targeted retry.
 */
export function reconcileExactIndexedRows(expected, returned) {
  const expectedById = new Map(
    (Array.isArray(expected) ? expected : []).map((row) => [Number(row.index), row])
  );
  const acceptedById = new Map();
  let invalidCount = 0;
  for (const row of Array.isArray(returned) ? returned : []) {
    const id = Number(row?.index);
    if (!Number.isFinite(id) || !expectedById.has(id) || acceptedById.has(id)) {
      invalidCount++;
      continue;
    }
    acceptedById.set(id, row);
  }
  const missing = [...expectedById.values()].filter((row) => !acceptedById.has(Number(row.index)));
  return {
    acceptedById,
    missing,
    invalidCount,
    complete: missing.length === 0 && acceptedById.size === expectedById.size,
    ordered: [...expectedById.keys()].map((id) => acceptedById.get(id)).filter(Boolean),
  };
}

export function semanticQuarantineLimit(totalBeats) {
  return Math.max(2, Math.ceil(Math.max(0, Number(totalBeats) || 0) * 0.05));
}

/**
 * Orchestrate the full 3-pass scene-aware analysis (v3.0).
 *
 * Pass 1 (Stage A):  buildSceneNotesMessages → beat notes + character list.
 *                    Batch size = floor(100 / imagesPerScene): with 5 frames/scene
 *                    that is 20 scenes per batch (100 images), keeping within the
 *                    Claude API image limit.
 *
 * Pass 2 (Outline):  buildStoryOutlineMessages → story arc (acts, characters, tone).
 *                    Provides a narrative contract that prevents plot-drift when Stage B
 *                    writes per-beat narration — characters introduced in order,
 *                    revelations appear only once, emotional arc stays consistent.
 *
 * Pass 3 (Stage B):  buildSceneScriptMessages → per-beat narration + music moods.
 *                    Receives story outline so narration stays coherent across batches.
 *
 * @param scenes  array of { index, startSec, endSec, sceneStart, sceneEnd, base64, frameBase64s? }
 * @returns { script, timestamps, characters, beats, storyOutline }
 */
export async function analyzeWithScenes({
  apiKey, model, provider = "claude", movie, channelName, scenes, segments = [], transcriptBlock = "", narrationLang = "English",
  overview = "", keywords = "",
  semanticQcEnabled = false, qcProvider = "claude", qcApiKey = "", qcModel = "claude-sonnet-4-5",
}) {
  if (!scenes || scenes.length === 0) throw new Error("analyzeWithScenes: no scenes provided");

  // Dynamic batch size: 5 frames/scene → floor(100/5) = 20, capped at 15.
  // Cap at 15 scenes per batch to stay well within Claude's output token limit
  // (~200 tokens/note × 15 scenes = ~3000 tokens, safely below 4096 max output).
  // Larger batches (20+) risk mid-JSON truncation on dense/complex films.
  const imagesPerScene = Array.isArray(scenes[0]?.frameBase64s) && scenes[0].frameBase64s.length > 0
    ? scenes[0].frameBase64s.length : 1;
  const BATCH = Math.max(1, Math.min(15, Math.floor(100 / imagesPerScene)));
  const batches = [];
  for (let i = 0; i < scenes.length; i += BATCH) batches.push(scenes.slice(i, i + BATCH));

  // ── PASS 1 (Stage A): scene notes + characters ──────────────────────────
  // ACCURACY FIX (v2.9.5): request the character sheet on EVERY batch and merge,
  // instead of only trusting batch 0. Previously the authoritative cast list came
  // solely from the first ~15 scenes, so any character introduced later in the
  // film (villains, allies, family revealed mid-story) was absent from the sheet
  // that grounds Stage-B narration → they got mislabeled or name-swapped. Merging
  // per-name across all batches gives Stage B the full, consistent cast.
  const noteByIndex = new Map();
  const charByName = new Map(); // lowercased name -> { name, note }
  const requestSceneNotes = async (sceneBatch, label) => {
    const acceptedById = new Map();
    const charactersOut = [];
    // Retry the same batch once; transient omissions often recover immediately.
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages = buildSceneNotesMessages({ movie, scenes: sceneBatch, segments, isFirstBatch: true });
      const text = await callLLM({ provider, apiKey, model, messages });
      const parsed = parseSceneNotesResponse(text);
      charactersOut.push(...parsed.characters);
      const reconciled = reconcileExactIndexedRows(sceneBatch, parsed.beats);
      for (const [id, row] of reconciled.acceptedById) {
        if (!acceptedById.has(id)) acceptedById.set(id, row);
      }
      // A singleton request is positionally unambiguous even if the model
      // insists on renumbering it to zero.
      if (sceneBatch.length === 1 && parsed.beats.length === 1) {
        acceptedById.set(Number(sceneBatch[0].index), {
          ...parsed.beats[0],
          index: sceneBatch[0].index,
        });
      }
      const missingNow = sceneBatch.filter((sc) => !acceptedById.has(Number(sc.index)));
      if (missingNow.length === 0) {
        if (attempt > 0) {
          console.log(`[analyzeWithScenes] NOTE-RETRY ${label}: recovered all ${sceneBatch.length} scenes on retry`);
        }
        return { beats: sceneBatch.map((sc) => acceptedById.get(Number(sc.index))), characters: charactersOut };
      }
      console.warn(
        `[analyzeWithScenes] NOTE-RETRY ${label}: attempt ${attempt + 1}/2 returned ` +
        `${acceptedById.size}/${sceneBatch.length} exact scene IDs; missing=[${missingNow.map((s) => s.index).join(",")}]`
      );
    }

    const missing = sceneBatch.filter((sc) => !acceptedById.has(Number(sc.index)));
    if (missing.length === 0) {
      return { beats: sceneBatch.map((sc) => acceptedById.get(Number(sc.index))), characters: charactersOut };
    }
    if (sceneBatch.length === 1) {
      throw new Error(`Stage-A scene ${sceneBatch[0].index} omitted after two exact-ID attempts`);
    }

    // Retry only missing IDs in small groups. If a 5-scene group still omits
    // rows, recursion eventually reaches single-scene requests.
    for (let i = 0; i < missing.length; i += 5) {
      const subset = missing.slice(i, i + 5);
      const recovered = await requestSceneNotes(subset, `${label}/missing-${i / 5 + 1}`);
      charactersOut.push(...recovered.characters);
      for (const row of recovered.beats) acceptedById.set(Number(row.index), row);
    }
    return { beats: sceneBatch.map((sc) => acceptedById.get(Number(sc.index))), characters: charactersOut };
  };

  for (let bi = 0; bi < batches.length; bi++) {
    const parsed = await requestSceneNotes(batches[bi], `batch-${bi}`);
    for (const c of parsed.characters) {
      _mergeCharacterCandidate(charByName, c);
    }
    for (const b of parsed.beats) noteByIndex.set(Number(b.index), b.note);
  }
  // Preserve first-appearance order (protagonists first); cap to avoid a bloated
  // cast of one-off minor names poisoning the Stage-B prompt.
  let characters = [...charByName.values()].slice(0, 30);
  console.log(`[analyzeWithScenes] cast sheet: ${characters.length} character(s) after prefix-merge across ${batches.length} batch(es) (pre-canonicalization)`);

  // Build ordered beat list — trust Claude's scene notes exclusively.
  // Claude is instructed to label studio logos, title cards, and production
  // company screens as "SKIP". We honour that judgement and drop only those
  // beats. No hard time thresholds — story content varies by film and region.
  const CREDITS_LABEL_RE = /\b(studio|logo|production\s*company|distributor|credits?|title\s*card|opening\s*credits?|closing\s*credits?|credits?\s+roll)\b/i;
  // FIX (SYNC-FIXES #4): missing indices used to vanish silently, making it
  // impossible to tell whether the length shortfall was Claude writing nothing,
  // Claude explicitly flagging SKIP, or the credits-label regex over-firing
  // (a known issue with Gemini being too eager to call non-credit scenes
  // "titles"/"logos"). Tally the drop reason per index so this is diagnosable
  // from logs instead of just "56 of 179 survived".
  const _dropReasons = { empty: 0, skip: 0, credits: 0 };
  const _droppedIdx = { empty: [], skip: [], credits: [] };
  let beats = scenes
    .map((sc) => ({
      index: sc.index,
      t: secToMmSs(sc.startSec),
      note: noteByIndex.get(sc.index) || "",
      startSec: sc.startSec,
      endSec: sc.endSec,
      // Opening logo safety: actual story may be silent, but an opening visual
      // with no dialogue in the first 90s is too ambiguous to narrate reliably.
      hasDialogue: Boolean(transcriptForWindow(segments, sc.startSec, sc.endSec, 80)),
    }))
    .filter((b) => {
      const note = b.note.trim();
      if (!note) { _dropReasons.empty++; _droppedIdx.empty.push(b.index); return false; }                                     // Claude wrote nothing — skip
      if (note.toUpperCase().startsWith("SKIP")) { _dropReasons.skip++; _droppedIdx.skip.push(b.index); return false; }     // Claude flagged it
      if (CREDITS_LABEL_RE.test(note)) { _dropReasons.credits++; _droppedIdx.credits.push(b.index); return false; }               // Claude described credits
      if (b.startSec < 90 && !b.hasDialogue) { _dropReasons.credits++; _droppedIdx.credits.push(b.index); return false; }
      return true;                                                  // real story content — keep
    })
    .sort((a, b) => a.startSec - b.startSec);
  {
    const _totalDropped = _dropReasons.empty + _dropReasons.skip + _dropReasons.credits;
    if (_totalDropped > 0) {
      console.log(
        `[analyzeWithScenes] NOTE-FILTER: kept ${beats.length}/${scenes.length} scenes ` +
        `(dropped ${_totalDropped}: empty=${_dropReasons.empty}, SKIP=${_dropReasons.skip}, credits-label=${_dropReasons.credits})`
      );
      if (_dropReasons.credits > 0) {
        console.log(`[analyzeWithScenes] NOTE-FILTER: credits-label dropped indices: ${_droppedIdx.credits.slice(0, 20).join(", ")}${_droppedIdx.credits.length > 20 ? ` (+${_droppedIdx.credits.length - 20} more)` : ""}`);
      }
    }
  }

  // ── PASS 1.1 (Fix C — Stage A validation): verify notes match visible frames ──
  // Re-show the same frames to Claude and ask it to flag notes that describe
  // events NOT visible in the frames (film-knowledge bleed from training memory).
  // Only corrects flagged beats, so extra API calls are proportional to error rate.
  {
    let _valFlagged = 0, _valCorrected = 0;
    for (let bi = 0; bi < batches.length; bi++) {
      try {
        const valMessages = buildValidationMessages({ movie, scenes: batches[bi], noteByIndex });
        const valText = await callLLM({ provider, apiKey, model, messages: valMessages });
        const validations = parseValidationResponse(valText);
        for (const v of validations) {
          if (!v.ok) {
            _valFlagged++;
            if (v.note) { noteByIndex.set(v.index, v.note); _valCorrected++; }
          }
        }
      } catch (valErr) {
        console.warn(`[analyzeWithScenes] NOTE-VALIDATION batch ${bi} failed (non-fatal):`, valErr?.message || valErr);
      }
    }
    if (_valFlagged > 0) {
      console.log(`[analyzeWithScenes] NOTE-VALIDATION: ${_valFlagged} note(s) flagged as potentially hallucinated, ${_valCorrected} corrected`);
    }
  }

  // v5: validation updates noteByIndex, so rebuild the beat list before any
  // downstream prompt. Previously Stage B, character canonicalization, and the
  // story outline all consumed stale pre-validation notes.
  beats = beats
    .map((b) => ({ ...b, note: noteByIndex.get(b.index) || b.note || "" }))
    .filter((b) => {
      const note = String(b.note || "").trim();
      return Boolean(note)
        && !note.toUpperCase().startsWith("SKIP")
        && !CREDITS_LABEL_RE.test(note);
    })
    .sort((a, b) => a.startSec - b.startSec)
    .map((b, denseIndex) => ({
      ...b,
      beatId: `beat-${String(denseIndex).padStart(4, "0")}`,
    }));

  // ── PASS 1.5 (Character canonicalization): resolve semantic name drift ──
  // The prefix-merge above only catches simple substring aliases. Names that
  // drift non-substring (different spelling, relationship label standing in
  // for a proper name, contradictory facts about the same person) still slip
  // through and poison the "use these names consistently" cast sheet given
  // to Stage B — the direct cause of inconsistent/wrong character naming in
  // the narration. One extra LLM call, with full beat-note context, fixes
  // this semantically. Fails gracefully by keeping the prefix-merged list.
  if (characters.length > 1) {
    try {
      const canonMessages = buildCanonicalizeCharactersMessages({ movie, characters, beatNotes: beats });
      const canonText = await callLLM({ provider, apiKey, model, messages: canonMessages, maxTokens: 2000 });
      const canonChars = parseCanonicalCharactersResponse(canonText);
      if (canonChars.length > 0) {
        characters = canonChars;
        console.log(`[analyzeWithScenes] cast sheet: canonicalized ${characters.length} character(s) (semantic dedup pass)`);
      }
    } catch (canonErr) {
      console.warn("[analyzeWithScenes] character canonicalization pass failed (keeping prefix-merged list):", canonErr?.message || canonErr);
    }
  }

  // ── PASS 2 (Story Outline): narrative contract ──────────────────────────
  // Synthesise a shared story arc from beat notes + transcript. Stage B uses
  // this to keep narration coherent across all beats/batches. Fails gracefully.
  let storyOutline = [];
  try {
    const outlineMessages = buildStoryOutlineMessages({ movie, beatNotes: beats, transcriptBlock, overview });
    const outlineText = await callLLM({ provider, apiKey, model, messages: outlineMessages, maxTokens: 2000 });
    storyOutline = parseStoryOutlineResponse(outlineText);
  } catch (outlineErr) {
    console.warn("[analyzeWithScenes] story outline pass failed (continuing):", outlineErr?.message || outlineErr);
  }

  // ── PASS 3 (Stage B): per-beat narration + moods — batched ──────────────
  // Claude Sonnet 4.5 output cap: 16,384 tokens.
  // 60 beats × ~200 tokens/beat ≈ 12,000 tokens per call — leaves ~4,000 tokens of headroom.
  // 174 beats → 3 calls (vs. old single call that needed ~35,000 tokens and always truncated).
  const SCRIPT_BATCH = 60;
  const scriptBatches = [];
  for (let i = 0; i < beats.length; i += SCRIPT_BATCH) scriptBatches.push(beats.slice(i, i + SCRIPT_BATCH));

  let beatScript = [];
  let prevNarrationEnd = "";
  const requestNarrations = async (beatBatch, batchInfo, label) => {
    const acceptedById = new Map();
    for (let attempt = 0; attempt < 2; attempt++) {
      const scriptMessages = buildSceneScriptMessages({
        movie, channelName, beats: beatBatch, characters, segments,
        transcriptBlock, narrationLang, storyOutline, batchInfo, overview, keywords,
      });
      const scriptText = await callLLM({ provider, apiKey, model, messages: scriptMessages, maxTokens: 14000 });
      const parsed = parseSceneScriptResponse(scriptText);
      const reconciled = reconcileExactIndexedRows(beatBatch, parsed);
      for (const [id, row] of reconciled.acceptedById) {
        if (!acceptedById.has(id)) acceptedById.set(id, row);
      }
      if (beatBatch.length === 1 && parsed.length === 1) {
        acceptedById.set(Number(beatBatch[0].index), { ...parsed[0], index: beatBatch[0].index });
      }
      const missingNow = beatBatch.filter((beat) => !acceptedById.has(Number(beat.index)));
      if (missingNow.length === 0) {
        if (attempt > 0) {
          console.log(`[analyzeWithScenes] SCRIPT-RETRY ${label}: recovered all ${beatBatch.length} beats on retry`);
        }
        return beatBatch.map((beat) => acceptedById.get(Number(beat.index)));
      }
      console.warn(
        `[analyzeWithScenes] SCRIPT-RETRY ${label}: attempt ${attempt + 1}/2 returned ` +
        `${acceptedById.size}/${beatBatch.length} exact beat IDs; missing=[${missingNow.map((b) => b.index).join(",")}]`
      );
    }
    const missing = beatBatch.filter((beat) => !acceptedById.has(Number(beat.index)));
    if (missing.length === 0) return beatBatch.map((beat) => acceptedById.get(Number(beat.index)));
    if (beatBatch.length === 1) {
      throw new Error(`Stage-B beat ${beatBatch[0].beatId || beatBatch[0].index} omitted after two attempts`);
    }
    for (let i = 0; i < missing.length; i += 5) {
      const subset = missing.slice(i, i + 5);
      const recovered = await requestNarrations(
        subset,
        { ...batchInfo, start: batchInfo.start + i, prevEnding: batchInfo.prevEnding },
        `${label}/missing-${i / 5 + 1}`,
      );
      for (const row of recovered) acceptedById.set(Number(row.index), row);
    }
    return beatBatch.map((beat) => acceptedById.get(Number(beat.index)));
  };

  for (let bi = 0; bi < scriptBatches.length; bi++) {
    const batchInfo = { start: bi * SCRIPT_BATCH, total: beats.length, prevEnding: prevNarrationEnd };
    const parsed = await requestNarrations(scriptBatches[bi], batchInfo, `batch-${bi}`);
    parsed.forEach((p, j) => {
      const sourceBeat = scriptBatches[bi][j];
      p.index = sourceBeat.index;
      // Immutable server identity; never trust an LLM-returned scene span.
      p.beatId = sourceBeat.beatId;
      p.sceneIds = [sourceBeat.index];
    });
    if (parsed.length > 0) prevNarrationEnd = parsed[parsed.length - 1].narration.slice(-300);
    beatScript = beatScript.concat(parsed);
  }

  const narrByIndex = new Map(beatScript.map((b) => [b.index, b]));
  let syncedBeats = beats.map((b) => {
    const n = narrByIndex.get(b.index);
    return {
      beatId: b.beatId,
      index: b.index,
      startSec: b.startSec,
      endSec: b.endSec,
      narration: stripCreditLeakSentences(n?.narration || b.note || ""),
      mood: n?.mood || "dramatic",
      // ChatGPT pipeline: importance (1-10) drives dynamic cut timing at render.
      importance: n?.importance ?? null,
      // v5: footage identity is server-assigned and immutable. Claude writes
      // narration only; it may not relocate or widen the source scene.
      sceneIds: [b.index],
      // ChatGPT pipeline: confidence (0.0-1.0) — how well narration matches footage.
      // Values below 0.7 trigger window expansion at render time (FIX B).
      confidence: n?.confidence ?? null,
      reason: b.note || "",
    };
  }).filter((b) => {
    const text = String(b.narration || b.reason || "");
    return Boolean(text.trim()) && !CREDITS_LABEL_RE.test(text);
  });

  // ── v5 PASS 3.5: continuity + canonical-name edit ───────────────────────
  // Stage B is intentionally scene-local for visual accuracy; this pass sees
  // consecutive text beats and repairs choppy restarts/generic identities
  // without changing footage ownership or exceeding scene word budgets.
  const requestContinuity = async (batch, label, previousEnding, nextOpening) => {
    const acceptedById = new Map();
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await callLLM({
        provider,
        apiKey,
        model,
        messages: buildContinuityMessages({ beats: batch, characters, previousEnding, nextOpening }),
        maxTokens: Math.max(1600, batch.length * 100),
        jsonMode: true,
      });
      const parsed = parseSceneScriptResponse(text);
      const reconciled = reconcileExactIndexedRows(batch, parsed);
      for (const [id, row] of reconciled.acceptedById) {
        if (!acceptedById.has(id)) acceptedById.set(id, row);
      }
      if (batch.length === 1 && parsed.length === 1) {
        acceptedById.set(Number(batch[0].index), { ...parsed[0], index: batch[0].index });
      }
      const missing = batch.filter((b) => !acceptedById.has(Number(b.index)));
      if (missing.length === 0) {
        if (attempt > 0) console.log(`[analyzeWithScenes] CONTINUITY-RETRY ${label}: recovered all beats`);
        return batch.map((b) => acceptedById.get(Number(b.index)));
      }
      console.warn(
        `[analyzeWithScenes] CONTINUITY-RETRY ${label}: attempt ${attempt + 1}/2 ` +
        `missing=[${missing.map((b) => b.index).join(",")}]`
      );
    }
    const missing = batch.filter((b) => !acceptedById.has(Number(b.index)));
    if (batch.length === 1) throw new Error(`Continuity edit omitted beat ${batch[0].index}`);
    for (let i = 0; i < missing.length; i += 5) {
      const subset = missing.slice(i, i + 5);
      const recovered = await requestContinuity(subset, `${label}/missing-${i / 5 + 1}`, previousEnding, nextOpening);
      for (const row of recovered) acceptedById.set(Number(row.index), row);
    }
    return batch.map((b) => acceptedById.get(Number(b.index)));
  };

  {
    const CONTINUITY_BATCH = 25;
    let previousEnding = "";
    for (let start = 0; start < syncedBeats.length; start += CONTINUITY_BATCH) {
      const batch = syncedBeats.slice(start, start + CONTINUITY_BATCH);
      const nextOpening = syncedBeats[start + CONTINUITY_BATCH]?.narration || "";
      const revised = await requestContinuity(
        batch,
        `batch-${Math.floor(start / CONTINUITY_BATCH)}`,
        previousEnding,
        nextOpening,
      );
      revised.forEach((row, j) => {
        const narration = String(row?.narration || "").trim();
        if (!narration) throw new Error(`Continuity edit returned empty narration for beat ${batch[j].index}`);
        const maxWords = Math.max(
          6,
          Math.min(45, Math.floor((Number(batch[j].endSec) - Number(batch[j].startSec)) * 2.05)),
        );
        const wc = narration.split(/\s+/).filter(Boolean).length;
        if (wc > maxWords) {
          console.warn(
            `[analyzeWithScenes] CONTINUITY beat ${batch[j].index}: ${wc} words exceeds ${maxWords}; ` +
            `keeping original footage-fit narration`
          );
        } else {
          syncedBeats[start + j] = { ...syncedBeats[start + j], narration };
        }
      });
      previousEnding = syncedBeats[Math.min(start + batch.length - 1, syncedBeats.length - 1)]?.narration?.slice(-240) || "";
    }
    console.log(`[analyzeWithScenes] CONTINUITY: refined ${syncedBeats.length} beats with canonical-name enforcement`);
  }

  // ── v5 PASS 4: independent multimodal semantic QC (score-only) ───────────
  // This replaces search/relocation systems such as Twelve Labs. The mapping
  // stays deterministic; Gemini may only approve or reject the authored beat.
  const semanticQc = [];
  if (semanticQcEnabled && qcApiKey) {
    const narrationByIndex = new Map(syncedBeats.map((b) => [b.index, b.narration]));
    const qcScenes = scenes.filter((s) => narrationByIndex.has(s.index));
    const QC_BATCH = 12;
    const runQc = async (sceneSubset) => {
      const output = [];
      for (let i = 0; i < sceneSubset.length; i += QC_BATCH) {
        const batch = sceneSubset.slice(i, i + QC_BATCH);
        const qcText = await callLLM({
          provider: qcProvider,
          apiKey: qcApiKey,
          model: qcModel,
          messages: buildNarrationQcMessages({ scenes: batch, narrationByIndex }),
          maxTokens: 1800,
          jsonMode: true,
        });
        let qcObj;
        try { qcObj = JSON.parse(qcText); }
        catch { qcObj = JSON.parse(repairJson(qcText)); }
        const results = Array.isArray(qcObj?.results) ? qcObj.results : [];
        if (results.length !== batch.length) {
          throw new Error(`Semantic QC count mismatch: sent ${batch.length}, received ${results.length}`);
        }
        results.forEach((result, j) => {
          output.push({
            index: batch[j].index,
            score: Math.max(0, Math.min(1, Number(result.score) || 0)),
            ok: result.ok === true,
            reason: String(result.reason || "").slice(0, 240),
          });
        });
      }
      return output;
    };

    semanticQc.push(...await runQc(qcScenes));
    let rejected = semanticQc.filter((q) => !q.ok || q.score < 0.65);
    if (rejected.length > 0) {
      // One automatic correction pass: original writer rewrites only rejected
      // beats against their frames; independent Gemini then scores them again.
      const sceneByIndex = new Map(scenes.map((s) => [s.index, s]));
      const beatByIndex = new Map(syncedBeats.map((b) => [b.index, b]));
      for (const failure of rejected) {
        const scene = sceneByIndex.get(failure.index);
        const beat = beatByIndex.get(failure.index);
        if (!scene || !beat) continue;
        const maxWords = Math.max(6, Math.min(45, Math.floor((scene.endSec - scene.startSec) * 2.05)));
        const repairText = await callLLM({
          provider,
          apiKey,
          model,
          messages: buildNarrationRepairMessages({
            scene,
            note: beat.reason,
            narration: beat.narration,
            maxWords,
          }),
          maxTokens: 500,
          jsonMode: true,
        });
        let repair;
        try { repair = JSON.parse(repairText); }
        catch { repair = JSON.parse(repairJson(repairText)); }
        const corrected = String(repair?.narration || "").trim();
        if (!corrected) throw new Error(`Semantic QC repair returned empty narration for scene ${failure.index}`);
        beat.narration = corrected;
        narrationByIndex.set(failure.index, corrected);
      }
      const rejectedScenes = rejected.map((q) => sceneByIndex.get(q.index)).filter(Boolean);
      const rescored = await runQc(rejectedScenes);
      const rescoredMap = new Map(rescored.map((q) => [q.index, q]));
      for (let i = 0; i < semanticQc.length; i++) {
        if (rescoredMap.has(semanticQc[i].index)) semanticQc[i] = rescoredMap.get(semanticQc[i].index);
      }
      rejected = semanticQc.filter((q) => !q.ok || q.score < 0.65);

      // Deterministic second fallback: use the short factual Stage-A note that
      // was already validated against these exact frames. This removes dialogue
      // specificity/plot inference that a free-form rewrite may reintroduce.
      if (rejected.length > 0) {
        for (const failure of rejected) {
          const beat = beatByIndex.get(failure.index);
          const literal = String(beat?.reason || "").trim();
          if (!beat || !literal) continue;
          beat.narration = literal;
          narrationByIndex.set(failure.index, literal);
        }
        const literalScenes = rejected.map((q) => sceneByIndex.get(q.index)).filter(Boolean);
        const literalScores = await runQc(literalScenes);
        const literalMap = new Map(literalScores.map((q) => [q.index, q]));
        for (let i = 0; i < semanticQc.length; i++) {
          if (literalMap.has(semanticQc[i].index)) semanticQc[i] = literalMap.get(semanticQc[i].index);
        }
        rejected = semanticQc.filter((q) => !q.ok || q.score < 0.65);
      }
    }
    console.log(
      `[analyzeWithScenes] ${qcProvider.toUpperCase()}-QC: ` +
      `${semanticQc.length - rejected.length}/${semanticQc.length} beats passed semantic visual QC`
    );
    if (rejected.length > 0) {
      const sample = rejected.slice(0, 10).map((q) => `${q.index}:${q.score.toFixed(2)} ${q.reason}`).join(" | ");
      // A few isolated ambiguous shots are safer to omit than to force into the
      // recap. A systemic failure (>5%) still aborts; small residuals are
      // quarantined and never reach TTS/render.
      const quarantineLimit = semanticQuarantineLimit(semanticQc.length);
      if (rejected.length > quarantineLimit) {
        throw new Error(
          `Semantic visual QC rejected ${rejected.length}/${semanticQc.length} beat(s): ${sample}. ` +
          `Systemic mismatch exceeds quarantine limit ${quarantineLimit}; analysis stopped.`
        );
      }
      const rejectedIds = new Set(rejected.map((q) => q.index));
      syncedBeats = syncedBeats.filter((b) => !rejectedIds.has(b.index));
      for (const q of semanticQc) {
        if (rejectedIds.has(q.index)) q.quarantined = true;
      }
      console.warn(
        `[analyzeWithScenes] SEMANTIC-QUARANTINE: omitted ${rejected.length}/${semanticQc.length} ` +
        `isolated mismatched beat(s) [${[...rejectedIds].join(",")}]; ${sample}`
      );
    }
  }

  // Stripped scene list (no base64 frames) for use in render-time sceneId resolution.
  const scenesList = scenes.map(({ index, startSec, endSec }) => ({ index, startSec, endSec }));

  const script = syncedBeats.map((b) => b.narration).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const timestamps = syncedBeats.map((b) => ({ startSec: b.startSec, endSec: b.endSec, reason: b.reason }));
  return { script, timestamps, characters, beats: syncedBeats, storyOutline, scenesList, semanticQc };
}

