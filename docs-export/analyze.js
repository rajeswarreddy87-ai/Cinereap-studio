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
    : `\nNo cast list provided — identify characters ONLY when the transcript, extracted character list, on-screen text, or unmistakable dialogue supports the name. Never use actor real names. If a name or relationship is uncertain, use a neutral role label such as "the trainer", "the manager", "the daughter", "one of the men", or "the officer".`;
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
      `Use character names from the transcript, the cast note above, and your own knowledge of this film — NEVER use actor real names.\n\n` +
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

export function parseAnalysisResponse(rawText) {
  if (typeof rawText !== "string") throw new Error("Empty Claude response");
  let s = rawText.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) s = fence[1].trim();
  let obj;
  try {
    obj = JSON.parse(s);
  } catch (e) {
    // Attempt JSON repair before giving up (handles truncated/large 100+ frame responses)
    try {
      obj = JSON.parse(repairJson(rawText));
    } catch (e2) {
      throw new Error(`Claude response was not valid JSON: ${e.message}`);
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
    : `\nNo cast list provided — identify characters ONLY when the transcript, extracted character list, on-screen text, or unmistakable dialogue supports the name. Never use actor real names. If a name or relationship is uncertain, use a neutral role label such as "the trainer", "the manager", "the daughter", "one of the men", or "the officer".`;
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
        `"amma", "mama", "chacha") cross-reference the cast list to find the character's ` +
        `real name and use that name in the script. ` +
        `Draw character names from the transcript, the cast note above, and your own knowledge of this film. NEVER use actor real names. NEVER use vague labels like "the protagonist" once you know a character's name.\n` +
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
    const text = await callClaude({ apiKey, model, messages });
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
    const scriptText = await callClaude({ apiKey, model, messages: scriptMessages, maxTokens: 8000 });
    script = parseScriptResponse(scriptText);
  } catch (e) {
    // Fallback: a single combined analyze call (old behaviour) if Stage B fails.
    const fallbackFrames = frames.slice(0, BATCH_SIZE);
    const messages = buildAnalyzeMessages({ movie, frames: fallbackFrames, channelName, maxClipSeconds, targetClipCount, transcriptBlock });
    const text = await callClaude({ apiKey, model, messages });
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
    const dialogue = transcriptForWindow(segments, sc.sceneStart ?? sc.startSec, sc.sceneEnd ?? sc.endSec);
    content.push({
      type: "text",
      text: `SCENE ${sc.index} @ [${secToMmSs(sc.startSec)}] (window ${sc.startSec.toFixed(1)}-${sc.endSec.toFixed(1)}s).` +
        (dialogue ? ` Dialogue: "${dialogue}"` : ` Dialogue: (none)`),
    });
  }
  const cast = movie.cast
    ? ` Film characters (use these names in beat notes — NOT actors' real names): ${movie.cast}.`
    : ` No cast list provided — use your knowledge of "${movie.title}"${movie.year ? ` (${movie.year})` : ""} to label characters by their FICTIONAL CHARACTER NAMES in beat notes.`;
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
      `No prose, no script.`,
  });
  return [{ role: "user", content }];
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
export function buildStoryOutlineMessages({ movie, beatNotes, transcriptBlock = "" }) {
  const notesText = Array.isArray(beatNotes) && beatNotes.length
    ? beatNotes.map((n) => `[${n.t}] beat ${n.index}: ${n.note || "(no note)"}`).join("\n")
    : "(no beat notes available)";
  return [{
    role: "user",
    content: [{
      type: "text",
      text:
        `You are preparing a YouTube movie recap for "${movie.title}" (film length ${Math.round(movie.durationSec)}s).\n\n` +
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
export function buildSceneScriptMessages({ movie, channelName, beats, characters, transcriptBlock = "", narrationLang = "English", storyOutline = [], batchInfo = null }) {
  const cast = movie.cast
    ? `\nFilm characters (use these names — NOT the actors' real names): ${movie.cast}.`
    : `\nNo cast list provided — identify characters ONLY when the transcript, extracted character list, on-screen text, or unmistakable dialogue supports the name. Never use actor real names. If a name or relationship is uncertain, use a neutral role label such as "the trainer", "the manager", "the daughter", "one of the men", or "the officer".`;
  const director = movie.director ? `, directed by ${movie.director}` : "";
  const year = movie.year ? ` (${movie.year})` : "";
  const genre = movie.genre ? `${movie.genre} ` : "";
  const charText = characters && characters.length
    ? `CHARACTERS (use these names consistently):\n` + characters.map((c) => `- ${c.name}: ${c.note}`).join("\n") + "\n\n"
    : "";
  // Pass 3 context: story outline from the intermediate outline pass.
  const outlineText = Array.isArray(storyOutline) && storyOutline.length
    ? `STORY OUTLINE (mandatory narrative contract — keep narration consistent with this arc):\n` +
      storyOutline.map((a) => `  ${a.act} [${a.startSec}–${a.endSec}s] ${a.characters?.join(", ") || ""}: ${a.summary} (tone: ${a.tone || "dramatic"})`).join("\n") + "\n\n"
    : "";
  // List the beats WITH their index + timecode so Claude returns narration per beat, in order.
  // No word cap here — narration length is determined by story content;
  // per-beat Speechify TTS generates clips that match actual spoken length.
  const beatText = beats && beats.length
    ? beats.map((b) => {
        return `- index ${b.index} @ [${b.t}] (${b.startSec.toFixed(1)}-${b.endSec.toFixed(1)}s): ${b.note || "(no note)"}`;
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
        outlineText +
        `CHARACTER / RELATIONSHIP ACCURACY CONTRACT (mandatory):
` +
        `- Do NOT infer family relationships unless the transcript or character list explicitly confirms them.
` +
        `- Do NOT invent names for unnamed people. Use neutral labels when uncertain.
` +
        `- Do NOT swap character names between people in the same scene.
` +
        `- If a transcript line is ambiguous, say "one of them" or describe the action without naming.
` +
        `- Relationship words like father, brother, uncle, wife, daughter, manager, trainer must be used only when confirmed.
` +
        `- Prefer accuracy over dramatic wording; a wrong name is worse than a generic label.

` +
        (transcriptBlock
          ? `Ground the recap in this ACTUAL dialogue transcript (real plot, names, key lines). Do NOT invent ` +
            `events it does not support.\n\nTRANSCRIPT:\n${transcriptBlock}\n\n`
          : ``) +
        `Here are the CHRONOLOGICAL on-screen beats (each is a real scene window in the film):\n${beatText}\n\n` +
        `Write ONE single, continuous voiceover recap in ${narrationLang} that tells the COMPLETE story ` +
        `from start to finish as a SINGLE coherent narrative arc (clear beginning, middle, end). ` +
        `This must be a THOROUGH, scene-by-scene retelling — NOT a short summary. Cover the setup, EVERY major plot ` +
        `turn, character motivations, key twists, climax, and the full ending. Paraphrase important dialogue and ` +
        `moments in detail. Write as many words as the story requires — do NOT rush, truncate, or skip scenes to ` +
        `hit a time target. A complete recap of a 2-hour film naturally needs 3000-5000+ spoken words; use however ` +
        `many words it takes to tell the whole story properly. ` +
        `TRANSCRIPT GROUNDING (mandatory): every sentence must be grounded in the actual dialogue transcript. ` +
        `If the transcript shows character X saying Y at timestamp T, the beat covering T must reference ` +
        `that dialogue. Never invent events the transcript does not support. Never skip or gloss over ` +
        `murders, deaths, betrayals, or confrontations — describe exactly HOW and WHY each one happens. ` +
        `Split the narration STRICTLY across the beats using this rule:\n` +
        `beat[i].narration MUST describe what is happening at beat[i]'s timestamp [startSec-endSec]. ` +
        `Use the TRANSCRIPT DIALOGUE at that timestamp to identify the exact characters, actions, ` +
        `and events on screen — this is mandatory.\n` +
        `CONTENT SYNC RULES (violating these breaks the video):\n` +
        `  1. The viewer SEES beat[i]'s footage WHILE HEARING beat[i]'s narration — they MUST match.\n` +
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
        `  D. BEAT DURATION TARGET: each beat narration should take 8–12 seconds to speak aloud ` +
        `     (approximately 2–3 sentences, 20–40 words). Target 10 seconds. Major climax or revelation ` +
        `     beats may extend to 15 seconds. Do NOT write 1-sentence micro-beats.\n` +
        `  E. YOUTUBE NARRATION STYLE: punchy, direct, present-tense active voice. Specific nouns and ` +
        `     actions. No film-theory commentary, no meta-references to "the film" or "the scene". ` +
        `     Speak as if narrating the events AS they happen on screen.\n\n` +
        `ALSO choose a music mood for each beat from EXACTLY this set: ${MOODS}.\n\n` +
        `ALSO assign an importance score 1–10 to each beat:\n` +
        `  1–3 = transitional/establishing shot, 4–6 = regular story beat,\n` +
        `  7–8 = significant moment (confrontation, discovery), 9–10 = climax or major reveal.\n` +
        `ALSO assign sceneIds: an array of scene indices this narration covers.\n` +
        `  Normally a single scene: [index]. Use multiple CONSECUTIVE indices only when one\n` +
        `  story beat naturally spans 2–3 adjacent scenes (e.g. a continuous action [12,13,14]).\n` +
        `  Never skip indices or go out of order.\n\n` +
        `ALSO assign confidence (0.0–1.0): how confident you are that the narration accurately\n` +
        `  matches the visible footage at this beat's timestamp.\n` +
        `  0.9–1.0 = strong match (you can clearly identify the action from transcript + frames).\n` +
        `  0.7–0.89 = reasonable match (some ambiguity but story is consistent).\n` +
        `  Below 0.7 = uncertain (scene is ambiguous, transition, or hard to read).\n\n` +
        `ALSO extract visualMoments: the 1–4 most cinematically important sub-clips within this beat.\n` +
        `  Each has: start (seconds, float), end (seconds, float), type (one of: reveal, action,\n` +
        `  emotion, danger, reaction, dialogue). Use the beat's timestamp range — do not go outside it.\n` +
        `  Priority order for type: reveal > action > emotion > danger > reaction > dialogue.\n` +
        `  Omit visualMoments entirely if you cannot identify meaningful sub-clips within the beat.\n\n` +
        `ALSO assign beatType from EXACTLY this set: setup | mystery | danger | investigation | action | reveal | emotion | climax | resolution\n` +
        `  Choose the single type that best describes the dominant mood/action of this beat's on-screen content.\n` +
        `  action = fights/chases/escapes, danger = threat/tension/confrontation, climax = peak moment of the story,\n` +
        `  investigation = detective/analysis/discovery-in-progress, mystery = unresolved/unknown/atmosphere,\n` +
        `  reveal = twist/revelation/information disclosed, emotion = grief/joy/love/loss visible on screen,\n` +
        `  resolution = aftermath/conclusion/normalcy restored, setup = introduction/establishing/travel.\n\n` +
        `Respond with valid JSON ONLY of the form:\n` +
        `{ "beats": [ { "index": 0, "narration": "...", "mood": "tense", "importance": 7, "beatType": "action", "sceneIds": [0], "confidence": 0.91, "visualMoments": [{"start": 134.2, "end": 137.1, "type": "action"}] } ] }\n` +
        `Include EVERY beat index shown above, in the same order. No prose, no other keys.`,
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
  const VALID_VM_TYPES = new Set(["reveal", "action", "emotion", "danger", "reaction", "dialogue"]);
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
      // Visual moments: precise sub-clip windows ranked by cinematic importance.
      visualMoments: Array.isArray(b.visualMoments) && b.visualMoments.length > 0
        ? b.visualMoments
            .filter((vm) =>
              Number.isFinite(Number(vm?.start)) &&
              Number.isFinite(Number(vm?.end)) &&
              Number(vm.end) > Number(vm.start) &&
              VALID_VM_TYPES.has(String(vm?.type || "").toLowerCase())
            )
            .map((vm) => ({
              start: Math.round(Number(vm.start) * 1000) / 1000,
              end:   Math.round(Number(vm.end)   * 1000) / 1000,
              type:  String(vm.type).toLowerCase(),
            }))
            // Sort by priority: reveal > action > emotion > danger > reaction > dialogue
            .sort((a, b) => {
              const PRI = { reveal: 0, action: 1, emotion: 2, danger: 3, reaction: 4, dialogue: 5 };
              return (PRI[a.type] ?? 9) - (PRI[b.type] ?? 9);
            }) || null
        : null,
    }));
  if (beats.length === 0) throw new Error("Claude scene-script response had no beats");
  return beats;
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
  apiKey, model, movie, channelName, scenes, segments = [], transcriptBlock = "", narrationLang = "English",
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
  const noteByIndex = new Map();
  let characters = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const messages = buildSceneNotesMessages({ movie, scenes: batches[bi], segments, isFirstBatch: bi === 0 });
    const text = await callClaude({ apiKey, model, messages });
    const parsed = parseSceneNotesResponse(text);
    if (bi === 0 && parsed.characters.length) characters = parsed.characters;
    for (const b of parsed.beats) noteByIndex.set(b.index, b.note);
  }

  // Build ordered beat list — trust Claude's scene notes exclusively.
  // Claude is instructed to label studio logos, title cards, and production
  // company screens as "SKIP". We honour that judgement and drop only those
  // beats. No hard time thresholds — story content varies by film and region.
  const CREDITS_LABEL_RE = /\b(studio|logo|production\s*company|distributor|credit|title\s*card|opening\s*credit)\b/i;
  const beats = scenes
    .map((sc) => ({ index: sc.index, t: secToMmSs(sc.startSec), note: noteByIndex.get(sc.index) || "", startSec: sc.startSec, endSec: sc.endSec }))
    .filter((b) => {
      const note = b.note.trim();
      if (!note) return false;                                     // Claude wrote nothing — skip
      if (note.toUpperCase().startsWith("SKIP")) return false;     // Claude flagged it
      if (CREDITS_LABEL_RE.test(note)) return false;               // Claude described credits
      return true;                                                  // real story content — keep
    })
    .sort((a, b) => a.startSec - b.startSec);

  // ── PASS 2 (Story Outline): narrative contract ──────────────────────────
  // Synthesise a shared story arc from beat notes + transcript. Stage B uses
  // this to keep narration coherent across all beats/batches. Fails gracefully.
  let storyOutline = [];
  try {
    const outlineMessages = buildStoryOutlineMessages({ movie, beatNotes: beats, transcriptBlock });
    const outlineText = await callClaude({ apiKey, model, messages: outlineMessages, maxTokens: 2000 });
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
  for (let bi = 0; bi < scriptBatches.length; bi++) {
    const batchInfo = { start: bi * SCRIPT_BATCH, total: beats.length, prevEnding: prevNarrationEnd };
    const scriptMessages = buildSceneScriptMessages({
      movie, channelName, beats: scriptBatches[bi], characters, transcriptBlock, narrationLang, storyOutline, batchInfo,
    });
    // 14000 tokens: 60 beats × ~200 tokens/beat = 12,000 + JSON wrapper headroom.
    const scriptText = await callClaude({ apiKey, model, messages: scriptMessages, maxTokens: 14000 });
    const parsed = parseSceneScriptResponse(scriptText);
    if (parsed.length > 0) prevNarrationEnd = parsed[parsed.length - 1].narration.slice(-300);
    beatScript = beatScript.concat(parsed);
  }

  const narrByIndex = new Map(beatScript.map((b) => [b.index, b]));
  const syncedBeats = beats.map((b) => {
    const n = narrByIndex.get(b.index);
    return {
      index: b.index,
      startSec: b.startSec,
      endSec: b.endSec,
      narration: n?.narration || b.note || "",
      mood: n?.mood || "dramatic",
      // ChatGPT pipeline: importance (1-10) drives dynamic cut timing at render.
      importance: n?.importance ?? null,
      // ChatGPT pipeline: sceneIds = detected scene indices this beat covers.
      // Defaults to [b.index] (single scene) when Claude doesn't provide them.
      sceneIds: Array.isArray(n?.sceneIds) && n.sceneIds.length > 0 ? n.sceneIds : [b.index],
      // ChatGPT pipeline: confidence (0.0-1.0) — how well narration matches footage.
      // Values below 0.7 trigger window expansion at render time (FIX B).
      confidence: n?.confidence ?? null,
      // ChatGPT pipeline: visualMoments — precise sub-clip windows ranked by type.
      // Used at render to prefer cinematically important moments over full scene range.
      visualMoments: Array.isArray(n?.visualMoments) && n.visualMoments.length > 0 ? n.visualMoments : null,
      reason: b.note || "",
    };
  });

  // Stripped scene list (no base64 frames) for use in render-time sceneId resolution.
  const scenesList = scenes.map(({ index, startSec, endSec }) => ({ index, startSec, endSec }));

  const script = syncedBeats.map((b) => b.narration).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const timestamps = syncedBeats.map((b) => ({ startSec: b.startSec, endSec: b.endSec, reason: b.reason }));
  return { script, timestamps, characters, beats: syncedBeats, storyOutline, scenesList };
}

