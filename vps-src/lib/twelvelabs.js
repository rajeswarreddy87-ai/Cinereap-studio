/**
 * Twelve Labs Marengo integration — index movie once, search per beat.
 * Uses the official twelvelabs-js SDK for upload/index/search (multipart handled by SDK).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { TwelveLabs } from "twelvelabs-js";

const MULTIPART_UPLOAD_MAX = 4 * 1024 * 1024 * 1024; // 4 GB
const POLL_INTERVAL_MS = 5000;
const ASSET_POLL_MAX_MS = 30 * 60 * 1000; // 30 min post-upload asset processing
const INDEX_IN_PROGRESS = new Set(["pending", "queued", "indexing"]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createClient(apiKey) {
  return new TwelveLabs({ apiKey });
}

/** Marengo indexing for a ~2h film can take 2–3h; default 3h, overridable via env. */
function indexPollMaxMs(fileSizeBytes = 0) {
  const env = Number(process.env.TWELVELABS_INDEX_POLL_MAX_MS);
  if (Number.isFinite(env) && env > 0) return env;
  const base = 180 * 60 * 1000; // 3 hours
  if (fileSizeBytes > 1.5e9) return Math.max(base, 210 * 60 * 1000); // 3.5h for 1.5GB+
  return base;
}

async function fileFingerprint(filePath) {
  const st = await fs.stat(filePath);
  return `${st.size}:${Math.floor(st.mtimeMs)}`;
}

async function loadCache(cacheDir, fileId) {
  try {
    const raw = await fs.readFile(path.join(cacheDir, `${fileId}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCache(cacheDir, fileId, data) {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, `${fileId}.json`), JSON.stringify(data, null, 2), "utf8");
}

async function loadGlobalIndex(cacheDir) {
  try {
    const raw = await fs.readFile(path.join(cacheDir, "_global.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveGlobalIndex(cacheDir, data) {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, "_global.json"), JSON.stringify(data, null, 2), "utf8");
}

async function ensureSharedIndex(client, apiKey, cacheDir, log) {
  const envIndex = (process.env.TWELVELABS_INDEX_ID || "").trim();
  if (envIndex) return envIndex;

  const global = await loadGlobalIndex(cacheDir);
  if (global?.indexId) return global.indexId;

  log?.("Twelve Labs: creating shared Marengo index…");
  const created = await client.indexes.create({
    indexName: `cinerecap-${createHash("sha256").update(apiKey.slice(0, 8)).digest("hex").slice(0, 8)}`,
    models: [{ modelName: "marengo3.0", modelOptions: ["visual", "audio"] }],
  });
  const indexId = created?.id;
  if (!indexId) throw new Error("TwelveLabs index create returned no id");
  await saveGlobalIndex(cacheDir, { indexId, createdAt: Date.now() });
  log?.(`Twelve Labs: shared index ready (${indexId})`);
  return indexId;
}

async function waitForAssetReady(client, assetId, log, maxMs = ASSET_POLL_MAX_MS) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const asset = await client.assets.retrieve(assetId);
    if (asset?.status === "ready") return asset;
    if (asset?.status === "failed") throw new Error(`TwelveLabs asset ${assetId} failed`);
    log?.(`Twelve Labs: asset processing (${asset?.status || "pending"})…`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`TwelveLabs asset ${assetId} timed out`);
}

async function uploadAsset(client, filePath, log) {
  const st = await fs.stat(filePath);
  const filename = path.basename(filePath);
  if (st.size > MULTIPART_UPLOAD_MAX) {
    throw new Error(`File ${(st.size / 1e9).toFixed(2)} GB exceeds TwelveLabs 4GB limit`);
  }

  const maxWorkers = Math.max(1, Number(process.env.TWELVELABS_UPLOAD_WORKERS) || 4);
  const batchSize = Math.max(1, Number(process.env.TWELVELABS_UPLOAD_BATCH) || 10);
  let lastLogPct = -1;

  log?.(`Twelve Labs: SDK multipart upload (${(st.size / 1e9).toFixed(2)} GB)…`);
  const result = await client.multipartUpload.uploadFile(filePath, {
    filename,
    fileType: "video",
    maxWorkers,
    batchSize,
    maxRetries: 3,
    retryDelay: 1.0,
    progressCallback: (progress) => {
      const pct = Math.floor(progress.percentage);
      if (pct >= lastLogPct + 10 || pct === 100) {
        lastLogPct = pct;
        log?.(`Twelve Labs: upload ${pct}% (${progress.completedChunks}/${progress.totalChunks} chunks)`);
      }
    },
  });

  const assetId = result?.assetId;
  if (!assetId) throw new Error("TwelveLabs upload returned no assetId");
  return assetId;
}

async function waitForIndexedAsset(client, indexId, indexedAssetId, log, maxMs) {
  const pollMax = maxMs || indexPollMaxMs();
  const start = Date.now();
  let polls = 0;
  while (Date.now() - start < pollMax) {
    const ia = await client.indexes.indexedAssets.retrieve(indexId, indexedAssetId);
    if (ia?.status === "ready") return ia;
    if (ia?.status === "failed") throw new Error(`TwelveLabs indexing failed for ${indexedAssetId}`);
    polls++;
    if (polls === 1 || polls % 12 === 0) {
      const elapsedMin = Math.round((Date.now() - start) / 60000);
      log?.(`Twelve Labs: indexing (${ia?.status || "processing"})… ${elapsedMin}m elapsed`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`TwelveLabs indexing timed out for ${indexedAssetId} after ${Math.round(pollMax / 60000)}m`);
}

async function resolveVideoId(client, indexId, assetId, log) {
  const pager = await client.indexes.videos.list(indexId, { pageLimit: 50, sortOption: "desc" });
  for await (const video of pager) {
    if (video?.assetId === assetId && video?.id) return video.id;
  }
  while (pager.hasNextPage()) {
    await pager.getNextPage();
    for (const video of pager.data || []) {
      if (video?.assetId === assetId && video?.id) return video.id;
    }
  }
  log?.(`Twelve Labs: videoId not found via list — using indexed asset id for filter`);
  return null;
}

async function findIndexedAssetsForAssetInIndex(client, indexId, assetId) {
  const results = [];
  const pager = await client.indexes.indexedAssets.list(indexId, { pageLimit: 50, sortOption: "desc" });
  const match = (ia) => (ia?.assetId === assetId && ia?.id ? ia : null);
  for await (const ia of pager) {
    const hit = match(ia);
    if (hit) results.push(hit);
  }
  while (pager.hasNextPage()) {
    await pager.getNextPage();
    for (const ia of pager.data || []) {
      const hit = match(ia);
      if (hit) results.push(hit);
    }
  }
  return results;
}

async function findIndexedAssetsForFile(client, indexId, { filename, size, assetId }) {
  const results = [];
  const pager = await client.indexes.indexedAssets.list(indexId, { pageLimit: 50, sortOption: "desc" });
  const match = (ia) => {
    if (!ia?.id) return null;
    if (assetId && ia.assetId === assetId) return ia;
    const meta = ia.systemMetadata || {};
    if (meta.filename !== filename) return null;
    if (size && meta.size && meta.size !== size) return null;
    return ia;
  };
  for await (const ia of pager) {
    const hit = match(ia);
    if (hit) results.push(hit);
  }
  while (pager.hasNextPage()) {
    await pager.getNextPage();
    for (const ia of pager.data || []) {
      const hit = match(ia);
      if (hit) results.push(hit);
    }
  }
  return results;
}

function pickIndexingTarget(entries) {
  if (!entries.length) return null;

  const ready = entries.filter((e) => e.status === "ready");
  if (ready.length) {
    ready.sort((a, b) => String(b.indexedAt || b.updatedAt || "").localeCompare(String(a.indexedAt || a.updatedAt || "")));
    return { mode: "ready", indexedAsset: ready[0] };
  }

  const inProgress = entries.filter((e) => INDEX_IN_PROGRESS.has(e.status));
  if (inProgress.length) {
    inProgress.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return { mode: "wait", indexedAsset: inProgress[0] };
  }

  const failed = entries.filter((e) => e.status === "failed");
  if (failed.length) {
    failed.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return { mode: "failed", indexedAsset: failed[0] };
  }

  return null;
}

async function ensureIndexingForAsset({
  client, indexId, assetId, fileId, fingerprint, cacheDir, log, pollMax,
}) {
  const existing = await findIndexedAssetsForAssetInIndex(client, indexId, assetId);
  const target = pickIndexingTarget(existing);

  if (target?.mode === "ready") {
    log?.(`Twelve Labs: reusing ready index for asset ${assetId} (${target.indexedAsset.id})`);
    return target.indexedAsset.id;
  }

  if (target?.mode === "wait") {
    log?.(`Twelve Labs: waiting on in-progress index for asset ${assetId} (${target.indexedAsset.id}, ${target.indexedAsset.status}) — not starting duplicate`);
    await saveCache(cacheDir, fileId, {
      fileId, fingerprint, indexId, assetId,
      indexedAssetId: target.indexedAsset.id,
      status: "indexing",
      startedAt: Date.now(),
    });
    await waitForIndexedAsset(client, indexId, target.indexedAsset.id, log, pollMax);
    return target.indexedAsset.id;
  }

  if (target?.mode === "failed") {
    log?.(`Twelve Labs: prior index for asset ${assetId} failed (${target.indexedAsset.id}) — checking before retry`);
  } else {
    log?.("Twelve Labs: starting Marengo indexing…");
  }

  // Final guard — another render may have started or finished indexing since we last looked.
  const fresh = pickIndexingTarget(await findIndexedAssetsForAssetInIndex(client, indexId, assetId));
  if (fresh?.mode === "ready") {
    log?.(`Twelve Labs: index became ready (${fresh.indexedAsset.id}) — skipping duplicate create`);
    return fresh.indexedAsset.id;
  }
  if (fresh?.mode === "wait") {
    log?.(`Twelve Labs: index already in progress (${fresh.indexedAsset.id}) — waiting instead of duplicating`);
    await saveCache(cacheDir, fileId, {
      fileId, fingerprint, indexId, assetId,
      indexedAssetId: fresh.indexedAsset.id,
      status: "indexing",
      startedAt: Date.now(),
    });
    await waitForIndexedAsset(client, indexId, fresh.indexedAsset.id, log, pollMax);
    return fresh.indexedAsset.id;
  }

  const indexed = await client.indexes.indexedAssets.create(indexId, { assetId });
  const indexedAssetId = indexed?.id;
  if (!indexedAssetId) throw new Error("TwelveLabs indexed-asset create returned no id");

  await saveCache(cacheDir, fileId, {
    fileId, fingerprint, indexId, assetId, indexedAssetId, status: "indexing", startedAt: Date.now(),
  });

  await waitForIndexedAsset(client, indexId, indexedAssetId, log, pollMax);
  return indexedAssetId;
}

async function finalizeIndexEntry({ client, indexId, fileId, fingerprint, assetId, indexedAssetId, log }) {
  const videoId = (await resolveVideoId(client, indexId, assetId, log)) || indexedAssetId;
  const entry = {
    fileId,
    fingerprint,
    indexId,
    assetId,
    indexedAssetId,
    videoId,
    indexedAt: Date.now(),
  };
  return entry;
}

/**
 * Ensure the movie is uploaded and indexed. Returns cache entry or null on failure.
 */
export async function ensureMovieIndexed({ apiKey, cacheDir, sourcePath, fileId, log }) {
  if (!apiKey) return null;
  const fingerprint = await fileFingerprint(sourcePath);
  const st = await fs.stat(sourcePath);
  const filename = path.basename(sourcePath);
  const pollMax = indexPollMaxMs(st.size);

  const cached = await loadCache(cacheDir, fileId);
  if (cached?.fingerprint === fingerprint && cached?.indexId && cached?.videoId) {
    log?.(`Twelve Labs: cache hit for ${fileId} (video ${cached.videoId})`);
    return cached;
  }

  const client = createClient(apiKey);
  const indexId = cached?.indexId || await ensureSharedIndex(client, apiKey, cacheDir, log);

  // Check platform for any index state for this file (ready or in-progress).
  const platformEntries = await findIndexedAssetsForFile(client, indexId, {
    filename,
    size: st.size,
    assetId: cached?.assetId,
  });
  const platformTarget = pickIndexingTarget(platformEntries);
  if (platformTarget?.mode === "ready") {
    log?.(`Twelve Labs: found existing ready index for ${filename} (${platformTarget.indexedAsset.id})`);
    const entry = await finalizeIndexEntry({
      client, indexId, fileId, fingerprint,
      assetId: platformTarget.indexedAsset.assetId,
      indexedAssetId: platformTarget.indexedAsset.id,
      log,
    });
    await saveCache(cacheDir, fileId, entry);
    return entry;
  }
  if (platformTarget?.mode === "wait") {
    log?.(`Twelve Labs: found in-progress index for ${filename} (${platformTarget.indexedAsset.id}) — waiting, not duplicating`);
    await saveCache(cacheDir, fileId, {
      fileId, fingerprint, indexId,
      assetId: platformTarget.indexedAsset.assetId,
      indexedAssetId: platformTarget.indexedAsset.id,
      status: "indexing",
      startedAt: Date.now(),
    });
    await waitForIndexedAsset(client, indexId, platformTarget.indexedAsset.id, log, pollMax);
    const entry = await finalizeIndexEntry({
      client, indexId, fileId, fingerprint,
      assetId: platformTarget.indexedAsset.assetId,
      indexedAssetId: platformTarget.indexedAsset.id,
      log,
    });
    await saveCache(cacheDir, fileId, entry);
    log?.(`Twelve Labs: in-progress index ready → video ${entry.videoId}`);
    return entry;
  }

  // Resume in-progress indexing from partial cache (avoids re-upload).
  if (cached?.fingerprint === fingerprint && cached?.indexedAssetId && cached?.assetId) {
    log?.(`Twelve Labs: resuming indexing for ${fileId} (indexed-asset ${cached.indexedAssetId})…`);
    try {
      const ready = await waitForIndexedAsset(client, indexId, cached.indexedAssetId, log, pollMax);
      if (ready?.status === "ready") {
        const entry = await finalizeIndexEntry({
          client, indexId, fileId, fingerprint,
          assetId: cached.assetId,
          indexedAssetId: cached.indexedAssetId,
          log,
        });
        await saveCache(cacheDir, fileId, entry);
        log?.(`Twelve Labs: resumed index ready → video ${entry.videoId}`);
        return entry;
      }
    } catch (e) {
      log?.(`Twelve Labs: resume failed (${e?.message || e}) — checking platform index…`);
    }
  }

  // Reuse uploaded asset if a prior attempt left one on the platform (incl. failed index jobs).
  const knownAssetId = platformEntries.find((e) => e.assetId)?.assetId
    || cached?.assetId;
  if (knownAssetId) {
    try {
      const asset = await client.assets.retrieve(knownAssetId);
      if (asset?.status === "ready") {
        log?.(`Twelve Labs: reusing uploaded asset ${knownAssetId} (skip re-upload)`);
        const indexedAssetId = await ensureIndexingForAsset({
          client, indexId, assetId: knownAssetId, fileId, fingerprint, cacheDir, log, pollMax,
        });
        const entry = await finalizeIndexEntry({
          client, indexId, fileId, fingerprint, assetId: knownAssetId, indexedAssetId, log,
        });
        await saveCache(cacheDir, fileId, entry);
        log?.(`Twelve Labs: indexed ${fileId} → video ${entry.videoId}`);
        return entry;
      }
    } catch (e) {
      log?.(`Twelve Labs: could not reuse asset ${knownAssetId} (${e?.message || e}) — uploading fresh`);
    }
  }

  log?.(`Twelve Labs: uploading ${filename}…`);
  const assetId = await uploadAsset(client, sourcePath, log);
  await waitForAssetReady(client, assetId, log);

  const indexedAssetId = await ensureIndexingForAsset({
    client, indexId, assetId, fileId, fingerprint, cacheDir, log, pollMax,
  });
  const entry = await finalizeIndexEntry({
    client, indexId, fileId, fingerprint, assetId, indexedAssetId, log,
  });
  await saveCache(cacheDir, fileId, entry);
  log?.(`Twelve Labs: indexed ${fileId} → video ${entry.videoId}`);
  return entry;
}

/**
 * Convert raw Claude narration into one or more visual-only search queries via
 * Claude Haiku. Returns { events: string[] } — always at least 1 entry.
 *
 * The implementation guide's golden rule: NEVER search narration paragraphs
 * directly against Twelve Labs — narration contains thoughts, emotions, and
 * explanations that Twelve Labs cannot match visually. This function extracts
 * only what is physically visible on screen (characters + actions + location +
 * objects + environment) as a concrete visual description.
 *
 * Multi-event split (added after live evidence, 2026-07-10): a beat's
 * narration sometimes spans multiple genuinely distinct visual scenes chained
 * together (e.g. "family watches TV" + "Billy wins the title fight" +
 * "victory montage") — no single continuous clip can depict all of them, so
 * asking Twelve Labs/vision for ONE match for the merged description reliably
 * fails (confirmed: beat 0 of the 2FBlaPLeH1 render, vision rejected the only
 * candidate because it "lacks required footage of group home setting and
 * victory statistics montage"). When Haiku identifies 2-3 distinct events, in
 * narration/chronological order, each is returned separately so the caller
 * can search/vision-verify them independently and stitch the results. The
 * single-event case (the majority — 39/41 beats in that same render) returns
 * exactly 1 entry and callers must treat it identically to the old
 * single-string behavior.
 *
 * Falls back to a single-entry array with the raw narration (truncated) if
 * the API call fails or the response can't be parsed, so the pipeline never
 * blocks on a VSO build error and never regresses single-event beats.
 */
export async function buildVisualQuery(narration, anthropicApiKey, log, beatContext = {}) {
  const text = String(narration || "").trim();
  if (!text) return { events: [] };
  const fallback = { events: [text.slice(0, 800)], dialogueCues: [], location: null, characters: [], primaryAction: null, objects: [] };
  if (!anthropicApiKey) {
    log?.("[VSO] No Anthropic key — using raw narration as fallback query");
    return fallback;
  }
  // Three-beat context: adjacent beat narrations anchor the VSO to this specific
  // moment in the narrative arc, reducing false matches on visually similar scenes.
  const prevCtxLine = beatContext.prevNarration
    ? `\nPrevious beat (context only — for disambiguation): "${String(beatContext.prevNarration).slice(0, 200)}"`
    : "";
  const nextCtxLine = beatContext.nextNarration
    ? `\nNext beat (context only — for disambiguation): "${String(beatContext.nextNarration).slice(0, 200)}"`
    : "";
  const threeCtxBlock = (prevCtxLine || nextCtxLine)
    ? `\n${prevCtxLine}${nextCtxLine}\nUse the above context ONLY to disambiguate — the EVENTS must describe THIS beat's footage, not the adjacent beats.`
    : "";
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 800,
        messages: [
          {
            role: "user",
            content: `You are converting a movie recap narration beat into retrieval-ready data for a video recap pipeline.

Narration: "${text.slice(0, 700)}"${threeCtxBlock}

1. EVENTS: 1-3 visual search descriptions of only what is physically visible — never thoughts, emotions, or assumptions. Split only when narration genuinely chains separate scenes that could not appear in one continuous shot. Each event: character names + visible actions, location/setting, important objects, visual environment (lighting, indoors/outdoors, time of day). Be specific and concrete.

2. DIALOGUE_CUES: 0-3 short verbatim spoken phrases (3-8 words) likely in the film's actual audio at this moment. Leave empty for purely visual beats.

3. LOCATION: One short phrase for the primary setting (e.g. "warehouse interior", "government office corridor", "rural barn exterior").

4. CHARACTERS: Array of character names or descriptions visible in this beat (e.g. ["Adam Clay", "masked operative"]). Empty if unclear.

5. PRIMARY_ACTION: One short verb phrase for the dominant action (e.g. "tactical breach", "boardroom confrontation", "vehicle chase", "quiet conversation").

6. OBJECTS: Array of 0-3 important visible props or objects (e.g. ["firearm", "briefcase", "surveillance monitors"]).

Return ONLY strict JSON, no markdown fences: {"events":["..."],"dialogueCues":["..."],"location":"...","characters":["..."],"primaryAction":"...","objects":["..."]}`,
          },
        ],
      }),
    });
    if (!resp.ok) {
      log?.(`[VSO] Claude Haiku error ${resp.status} — using raw narration`);
      return fallback;
    }
    const data = await resp.json();
    const raw = data?.content?.[0]?.text?.trim() || "";
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    let parsed;
    try { parsed = JSON.parse(jsonStr); } catch { parsed = null; }
    const events = Array.isArray(parsed?.events)
      ? parsed.events.map((e) => String(e || "").trim()).filter(Boolean).slice(0, 3)
      : [];
    const dialogueCues = Array.isArray(parsed?.dialogueCues)
      ? parsed.dialogueCues.map((c) => String(c || "").trim()).filter((c) => c.length >= 3).slice(0, 3)
      : [];
    const location      = typeof parsed?.location === "string" ? parsed.location.trim().slice(0, 100) || null : null;
    const characters    = Array.isArray(parsed?.characters) ? parsed.characters.map((c) => String(c).trim()).filter(Boolean).slice(0, 5) : [];
    const primaryAction = typeof parsed?.primaryAction === "string" ? parsed.primaryAction.trim().slice(0, 100) || null : null;
    const objects       = Array.isArray(parsed?.objects) ? parsed.objects.map((o) => String(o).trim()).filter(Boolean).slice(0, 5) : [];
    if (!events.length) {
      log?.(`[VSO] unparseable/empty events response — using raw narration: ${raw.slice(0, 150)}`);
      return fallback;
    }
    return { events, dialogueCues, location, characters, primaryAction, objects };
  } catch (e) {
    log?.(`[VSO] buildVisualQuery failed: ${e?.message || e} — using raw narration`);
    return fallback;
  }
}

/**
 * Progressive query simplification for beats that fail all primary retrieval tiers.
 * Returns an array of [level, queryString] pairs (levels 2, 3, 4) for Tier B retries.
 * Level 2: action + characters only (strips location/objects)
 * Level 3: location + action only (strips characters)
 * Level 4: single most distinctive element chosen by Claude Haiku
 */
async function simplifyVisualQuery(vso, events, anthropicApiKey, log) {
  const results = [];
  const action = (vso.primaryAction || "").trim();
  const chars  = (vso.characters || []).slice(0, 2).join(" and ").trim();
  const loc    = (vso.location || "").trim();
  const firstEvent = (events[0] || "").trim();

  // Level 2: action + characters (drop location and objects)
  const l2 = [chars, action].filter(Boolean).join(" ").trim();
  if (l2) results.push([2, l2.slice(0, 200)]);
  else if (firstEvent) results.push([2, firstEvent.split(" ").slice(0, 8).join(" ")]);

  // Level 3: location + action (drop characters)
  const l3 = action && loc ? `${action} in ${loc}`.trim()
           : action ? action
           : loc ? loc
           : null;
  if (l3 && l3 !== l2) results.push([3, l3.slice(0, 200)]);

  // Level 4: Claude Haiku picks the single most visually distinctive element
  if (anthropicApiKey) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": anthropicApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 60,
          messages: [{
            role: "user",
            content: `Pick the single most visually distinctive and searchable element from this movie scene — 3-7 words only. Prefer specific settings, unusual objects, or distinctive physical actions over generic descriptions.\n\nScene: "${firstEvent.slice(0, 300)}"\nLocation: ${loc || "unknown"}\nAction: ${action || "unknown"}\n\nReturn only the search phrase, no explanation.`,
          }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const phrase = (data?.content?.[0]?.text?.trim() || "").replace(/^["']|["']$/g, "").trim();
        if (phrase && phrase.length > 3 && phrase !== l2 && phrase !== l3) results.push([4, phrase.slice(0, 100)]);
      }
    } catch (e) {
      log?.(`[simplifyVisualQuery] level-4 error: ${e?.message}`);
    }
  }

  return results;
}

/**
 * Audio-mode Marengo search — identical logic to searchBeatMoment but queries
 * the audio track. Used as Tier 2 for beats where visual search failed.
 * Dialogue cues (short verbatim spoken phrases) are the ideal query type here:
 * the audio model locates the exact second those words were spoken, which
 * visual search cannot do for dialogue-heavy scenes.
 */
async function searchBeatMomentAudio({ apiKey, indexId, videoId, query, spanStart, spanEnd }) {
  const q = String(query || "").trim().slice(0, 1800);
  if (!q) return null;
  const PAGE_LIMIT = 50;
  const client = createClient(apiKey);
  const pager = await client.search.query({
    indexId,
    queryText: q,
    searchOptions: ["audio"],
    operator: "or",
    pageLimit: PAGE_LIMIT,
    groupBy: "clip",
    ...(videoId ? { filter: JSON.stringify({ id: [videoId] }) } : {}),
  });

  const hits = [];
  for await (const hit of pager) {
    hits.push(hit);
    if (hits.length >= PAGE_LIMIT) break;
  }
  if (!hits.length) return { noHits: true, candidates: [] };

  const spanLo = Number(spanStart) || 0;
  const spanHi = Number(spanEnd) || Number.POSITIVE_INFINITY;

  const candidates = [];
  for (const hit of hits) {
    const start = Number(hit.start);
    const end   = Number(hit.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const center = (start + end) / 2;
    if (center < spanLo - 2 || center > spanHi + 2) continue;
    const score = Number(hit.score ?? hit.confidence ?? (1 - (Number(hit.rank || 1) - 1) * 0.12));
    candidates.push({ startSec: start, endSec: end, center, score: Math.max(0, Math.min(1, score)), rank: Number(hit.rank) || 99 });
  }
  if (!candidates.length) return { noHits: false, outOfSpan: true, candidates: [] };

  candidates.sort((a, b) => b.score - a.score);
  return { noHits: false, outOfSpan: false, candidates };
}

/**
 * Tier 3 fallback: pure keyword-overlap search against Whisper transcript segments.
 * No API calls — uses only the already-available transcript segments from analyze.
 * Builds a sliding ~15-second window and scores each position by what fraction of
 * the narration's meaningful words appear in the window's spoken text.
 * Returns the best-scoring window if it meets the 15% minimum overlap threshold,
 * otherwise null.
 */
const _TX_STOP = new Set(["about","after","again","also","another","before","being","between","both","could","doing","even","from","have","here","into","just","like","made","make","more","most","much","only","other","over","same","should","some","such","than","that","them","then","there","these","they","this","those","through","time","under","very","want","well","were","what","when","where","which","while","will","with","would","your","says","said","tell","told","gets","going","away","back","down","find","know","need","come","comes","came","take","took","look","show","shows"]);

function transcriptKeywordMatch(narration, segments, centerSec, expandSec = 300) {
  if (!Array.isArray(segments) || !segments.length) return null;
  const spanLo = Math.max(0, centerSec - expandSec);
  const spanHi = centerSec + expandSec;

  const words = String(narration || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !_TX_STOP.has(w));

  if (!words.length) return null;

  let bestScore = 0;
  let bestResult = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segCenter = (Number(seg.start) + Number(seg.end)) / 2;
    if (!Number.isFinite(segCenter) || segCenter < spanLo || segCenter > spanHi) continue;

    // Collect all segments whose center falls within ±12s of this segment's center
    const windowSegs = segments.filter((s) => {
      const c = (Number(s.start) + Number(s.end)) / 2;
      return Number.isFinite(c) && Math.abs(c - segCenter) <= 12;
    });
    const windowText  = windowSegs.map((s) => String(s.text || "").toLowerCase()).join(" ");
    const windowStart = Math.min(...windowSegs.map((s) => Number(s.start)));
    const windowEnd   = Math.max(...windowSegs.map((s) => Number(s.end)));

    const matchedWords = words.filter((w) => windowText.includes(w));
    const score = matchedWords.length / words.length;

    if (score > bestScore && score >= 0.15) {
      bestScore = score;
      bestResult = {
        startSec: windowStart,
        endSec: windowEnd,
        center: (windowStart + windowEnd) / 2,
        score,
        matchedWords,
      };
    }
  }
  return bestResult;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function extractFrame(sourcePath, atSec, outPath) {
  // scale='min(768,iw):-2' caps frame width at 768 px (preserves AR, rounds to even).
  // Prevents large 1080p/4K JPEGs from exceeding Anthropic's per-request image limit
  // and causing HTTP 400 "bad_request" errors during vision verification.
  await runFfmpeg(["-y", "-ss", Math.max(0, atSec).toFixed(3), "-i", sourcePath, "-frames:v", "1", "-vf", "scale='min(768,iw):-2'", "-q:v", "4", outPath]);
}

/**
 * Vision-based verification layer on top of Marengo's candidate shortlist.
 *
 * Root cause this addresses: Twelve Labs' hit.score is a *relative*,
 * per-query normalization, not an absolute relevance measure — the top-ranked
 * hit is frequently ~1.0 regardless of whether it actually depicts the
 * queried scene. Confirmed empirically against a real render's beat-log: of
 * 14 beats with hit.score === 1.00, a real vision check against real frames
 * found only 1/14 genuinely correct and 4/14 depicting a completely different
 * scene. So even though hit.score is a real API field (not a fabricated
 * rank formula), trusting it directly behaves exactly like a rank-position
 * proxy. This function replaces that trust with an actual content check:
 * extract a couple of frames from each of the top in-span candidates and ask
 * a vision model whether any of them genuinely matches the beat's visual
 * description, picking the best one (or none).
 */
async function verifyCandidatesWithVision({
  candidates, sourcePath, query, anthropicApiKey, jobId, beatIndex, log, maxCandidates = 3, framesPerCandidate = 2, sceneContext = null, softAccept = false,
}) {
  if (!anthropicApiKey || !candidates?.length) return null;
  const top = candidates.slice(0, Math.max(1, maxCandidates));
  const tmpDir = path.join(os.tmpdir(), "cinerecap-vision", String(jobId));
  await fs.mkdir(tmpDir, { recursive: true });
  const nFrames = Math.max(2, Math.min(4, framesPerCandidate));

  // Build optional scene context addendum (Upgrade 10: context-aware vision)
  let contextAddendum = "";
  if (sceneContext) {
    const ctxParts = [];
    if (sceneContext.prevBeatNarration) ctxParts.push(`Previous accepted beat: "${String(sceneContext.prevBeatNarration).slice(0, 150)}"`);
    if (sceneContext.expectedLocation) ctxParts.push(`Expected location: ${sceneContext.expectedLocation}`);
    if (sceneContext.expectedCharacters?.length) ctxParts.push(`Expected characters: ${sceneContext.expectedCharacters.slice(0, 3).join(", ")}`);
    if (sceneContext.currentChapter) ctxParts.push(`Current chapter: ${sceneContext.currentChapter}`);
    if (sceneContext.nextBeatNarration) ctxParts.push(`Next expected beat: "${String(sceneContext.nextBeatNarration).slice(0, 120)}" — prefer clips that are transitioning toward this next scene`);
    if (ctxParts.length) {
      contextAddendum = `\n\nScene context — use this to prefer candidates that logically follow from the previous beat, match the expected setting, and are heading toward the next:\n${ctxParts.join("\n")}`;
    }
  }

  const content = [{
    type: "text",
    text: softAccept
      ? `You are verifying video search results for a movie recap tool (LAST-RESORT mode). Below are ${top.length} candidate clip(s), each shown as ${nFrames} frames sampled evenly through the clip. All primary retrieval tiers have been exhausted for this beat:\n\n"${query}"${contextAddendum}\n\nFor EACH candidate, judge ONLY what is visually observable in the frames — characters, actions, setting, and objects. Do NOT judge audio-only content. ACCEPT a candidate if it is at least reasonably related to the described scene — same general location, similar type of action, or matching characters. REJECT only if the clip is completely unrelated (entirely different setting, action, and characters with no connection whatsoever). A partial or approximate visual match is acceptable.\n\nRespond with ONLY strict JSON, no markdown fences, no commentary: {"choice": <candidate number 1-${top.length}, or null>, "confidence": 0-1, "reason": "one short sentence"}`
      : `You are verifying video search results for a movie recap tool. Below are ${top.length} candidate clip(s), each shown as ${nFrames} frames sampled evenly through the clip. One of them was proposed by a search system as the visual match for this beat description:\n\n"${query}"${contextAddendum}\n\nFor EACH candidate, judge ONLY what is visually observable in the frames — characters present, their physical actions, the setting/location, and visible objects. Do NOT judge or assume spoken dialogue, conversation topics, character names spoken aloud, or any other audio-only content — frames cannot prove what was said, only what is shown. Prefer candidates that match the scene context above when multiple candidates look plausible. Then pick the single best visually matching candidate, or none if none genuinely match on visual grounds.\n\nRespond with ONLY strict JSON, no markdown fences, no commentary: {"choice": <candidate number 1-${top.length}, or null>, "confidence": 0-1, "reason": "one short sentence"}`,
  }];

  const framePaths = [];
  try {
    for (let ci = 0; ci < top.length; ci++) {
      const c = top[ci];
      const dur = Math.max(0.5, c.endSec - c.startSec);
      content.push({ type: "text", text: `Candidate ${ci + 1}:` });
      for (let fi = 0; fi < nFrames; fi++) {
        const frac = (fi + 1) / (nFrames + 1);
        const t = c.startSec + dur * frac;
        const fp = path.join(tmpDir, `b${beatIndex}_c${ci}_${fi}.jpg`);
        await extractFrame(sourcePath, t, fp);
        framePaths.push(fp);
        const b = (await fs.readFile(fp)).toString("base64");
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b } });
      }
    }

    // Anthropic's 529 ("overloaded") is a transient capacity error, not a
    // real rejection — retrying after a short backoff usually succeeds.
    // Without this retry, a single transient 529 permanently downgrades the
    // beat to the old unreliable score-gate fallback for the rest of the
    // run (confirmed live 2026-07-10: beats 22/33 regressed from accepted
    // to rejected-low-score purely because of one 529 each, no code or
    // content difference from the prior successful run).
    const retryableStatuses = new Set([429, 500, 502, 503, 529]);
    const backoffsMs = [1500, 4000];
    let resp;
    for (let attempt = 0; ; attempt++) {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 300,
          messages: [{ role: "user", content }],
        }),
      });
      if (resp.ok || !retryableStatuses.has(resp.status) || attempt >= backoffsMs.length) break;
      log?.(`[VISION] beat ${beatIndex}: API error ${resp.status} — retrying in ${backoffsMs[attempt]}ms (attempt ${attempt + 1}/${backoffsMs.length})`);
      await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
    }
    if (!resp.ok) {
      log?.(`[VISION] beat ${beatIndex}: API error ${resp.status} — falling back to score gate`);
      return { error: `http ${resp.status}` };
    }
    const data = await resp.json();
    const raw = data?.content?.[0]?.text?.trim() || "";
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();
    let parsed;
    try { parsed = JSON.parse(jsonStr); } catch { parsed = null; }
    if (!parsed || typeof parsed.choice === "undefined") {
      log?.(`[VISION] beat ${beatIndex}: unparseable response — ${raw.slice(0, 200)}`);
      return { error: "unparseable" };
    }
    if (parsed.choice === null || parsed.choice < 1 || parsed.choice > top.length) {
      return { matched: false, reason: parsed.reason, confidence: parsed.confidence };
    }
    return {
      matched: true,
      candidate: top[parsed.choice - 1],
      reason: parsed.reason,
      confidence: parsed.confidence,
    };
  } catch (e) {
    log?.(`[VISION] beat ${beatIndex}: verification threw (${e?.message || e}) — falling back to score gate`);
    return { error: e?.message || String(e) };
  } finally {
    for (const p of framePaths) { try { await fs.unlink(p); } catch {} }
  }
}

/**
 * Search a visual query against an indexed movie. Returns best in-span match or null.
 *
 * Changes from original:
 *   - searchOptions is now ["visual"] only — audio/transcription caused movie
 *     dialogue to match narration vocabulary spuriously, producing false hits
 *     scattered across the entire film.
 *   - Uses Twelve Labs' actual hit.score (real confidence 0–1) instead of a
 *     fabricated rank-based formula that had no relation to retrieval quality.
 *   - Collects Top-5 in-span candidates and returns the best one together with
 *     its confidence gap over the second-best, enabling the caller to reject
 *     ambiguous matches rather than blindly accepting the first hit.
 */
export async function searchBeatMoment({ apiKey, indexId, videoId, query, spanStart, spanEnd }) {
  const q = String(query || "").trim().slice(0, 1800);
  if (!q) return null;

  // pageLimit was 5 (top-5 GLOBAL clips across the whole movie, not top-5
  // within this beat's local span). On repeated visual content (e.g. multiple
  // fight scenes in a boxing film) the correct in-span footage can easily
  // rank outside the top 5 globally, so the in-span filter below found zero
  // candidates even when good footage existed in the span — this was the
  // dominant cause of "no-result" beats (see beat-log diagnostic, 2026-07-09).
  // Raised to 50, the Twelve Labs API's documented maximum, to give the
  // in-span filter a much larger pool to search within.
  const PAGE_LIMIT = 50;

  const client = createClient(apiKey);
  const pager = await client.search.query({
    indexId,
    queryText: q,
    searchOptions: ["visual"],   // visual-only — no dialogue/transcription noise
    operator: "or",
    pageLimit: PAGE_LIMIT,
    groupBy: "clip",
    ...(videoId ? { filter: JSON.stringify({ id: [videoId] }) } : {}),
  });

  const hits = [];
  for await (const hit of pager) {
    hits.push(hit);
    if (hits.length >= PAGE_LIMIT) break;
  }
  if (!hits.length) return { noHits: true, rawHitCount: 0 };

  const spanLo = Number(spanStart) || 0;
  const spanHi = Number(spanEnd) || Number.POSITIVE_INFINITY;

  // Collect all in-span candidates with real Twelve Labs scores.
  const candidates = [];
  for (const hit of hits) {
    const start = Number(hit.start);
    const end   = Number(hit.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const center = (start + end) / 2;
    if (center < spanLo - 2 || center > spanHi + 2) continue;
    // Use Twelve Labs' real score field (0–1). Fall back to rank-derived estimate
    // only if the SDK somehow omits it (should not happen with current SDK).
    const score = Number(hit.score ?? hit.confidence ?? (1 - (Number(hit.rank || 1) - 1) * 0.12));
    candidates.push({
      startSec: start,
      endSec: end,
      center,
      score: Math.max(0, Math.min(1, score)),
      rank: Number(hit.rank) || 99,
    });
  }
  if (!candidates.length) return { noHits: false, rawHitCount: hits.length, outOfSpan: true };

  // Sort by real score descending — best match first.
  candidates.sort((a, b) => b.score - a.score);
  const best   = candidates[0];
  const second = candidates[1];
  const confidenceGap = second ? best.score - second.score : 1.0;

  return {
    startSec: best.startSec,
    endSec:   best.endSec,
    center:   best.center,
    rank:     best.rank,
    confidence:    best.score,
    confidenceGap,
    candidates,
  };
}

/**
 * Matches a beat's narration + VSO events against Pegasus chapter titles and
 * summaries to find which chapter the beat belongs to, then returns a tight
 * search span (chapter window ± 30s buffer) for Marengo to search within.
 *
 * Scoring = semantic keyword overlap (70%) + proximity to Claude's estimate (30%).
 * Proximity breaks ties when two chapters have similar titles (e.g. two "FBI
 * Meeting" scenes) — the one nearer Claude's window wins. Threshold 0.18
 * requires real semantic signal; pure proximity matches (semantic=0) score 0.
 */
function matchBeatToChapter(narration, events, chapters, claudeCenter, srcDur) {
  if (!Array.isArray(chapters) || !chapters.length) return null;

  const queryText = [narration, ...events].join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const queryWords = queryText.split(/\s+/).filter((w) => w.length > 3 && !_TX_STOP.has(w));
  if (!queryWords.length) return null;

  const normDur = srcDur > 0 ? srcDur : 7200;
  const maxProxDist = normDur * 0.25;

  let bestScore = 0;
  let bestChapter = null;

  for (const ch of chapters) {
    const chText = `${ch.title || ""} ${ch.summary || ""}`.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    if (!chText.trim()) continue;

    // Substring match: also catches "beekeeper" when query word is "beekeep" or vice-versa
    const hits = queryWords.filter((w) => {
      if (chText.includes(w)) return true;
      if (w.length > 5) {
        return chText.split(/\s+/).some((cw) => cw.length > 5 && (cw.startsWith(w.slice(0, 5)) || w.startsWith(cw.slice(0, 5))));
      }
      return false;
    }).length;

    const semantic = hits / queryWords.length;
    if (semantic === 0) continue;

    const chCenter = (Number(ch.start) + Number(ch.end)) / 2;
    const proximity = Math.max(0, 1 - Math.abs(chCenter - claudeCenter) / maxProxDist);
    const score = semantic * 0.7 + proximity * 0.3;

    if (score > bestScore) {
      bestScore = score;
      bestChapter = ch;
    }
  }

  if (!bestChapter || bestScore < 0.18) return null;

  // Dynamic window tiers (Upgrade 12): tighter windows when confidence is high.
  // High confidence (>=0.40): ±20s — chapter match is unambiguous.
  // Medium confidence (0.25-0.40): ±60s — some ambiguity, allow adjacent clips.
  // Low confidence (0.18-0.25): ±120s — weak signal, stay close but allow room.
  // No match (<0.18): ±300s fallback handled by caller.
  const bufferSec = bestScore >= 0.40 ? 20 : bestScore >= 0.25 ? 60 : 120;
  return {
    chapter: bestChapter,
    score: bestScore,
    bufferSec,
    spanStart: Math.max(0, Number(bestChapter.start) - bufferSec),
    spanEnd: Number(bestChapter.end) + bufferSec,
  };
}

/**
 * Per-beat visual localization via Twelve Labs text search.
 *
 * Key changes from original (v3.2.4 → v3.3.0):
 *   - Each beat's raw narration is first converted to a Visual Search Object
 *     (VSO) by Claude Haiku before being sent to Twelve Labs. Raw narration
 *     paragraphs (thoughts, emotions, explanations) produce irrelevant matches;
 *     VSO queries describe only what is physically visible on screen.
 *   - Acceptance requires BOTH a minimum Twelve Labs score AND a minimum
 *     confidence gap between rank-1 and rank-2. When multiple candidates score
 *     similarly, the match is ambiguous and rejected — wrong footage is worse
 *     than keeping Claude's analyzed window.
 *   - Chronological slack tightened from 15 s to 5 s (overridable via env).
 *     The old 15 s slack let Twelve Labs scatter beats across the full film
 *     because false matches from dialogue search could be within 15 s of each
 *     other by coincidence — this masked the real random ordering problem.
 */
/**
 * Fix A — Word-level Whisper anchor.
 * Extracts content words (5+ chars, non-stop-words) from the narration, finds
 * them in Whisper's word-level array near the beat center (within ±radiusSec),
 * and returns up to 3 matched timestamps. Used to correct Claude's window
 * estimate when hard dialogue evidence contradicts it (>30s drift threshold).
 */
function _findWordAnchorTimestamps(narration, whisperWords, beatCenter, radiusSec = 120) {
  const STOP = new Set([
    "there","their","which","would","could","should","about","after","other","every",
    "being","while","still","through","between","these","those","where","before",
    "always","never","often","again","found","until","under","above","along",
    "since","might","shall","yours","truly","quite","today","first","great","until",
    "bring","build","break","carry","leave","stand","start","three","large","place",
    "right","small","those","thing","think","watch","write","years","young","given",
  ]);
  const contentWords = narration.toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !STOP.has(w));
  if (contentWords.length === 0) return [];
  const lo = beatCenter - radiusSec;
  const hi = beatCenter + radiusSec;
  const hits = [];
  for (const entry of whisperWords) {
    const t = Number(entry.start);
    if (!Number.isFinite(t) || t < lo || t > hi) continue;
    const w = (entry.word || "").replace(/[^a-z]/g, "");
    if (w.length < 5 || STOP.has(w)) continue;
    const isMatch = contentWords.some((cw) => {
      const minLen = Math.min(cw.length, w.length);
      const stemLen = Math.max(4, minLen - 1);
      return minLen >= 5 && cw.slice(0, stemLen) === w.slice(0, stemLen);
    });
    if (isMatch) hits.push({ t, dist: Math.abs(t - beatCenter) });
  }
  if (hits.length === 0) return [];
  hits.sort((a, b) => a.dist - b.dist);
  return hits.slice(0, 3).map((h) => h.t);
}

export async function localizeBeatsWithTwelveLabs({
  jobId,
  apiKey,
  anthropicApiKey,   // required for VSO conversion via Claude Haiku AND vision verification
  sourcePath,        // NEW — required for vision verification frame extraction
  clipSidecarUrl,    // TIER-D — http://localhost:8788 when CLIP sidecar is active
  clipAnalyzeJobId,  // TIER-D — analyzeJobId whose frames are pre-embedded in the sidecar
  indexEntry,
  beatTexts,
  voDurs,
  scenes,
  protectedVisualBeats,
  srcDur,
  pegasusChapters,
  transcriptSegments,
  whisperWords = [],  // Fix A — word-level timestamps [{word, start, end}] for search anchoring
  log,
}) {
  const maxBeats      = Math.max(0, Number(process.env.TWELVELABS_MAX_BEATS) || scenes.length);
  const minWindowSec  = Math.max(6, Number(process.env.TWELVELABS_MIN_WINDOW_SEC) || 8);
  // Raised from 90s → 300s: the old 90s limit was rejecting valid TL corrections when
  // Claude's original window was ~91-106s off (observed in production). With accurate VSO
  // queries, a high-confidence TL match 100-200s from Claude's window is more trustworthy
  // than Claude's wrong window. 300s (5 min) still guards against half-movie jumps.
  const protectMaxReloc = Math.max(15, Number(process.env.TWELVELABS_PROTECT_MAX_RELOC_SEC) || 300);
  // Tightened from 15 s → 5 s: prevents false matches from dialogue search
  // creating an illusion of chronological order while actually scattering beats.
  const chronoSlackSec = Math.max(0, Number(process.env.TWELVELABS_CHRONO_SLACK_SEC) || 5);
  // Minimum real Twelve Labs score to accept a match (0–1 scale).
  const minScore      = Math.max(0.1, Number(process.env.TWELVELABS_MIN_SCORE) || 0.45);
  // Minimum gap between rank-1 and rank-2 scores — rejects ambiguous matches.
  const minGap        = Math.max(0,   Number(process.env.TWELVELABS_MIN_GAP)   || 0.08);
  const COVERAGE_TARGET = 1.2;
  const MAX_SPAN_SEC    = 300;

  const _preSpanScenes = scenes.map((sc) => ({ ...sc }));
  let attempted = 0, applied = 0, rejected = 0, failed = 0, skipped = 0;
  let vsoBuilt = 0, vsoFallback = 0;
  const outScenes  = scenes.map((sc) => ({ ...sc }));
  const searchDelayMs = Math.max(0, Number(process.env.TWELVELABS_SEARCH_DELAY_MS) || 250);

  // Step 12 — per-beat log: one entry per beat, updated at each decision point.
  const beatLog = Array.from({ length: scenes.length }, (_, i) => ({
    beat_id: i,
    query: null,
    narration_start: Number(_preSpanScenes[i]?.startSec ?? 0),
    narration_end:   Number(_preSpanScenes[i]?.endSec   ?? 0),
    narration_duration: Number(voDurs[i]) || 0,
    status: "not-attempted",
    confidence: null,
    confidence_gap: null,
    video_start: null,
    video_end: null,
    clip_duration: null,
    rejection_reason: null,
    vision_verified: null,
    vision_reason: null,
    // Populated only for beats where buildVisualQuery split the narration
    // into multiple distinct visual events (see buildVisualQuery docs).
    events: null,
    subEvents: null,
    location: null,
    characters: null,
    primary_action: null,
    chapter_match: null,
    composite_candidates: null,
    scene_memory_used: null,
  }));

  // ── SCENE MEMORY ENGINE (Upgrades 1-5: Sequential Context-Aware Retrieval) ──
  // Maintains persistent context across beats. After each accepted beat, its
  // location/characters/chapter/timestamp are stored here and fed into composite
  // candidate scoring and vision verification for the NEXT beat — transforming
  // independent per-beat retrieval into sequential, context-aware retrieval.
  // sceneGraph accumulates every accepted beat for post-render validation.
  const sceneMemory = {
    chapter: null, chapterStart: null, chapterEnd: null,
    location: null, characters: [], primaryAction: null,
    timestamp: null, beatId: null, narration: null,
    nextExpectedNarration: null, // predictive: next beat's narration, set after each accept
  };
  const sceneGraph = [];

  for (let i = 0; i < outScenes.length && attempted < maxBeats; i++) {
    const isProtected = protectedVisualBeats[i];
    const prevStart = i > 0 ? Number(_preSpanScenes[i - 1].startSec) : 0;
    const nextEnd   = i < _preSpanScenes.length - 1
      ? Number(_preSpanScenes[i + 1].endSec)
      : (srcDur || Number(_preSpanScenes[i].endSec) + 60);
    let spanStart = Math.max(0, Math.min(prevStart, Number(_preSpanScenes[i].startSec)));
    let spanEnd   = Math.max(nextEnd, Number(_preSpanScenes[i].endSec));
    if (spanEnd - spanStart > MAX_SPAN_SEC) {
      const mid = (Number(_preSpanScenes[i].startSec) + Number(_preSpanScenes[i].endSec)) / 2;
      spanStart = Math.max(spanStart, mid - MAX_SPAN_SEC / 2);
      spanEnd   = Math.min(spanEnd,   mid + MAX_SPAN_SEC / 2);
    }

    const need = Math.max(minWindowSec, Number(voDurs[i]) || 0);
    if (!(spanEnd - spanStart >= Math.min(need, 4))) {
      beatLog[i].status = "skipped";
      beatLog[i].rejection_reason = `span ${(spanEnd - spanStart).toFixed(1)}s < min ${Math.min(need, 4).toFixed(1)}s`;
      skipped++; continue;
    }

    // ── Build Visual Search Object (VSO) query ────────────────────────────
    // Convert raw narration to a concrete visual description before querying.
    // Raw narration ("he realizes his father betrayed him") cannot be matched
    // by Twelve Labs — only visible actions ("man reads a letter, face drops,
    // sits silently") produce accurate retrieval.
    //
    // MULTI-EVENT (2026-07-10): buildVisualQuery may split narration that
    // chains together distinct scenes into 2-3 "events". The overwhelming
    // majority of beats produce exactly 1 event; the code below treats that
    // as a single-element loop, which is functionally identical to the old
    // single-query path (same guards, same window-expansion math, same
    // beatLog fields) — multi-event handling is purely additive.
    const rawNarration = beatTexts[i] || "";
    const vso = await buildVisualQuery(rawNarration, anthropicApiKey, log, {
      prevNarration: i > 0 ? (beatTexts[i - 1] || null) : null,
      nextNarration: i < beatTexts.length - 1 ? (beatTexts[i + 1] || null) : null,
    });
    const events = vso.events.length ? vso.events : [rawNarration.slice(0, 800)];
    const dialogueCues = Array.isArray(vso.dialogueCues) ? vso.dialogueCues : [];

    // ── CREDITS/TITLE-CARD QUERY GUARD ────────────────────────────────────
    // If the visual query (built from narration) describes opening credits,
    // end credits, title cards, or studio logos, skip the TL search entirely.
    // Sending such a query to Twelve Labs will find exactly those frames
    // (correctly), which then appear in the output video alongside real story
    // beats. The root cause is Claude correctly identifying a credits sequence
    // as a beat — the fix is to suppress TL rather than remove the beat from
    // the script, so gap-fill can draw from adjacent accepted beats instead.
    const _creditsQueryRE = /\bcredit|title[\s_-]?card|production\s+compan|studio\s+logo|opening\s+title/i;
    if (_creditsQueryRE.test(events.join(" "))) {
      beatLog[i].status = "no-result";
      beatLog[i].rejection_reason = "credits/title-card visual query — TL search suppressed";
      log?.(`[render ${jobId}] TLABS beat ${i}: credits/title-card query detected — suppressing TL search`);
      rejected++;
      continue;
    }
    // ── END CREDITS/TITLE-CARD QUERY GUARD ────────────────────────────────
    if (events.length > 1 || (events[0] && events[0] !== rawNarration.slice(0, 800))) {
      vsoBuilt++;
    } else {
      vsoFallback++;
    }
    beatLog[i].query = events.join(" | ");
    if (events.length > 1) beatLog[i].events = events;
    if (vso.location) beatLog[i].location = vso.location;
    if (vso.characters?.length) beatLog[i].characters = vso.characters;
    if (vso.primaryAction) beatLog[i].primary_action = vso.primaryAction;
    // ── END VSO build ─────────────────────────────────────────────────────

    // ── PEGASUS CHAPTER PRE-NARROWING ─────────────────────────────────────
    // Find the Pegasus chapter whose title+summary best matches this beat's
    // narration and override the broad ±300s search span with that chapter's
    // tight ~20-30s window (+30s buffer on each side). A 60-90s window is
    // 4-8× tighter than the default, dramatically reducing false positives
    // where Marengo finds visually plausible clips in the wrong film section.
    // If no chapter meets the 0.18 threshold the original broad span is kept.
    if (Array.isArray(pegasusChapters) && pegasusChapters.length > 0) {
      const _claudeMid = (Number(_preSpanScenes[i].startSec) + Number(_preSpanScenes[i].endSec)) / 2;
      const _chMatch = matchBeatToChapter(rawNarration, events, pegasusChapters, _claudeMid, srcDur);
      if (_chMatch) {
        // Drift guard: PEGASUS matched a chapter whose title/summary shares words
        // with the narration, but those same words (FBI, agents, fight, etc.) appear
        // throughout the film. Without this guard, PEGASUS shifts the search window
        // hundreds of seconds from where Claude placed the beat — TL then finds a
        // semantically plausible but temporally wrong clip, and vision accepts it
        // because FBI-agents-in-a-room looks like FBI-agents-in-a-room.
        // Cap: reject the PEGASUS match if its chapter center is further than
        // min(srcDur×0.12, 500s) from Claude's original beat center. That keeps
        // legitimate nearby narrowing (e.g. ±300s) while blocking cross-film drift.
        const _chCenter = (Number(_chMatch.chapter.start) + Number(_chMatch.chapter.end)) / 2;
        const _chDrift  = Math.abs(_chCenter - _claudeMid);
        const _maxDrift = Math.min((srcDur || 7200) * 0.12, 500);
        if (_chDrift > _maxDrift) {
          log?.(`[render ${jobId}] PEGASUS-DRIFT beat ${i}: chapter "${_chMatch.chapter.title}" center ${_chCenter.toFixed(0)}s is ${_chDrift.toFixed(0)}s from Claude center ${_claudeMid.toFixed(0)}s > max ${_maxDrift.toFixed(0)}s — keeping original span`);
        } else {
          spanStart = _chMatch.spanStart;
          spanEnd   = _chMatch.spanEnd;
          beatLog[i].chapter_match = { title: _chMatch.chapter.title, score: _chMatch.score, start: _chMatch.chapter.start, end: _chMatch.chapter.end };
          log?.(`[render ${jobId}] PEGASUS-NARROW beat ${i}: "${_chMatch.chapter.title}" (${Number(_chMatch.chapter.start).toFixed(0)}-${Number(_chMatch.chapter.end).toFixed(0)}s) score=${_chMatch.score.toFixed(2)} → span ${_chMatch.spanStart.toFixed(0)}-${_chMatch.spanEnd.toFixed(0)}s`);
        }
      }
    }
    // ── END PEGASUS CHAPTER PRE-NARROWING ─────────────────────────────────

    // ── WORD-ANCHOR (Fix A): refine span using Whisper word-level timestamps ──
    // If key content words from the narration appear in the Whisper word array
    // at a position meaningfully different from Claude's window center (>30s),
    // shift the search span toward where the dialogue evidence actually places
    // this beat. Only fires when words are available (new analyze jobs only).
    if (Array.isArray(whisperWords) && whisperWords.length > 0) {
      const _beatCenter = (Number(_preSpanScenes[i].startSec) + Number(_preSpanScenes[i].endSec)) / 2;
      const _anchors = _findWordAnchorTimestamps(rawNarration, whisperWords, _beatCenter);
      if (_anchors.length > 0) {
        const _anchorCenter = _anchors.reduce((a, b) => a + b, 0) / _anchors.length;
        // Only shift when anchor is meaningfully different from Claude's center.
        // This prevents false positives from short common words that appear everywhere.
        if (Math.abs(_anchorCenter - _beatCenter) > 30) {
          const _halfSpan = Math.min((spanEnd - spanStart) / 2, 90);
          spanStart = Math.max(0, _anchorCenter - _halfSpan);
          spanEnd = Math.min(srcDur, _anchorCenter + _halfSpan);
          log?.(`[render ${jobId}] WORD-ANCHOR beat ${i}: center ${_beatCenter.toFixed(0)}s → ${_anchorCenter.toFixed(0)}s (${_anchors.length} word match(es)), new span ${spanStart.toFixed(0)}-${spanEnd.toFixed(0)}s`);
          beatLog[i].word_anchor = { center: _anchorCenter, count: _anchors.length };
        }
      }
    }
    // ── END WORD-ANCHOR ────────────────────────────────────────────────────

    attempted++;
    try {
      // ── Vision verification gate (replaces the score+gap heuristic) ──────
      // Twelve Labs' hit.score is a per-query relative normalization, not an
      // absolute relevance measure — empirically confirmed to behave like a
      // rank-position proxy (see verifyCandidatesWithVision docs above: 14
      // real "score 1.00" beats checked against real frames, only 1/14
      // genuinely correct, 4/14 a completely different scene). Instead of
      // gating on that score, actually look at frames from the top in-span
      // candidates and ask a vision model which one (if any) is real.
      const visionMaxCandidates = Math.max(1, Number(process.env.TWELVELABS_VISION_MAX_CANDIDATES) || 3);

      // Search + vision-verify ONE event's query against the beat's shared
      // span. Never throws — search/vision errors surface as a typed
      // rejection so one bad sub-event can't blow up the whole beat.
      const runOne = async (query, isVeryFirst) => {
        if (searchDelayMs > 0 && !isVeryFirst) await sleep(searchDelayMs);
        const v = await searchBeatMoment({ apiKey, indexId: indexEntry.indexId, videoId: indexEntry.videoId, query, spanStart, spanEnd });
        if (!v) return { ok: false, kind: "no-result", reason: "empty query" };
        if (v.noHits) return { ok: false, kind: "no-result", reason: "TL returned zero raw hits (query matched nothing in the index)" };
        if (v.outOfSpan) return { ok: false, kind: "no-result", reason: `TL returned ${v.rawHitCount} hits, none within beat span` };

        // ── COMPOSITE CANDIDATE SCORING (Upgrade 9) ──────────────────────
        // Re-rank Marengo's candidates using multi-signal composite score:
        //   Visual similarity (Marengo): 45% | Temporal continuity: 30%
        //   Chapter continuity: 15%           | Scene graph bonus: 10%
        // This ensures the chronologically and contextually plausible clip
        // is preferred over the globally highest-scoring but wrong-section clip.
        if (Array.isArray(v.candidates) && v.candidates.length > 1 && sceneMemory.timestamp !== null) {
          const maxJumpSec = Math.max(300, (srcDur || 7200) * 0.15);
          const chStart = beatLog[i].chapter_match?.start ?? null;
          const chEnd   = beatLog[i].chapter_match?.end   ?? null;
          v.candidates = v.candidates.map((c) => {
            const visual    = c.score * 0.45;
            const temporal  = Math.max(0, 1 - Math.abs(c.center - sceneMemory.timestamp) / maxJumpSec) * 0.30;
            const inChapter = chStart !== null && c.center >= chStart - 30 && c.center <= (chEnd ?? chStart) + 30;
            const chapter   = inChapter ? 0.15 : 0;
            const sgBonus   = Math.abs(c.center - sceneMemory.timestamp) < 120 ? 0.10 : 0;
            return { ...c, compositeScore: visual + temporal + chapter + sgBonus };
          });
          v.candidates.sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0));
          v.startSec = v.candidates[0].startSec;
          v.endSec   = v.candidates[0].endSec;
          v.center   = v.candidates[0].center;
          v.confidence      = v.candidates[0].score;
          v.confidenceGap   = v.candidates.length > 1 ? v.candidates[0].score - v.candidates[1].score : 1.0;
          beatLog[i].composite_candidates = v.candidates.slice(0, 5).map((c) => ({
            center: c.center, marengo: c.score, composite: c.compositeScore ?? null,
          }));
        }
        // ── END COMPOSITE SCORING ─────────────────────────────────────────

        // Build scene context for vision verification (Upgrades 10 + 11.3)
        // Includes both what came before (scene memory) and what comes next
        // (predictive: the actual next beat narration we already have upfront).
        const _sceneCtx = sceneMemory.timestamp !== null ? {
          prevBeatNarration: sceneMemory.narration,
          expectedLocation: sceneMemory.location,
          expectedCharacters: sceneMemory.characters,
          currentChapter: sceneMemory.chapter,
          nextBeatNarration: i < beatTexts.length - 1 ? (beatTexts[i + 1] || null) : null,
        } : (i < beatTexts.length - 1 ? {
          nextBeatNarration: beatTexts[i + 1] || null,
        } : null);

        const vv = sourcePath
          ? await verifyCandidatesWithVision({ candidates: v.candidates, sourcePath, query, anthropicApiKey, jobId, beatIndex: i, log, maxCandidates: visionMaxCandidates, sceneContext: _sceneCtx })
          : null;

        if (!vv || vv.error) {
          // Vision check unavailable (no source path / no key) or failed —
          // fall back to the old numeric score+gap gate rather than blocking
          // the render entirely.
          if (v.confidence < minScore || v.confidenceGap < minGap) {
            log?.(`[render ${jobId}] TLABS beat ${i}: vision unavailable${vv?.error ? ` (${vv.error})` : ""} — fallback score gate rejected (score=${v.confidence.toFixed(3)}, gap=${v.confidenceGap.toFixed(3)})`);
            return {
              ok: false, kind: "low-score", confidence: v.confidence, confidenceGap: v.confidenceGap, visionVerified: false,
              reason: vv?.error
                ? `vision check failed (${vv.error}) — fallback score gate: score=${v.confidence.toFixed(3)} gap=${v.confidenceGap.toFixed(3)}`
                : `score ${v.confidence.toFixed(3)} < min ${minScore} or gap ${v.confidenceGap.toFixed(3)} < min ${minGap} (vision unavailable)`,
            };
          }
          return { ok: true, startSec: v.startSec, endSec: v.endSec, center: v.center, confidence: v.confidence, confidenceGap: v.confidenceGap, visionVerified: false, visionReason: null };
        }
        if (!vv.matched) {
          log?.(`[render ${jobId}] TLABS beat ${i}: vision rejected all ${Math.min(visionMaxCandidates, v.candidates.length)} candidates for "${query.slice(0, 60)}" — ${vv.reason || "no match"}`);
          return {
            ok: false, kind: "vision-no-match", confidence: v.confidence, confidenceGap: v.confidenceGap, visionVerified: false, visionReason: vv.reason || null,
            reason: `vision: no candidate matched (${vv.reason || "n/a"})`,
            candidates: v.candidates?.slice(0, 5) || [],
          };
        }
        // Vision confirmed a specific candidate — may not be TL's rank-1.
        log?.(`[render ${jobId}] TLABS beat ${i}: vision confirmed candidate (tl-score=${vv.candidate.score.toFixed(3)}) — ${vv.reason || ""}`);
        return { ok: true, startSec: vv.candidate.startSec, endSec: vv.candidate.endSec, center: vv.candidate.center, confidence: vv.candidate.score, confidenceGap: v.confidenceGap, visionVerified: true, visionReason: vv.reason || null };
      };

      const origCenter = (Number(_preSpanScenes[i].startSec) + Number(_preSpanScenes[i].endSec)) / 2;
      const prevCenter = i > 0
        ? (Number(outScenes[i - 1].focusSec)
          || (Number(outScenes[i - 1].startSec) + Number(outScenes[i - 1].endSec)) / 2)
        : 0;
      const dupThresholdSec = Math.max(1, Number(process.env.TWELVELABS_DUP_THRESHOLD_SEC) || 3);

      // Run every event in order, applying the SAME guards as the old
      // single-event path (protected relocation, chronological order,
      // duplicate center) against a rolling "last accepted center" — so
      // events within one multi-event beat must also progress forward in
      // time, not just relative to the previous BEAT. An event that fails
      // any guard is dropped (not the whole beat), unless every event fails.
      const kept = [];
      let lastCenter = prevCenter;
      let lastRejection = null;
      // Tier A: collect best visual candidates from vision-rejected runOne() calls
      // so the soft-accept pass can re-verify them with a relaxed prompt.
      const bestRejectedCandidates = [];
      for (let e = 0; e < events.length; e++) {
        const r = await runOne(events[e], attempted === 1 && e === 0);
        if (!r.ok) {
          if (r.candidates?.length) bestRejectedCandidates.push(...r.candidates);
          lastRejection = r;
          continue;
        }
        if (isProtected && Math.abs(r.center - origCenter) > protectMaxReloc) {
          log?.(`[render ${jobId}] TLABS beat ${i}: protected relocation ${Math.abs(r.center - origCenter).toFixed(1)}s — rejected`);
          lastRejection = { kind: "protected", confidence: r.confidence, confidenceGap: r.confidenceGap, visionVerified: r.visionVerified, visionReason: r.visionReason, reason: `relocation ${Math.abs(r.center - origCenter).toFixed(1)}s > max ${protectMaxReloc}s` };
          continue;
        }
        // The chronological/duplicate guards exist to catch false positives
        // from the unreliable numeric score gate (see runOne's vision-
        // unavailable fallback path) — they were never meant to overrule a
        // candidate Claude's own vision check has actually confirmed shows
        // the beat's narration. When vision has verified a candidate, an
        // "out of order" or "duplicate center" result is real information
        // (e.g. a flashback, or the same continuous take covering two
        // consecutive beats) — rejecting it just discards verified evidence
        // in favor of Claude's ORIGINAL analyze-time window, which was never
        // chronology-checked at all. So these guards only apply when the
        // candidate is unverified.
        if (!r.visionVerified && r.center < lastCenter - chronoSlackSec) {
          log?.(`[render ${jobId}] TLABS beat ${i}: chronological guard (${r.center.toFixed(1)}s < prev ${lastCenter.toFixed(1)}s − slack ${chronoSlackSec}s) — rejected`);
          lastRejection = { kind: "chronological", confidence: r.confidence, confidenceGap: r.confidenceGap, visionVerified: r.visionVerified, visionReason: r.visionReason, reason: `center ${r.center.toFixed(1)}s < prev ${lastCenter.toFixed(1)}s (chrono)` };
          continue;
        }
        if (!r.visionVerified && kept.length === 0 && i > 0 && Math.abs(r.center - lastCenter) < dupThresholdSec) {
          log?.(`[render ${jobId}] TLABS beat ${i}: duplicate-center guard (${r.center.toFixed(1)}s ≈ prev ${lastCenter.toFixed(1)}s ±${dupThresholdSec}s) — rejected`);
          lastRejection = { kind: "duplicate", confidence: r.confidence, confidenceGap: r.confidenceGap, visionVerified: r.visionVerified, visionReason: r.visionReason, reason: `center ${r.center.toFixed(1)}s ≈ prev ${lastCenter.toFixed(1)}s (dup)` };
          continue;
        }
        if (r.visionVerified && r.center < lastCenter - chronoSlackSec) {
          log?.(`[render ${jobId}] TLABS beat ${i}: chronological guard BYPASSED (vision-verified, ${r.center.toFixed(1)}s < prev ${lastCenter.toFixed(1)}s − slack ${chronoSlackSec}s)`);
        }
        if (r.visionVerified && kept.length === 0 && i > 0 && Math.abs(r.center - lastCenter) < dupThresholdSec) {
          log?.(`[render ${jobId}] TLABS beat ${i}: duplicate-center guard BYPASSED (vision-verified, ${r.center.toFixed(1)}s ≈ prev ${lastCenter.toFixed(1)}s ±${dupThresholdSec}s)`);
        }
        kept.push({ ...r, eventIndex: e, query: events[e] });
        lastCenter = r.center;
      }

      if (kept.length === 0) {
        // ── Verify-the-fallback tier ──────────────────────────────────────
        // Nothing survived search + verification, but the beat doesn't just
        // get discarded as unmatched — Claude's ORIGINAL analyze-time window
        // (_preSpanScenes[i]) was never itself checked by Twelve Labs or
        // vision at all; every prior "no-result"/"rejected" beat silently
        // used it anyway without any evidence it was actually correct. Run
        // the same vision check against that window before giving up, so an
        // unmatched beat becomes either a real, verified accept or an
        // honestly-explained rejection — not a blind, unproven guess.
        const origStart = Number(_preSpanScenes[i]?.startSec);
        const origEnd   = Number(_preSpanScenes[i]?.endSec);
        let fallback = null;
        if (sourcePath && Number.isFinite(origStart) && Number.isFinite(origEnd) && origEnd > origStart) {
          const fbCandidate = { startSec: origStart, endSec: origEnd, center: (origStart + origEnd) / 2, score: 0 };
          // Judge against the same distilled visual-events query the primary
          // path uses (events.join), not raw narration — raw narration often
          // carries dialogue/topic content ("discussing The Walking Dead")
          // that no still frame can ever prove, which was unfairly failing
          // the hardest beats that reach this tier. Wide fallback windows
          // (often the full original analyze-time span) also get 3 sampled
          // frames instead of 2, since a wider window is more likely to miss
          // the relevant moment with only 2 samples.
          const fbQuery = events.join(" | ");
          const fbFrames = (origEnd - origStart) > 30 ? 3 : 2;
          const fbVv = await verifyCandidatesWithVision({ candidates: [fbCandidate], sourcePath, query: fbQuery, anthropicApiKey, jobId, beatIndex: i, log, maxCandidates: 1, framesPerCandidate: fbFrames });
          if (fbVv?.matched) {
            fallback = { ...fbCandidate, visionReason: fbVv.reason || null };
            log?.(`[render ${jobId}] TLABS beat ${i}: fallback window (${origStart.toFixed(1)}-${origEnd.toFixed(1)}s) vision-verified — ${fbVv.reason || ""}`);
          } else if (fbVv && !fbVv.error) {
            log?.(`[render ${jobId}] TLABS beat ${i}: fallback window also rejected by vision — ${fbVv.reason || "no match"}`);
            // CREDITS-SKIP tier: if the fallback window was rejected because it
            // only shows opening credits/title cards AND the beat sits in the
            // first 10% of the movie, advance the window past the intro section
            // and try the vision check one more time. This recovers beats that
            // Claude correctly narrated but mistakenly anchored to the credits
            // window (the SKIP filter only catches narration text that mentions
            // credits; it cannot detect a mismatch between narration content and
            // the footage in the assigned time window).
            // CREDITS-SKIP: detect "credits" without requiring exact word boundary so
            // "credits" (with trailing s), "title cards", etc. all match.
            const _creditsRE = /credit|title\s*card|production\s*compan|studio\s*logo|opening\s*title/i;
            const _isCreditRej = _creditsRE.test(fbVv.reason || "");
            const _isEarlyBeat = srcDur > 0 && origEnd < srcDur * 0.10;
            if (_isCreditRej && _isEarlyBeat) {
              // Instead of a fixed offset, run an actual Marengo search in the
              // story region (5-30% of movie, past where credits typically end).
              // This finds the best real clip for the beat's content regardless
              // of when exactly the credits end in this specific film.
              const _storyFloor = Math.max(origEnd + 30, srcDur * 0.05);
              const _storySpanEnd = Math.min(srcDur * 0.30, srcDur - 60);
              if (_storySpanEnd > _storyFloor + 10) {
                log?.(`[render ${jobId}] TLABS beat ${i}: credits-skip — searching story region ${_storyFloor.toFixed(0)}-${_storySpanEnd.toFixed(0)}s`);
                try {
                  const _skipSearch = await searchBeatMoment({
                    apiKey,
                    indexId: indexEntry.indexId,
                    videoId: indexEntry.videoId,
                    query: fbQuery,
                    spanStart: _storyFloor,
                    spanEnd: _storySpanEnd,
                  });
                  if (_skipSearch && !_skipSearch.noHits && !_skipSearch.outOfSpan) {
                    const _skipCand = {
                      startSec: _skipSearch.startSec,
                      endSec:   _skipSearch.endSec,
                      center:   _skipSearch.center,
                      score:    _skipSearch.confidence,
                    };
                    // For credits-skip we only need to confirm the clip is
                    // story content (characters/action/dialogue), NOT a perfect
                    // narration match — the exact narration query is too strict
                    // and rejects close-but-valid story clips.
                    const _creditSkipQuery =
                      "story scene: characters, action, dialogue, indoor or outdoor setting — " +
                      "NOT opening title cards, production company logos, credits text, or abstract background imagery";
                    const _skipVv = await verifyCandidatesWithVision({
                      candidates: [_skipCand],
                      sourcePath,
                      query: _creditSkipQuery,
                      anthropicApiKey,
                      jobId,
                      beatIndex: i,
                      log,
                      maxCandidates: 1,
                      framesPerCandidate: fbFrames,
                    });
                    if (_skipVv?.matched) {
                      fallback = { ..._skipCand, visionReason: _skipVv.reason || null };
                      log?.(`[render ${jobId}] TLABS beat ${i}: credits-skip ACCEPTED (${_skipCand.startSec.toFixed(0)}-${_skipCand.endSec.toFixed(0)}s) — ${_skipVv.reason || ""}`);
                    } else {
                      log?.(`[render ${jobId}] TLABS beat ${i}: credits-skip story-check rejected — ${_skipVv?.reason || "no match"}`);
                    }
                  } else {
                    log?.(`[render ${jobId}] TLABS beat ${i}: credits-skip search found no hits in story region`);
                  }
                } catch (_skipErr) {
                  log?.(`[render ${jobId}] TLABS beat ${i}: credits-skip search error — ${_skipErr?.message}`);
                }
              }
            }
          }
        }

        if (fallback) {
          const _fbS = Math.min(fallback.startSec, fallback.endSec);
          const _fbE = Math.max(fallback.startSec, fallback.endSec);
          outScenes[i] = {
            ...outScenes[i],
            startSec: _fbS,
            endSec:   _fbE,
            focusSec: fallback.center,
            reason: `${outScenes[i]?.reason || ""} [tlabs:fallback-verified]`,
          };
          beatLog[i].status = "accepted";
          beatLog[i].match_source = "fallback-verified";
          beatLog[i].video_start = _fbS;
          beatLog[i].video_end   = _fbE;
          beatLog[i].clip_duration = _fbE - _fbS;
          beatLog[i].vision_verified = true;
          beatLog[i].vision_reason = fallback.visionReason;
          log?.(`[render ${jobId}] TLABS beat ${i}: ACCEPTED (fallback-verified) center=${fallback.center.toFixed(1)}s`);
          sceneMemory.timestamp = fallback.center;
          if (vso.location) sceneMemory.location = vso.location;
          if (vso.characters?.length) sceneMemory.characters = vso.characters;
          if (vso.primaryAction) sceneMemory.primaryAction = vso.primaryAction;
          if (beatLog[i].chapter_match?.title) { sceneMemory.chapter = beatLog[i].chapter_match.title; sceneMemory.chapterStart = beatLog[i].chapter_match.start; sceneMemory.chapterEnd = beatLog[i].chapter_match.end; }
          sceneMemory.beatId = i; sceneMemory.narration = rawNarration;
          sceneMemory.nextExpectedNarration = i < beatTexts.length - 1 ? (String(beatTexts[i + 1] || "").slice(0, 150) || null) : null;
          beatLog[i].scene_memory_used = { beatId: sceneMemory.beatId, location: sceneMemory.location, chapter: sceneMemory.chapter, timestamp: sceneMemory.timestamp };
          sceneGraph.push({ beatId: i, timestamp: fallback.center, chapter: sceneMemory.chapter, location: sceneMemory.location, characters: [...(sceneMemory.characters || [])] });
          applied++;
          continue;
        }

        // ── TIER 2: Marengo audio search with dialogue cues ────────────────
        // Visual search found no match — try Marengo's audio track using
        // short spoken phrases extracted from the narration by buildVisualQuery.
        // Dialogue cues are highly specific; audio search pinpoints scenes that
        // look visually indistinguishable (e.g. multiple boardroom meetings) but
        // have unique spoken content. Span is ±5 min around the original center.
        if (!fallback && dialogueCues.length > 0) {
          for (const cue of dialogueCues) {
            if (fallback) break;
            try {
              if (searchDelayMs > 0) await sleep(searchDelayMs);
              const audioSpanLo = Math.max(0, origCenter - 300);
              const audioSpanHi = origCenter + 300;
              const aHit = await searchBeatMomentAudio({
                apiKey, indexId: indexEntry.indexId, videoId: indexEntry.videoId,
                query: cue, spanStart: audioSpanLo, spanEnd: audioSpanHi,
              });
              if (!aHit || aHit.noHits || aHit.outOfSpan || !aHit.candidates?.length) {
                log?.(`[render ${jobId}] TLABS beat ${i}: audio-tier cue "${cue.slice(0, 50)}" — no hits in span`);
                continue;
              }
              const aVv = sourcePath
                ? await verifyCandidatesWithVision({
                    candidates: aHit.candidates.slice(0, 3),
                    sourcePath,
                    query: events.join(" | "),
                    anthropicApiKey, jobId, beatIndex: i, log, maxCandidates: 3,
                  })
                : null;
              if (aVv?.matched) {
                fallback = { ...aVv.candidate, visionReason: aVv.reason || null };
                beatLog[i].match_source = "audio-tier";
                log?.(`[render ${jobId}] TLABS beat ${i}: AUDIO-TIER accepted (cue="${cue.slice(0, 50)}") — ${aVv.reason || ""}`);
              } else {
                log?.(`[render ${jobId}] TLABS beat ${i}: audio-tier cue "${cue.slice(0, 50)}" — vision rejected (${aVv?.reason || "no match"})`);
              }
            } catch (aErr) {
              log?.(`[render ${jobId}] TLABS beat ${i}: audio-tier error (non-fatal): ${aErr?.message}`);
            }
          }
        }

        // ── TIER 3: Whisper transcript keyword match ───────────────────────
        // Last resort: pure keyword-overlap search against the Whisper
        // transcript segments from analyze. No extra API calls. The matched
        // 15-second window is still vision-verified before being accepted.
        if (!fallback && Array.isArray(transcriptSegments) && transcriptSegments.length > 0) {
          try {
            const txMatch = transcriptKeywordMatch(rawNarration, transcriptSegments, origCenter, 300);
            if (txMatch) {
              const txCandidate = { startSec: txMatch.startSec, endSec: txMatch.endSec, center: txMatch.center, score: txMatch.score };
              const txVv = sourcePath
                ? await verifyCandidatesWithVision({
                    candidates: [txCandidate],
                    sourcePath,
                    query: events.join(" | "),
                    anthropicApiKey, jobId, beatIndex: i, log, maxCandidates: 1,
                  })
                : null;
              if (txVv?.matched) {
                fallback = { ...txCandidate, visionReason: txVv.reason || null };
                beatLog[i].match_source = "transcript-tier";
                log?.(`[render ${jobId}] TLABS beat ${i}: TRANSCRIPT-TIER accepted (score=${txMatch.score.toFixed(2)}, words=[${txMatch.matchedWords.slice(0, 5).join(",")}]) — ${txVv.reason || ""}`);
              } else {
                log?.(`[render ${jobId}] TLABS beat ${i}: transcript-tier (score=${txMatch.score.toFixed(2)}) rejected by vision — ${txVv?.reason || "no match"}`);
              }
            }
          } catch (txErr) {
            log?.(`[render ${jobId}] TLABS beat ${i}: transcript-tier error (non-fatal): ${txErr?.message}`);
          }
        }

        // Apply any match found by Tier 2 (audio) or Tier 3 (transcript).
        // This block mirrors the original fallback-verified accept above — the
        // only difference is it runs AFTER the new tiers, not before them.
        if (fallback) {
          const _fbS2 = Math.min(fallback.startSec, fallback.endSec);
          const _fbE2 = Math.max(fallback.startSec, fallback.endSec);
          outScenes[i] = {
            ...outScenes[i],
            startSec: _fbS2,
            endSec:   _fbE2,
            focusSec: fallback.center,
            reason: `${outScenes[i]?.reason || ""} [tlabs:${beatLog[i].match_source || "multi-tier"}]`,
          };
          beatLog[i].status = "accepted";
          beatLog[i].vision_verified = true;
          beatLog[i].vision_reason = fallback.visionReason;
          beatLog[i].video_start = _fbS2;
          beatLog[i].video_end   = _fbE2;
          beatLog[i].clip_duration = _fbE2 - _fbS2;
          log?.(`[render ${jobId}] TLABS beat ${i}: ACCEPTED (${beatLog[i].match_source || "multi-tier"}) center=${fallback.center.toFixed(1)}s`);
          sceneMemory.timestamp = fallback.center;
          if (vso.location) sceneMemory.location = vso.location;
          if (vso.characters?.length) sceneMemory.characters = vso.characters;
          if (vso.primaryAction) sceneMemory.primaryAction = vso.primaryAction;
          if (beatLog[i].chapter_match?.title) { sceneMemory.chapter = beatLog[i].chapter_match.title; sceneMemory.chapterStart = beatLog[i].chapter_match.start; sceneMemory.chapterEnd = beatLog[i].chapter_match.end; }
          sceneMemory.beatId = i; sceneMemory.narration = rawNarration;
          sceneMemory.nextExpectedNarration = i < beatTexts.length - 1 ? (String(beatTexts[i + 1] || "").slice(0, 150) || null) : null;
          beatLog[i].scene_memory_used = { beatId: sceneMemory.beatId, location: sceneMemory.location, chapter: sceneMemory.chapter, timestamp: sceneMemory.timestamp };
          sceneGraph.push({ beatId: i, timestamp: fallback.center, chapter: sceneMemory.chapter, location: sceneMemory.location, characters: [...(sceneMemory.characters || [])] });
          applied++;
          continue;
        }

        // ── TIER A: Soft-Accept ───────────────────────────────────────────────
        // All primary retrieval + fallback-window + audio + transcript tiers failed.
        // The vision model was strict (it should be by default). Re-check the best
        // visual candidates from primary search using a relaxed prompt — accept if
        // the clip is reasonably related rather than strictly matching.
        // Targets Category 3 beats: footage exists but vision threshold was too high.
        if (!fallback && bestRejectedCandidates.length > 0 && sourcePath) {
          // Deduplicate by center (±2s) and sort by score descending
          const dedupedCands = [];
          const seenCenters = [];
          for (const c of bestRejectedCandidates) {
            if (seenCenters.some((s) => Math.abs(c.center - s) < 2)) continue;
            seenCenters.push(c.center); dedupedCands.push(c);
          }
          dedupedCands.sort((a, b) => b.score - a.score);
          const aTop = dedupedCands.slice(0, 3);
          log?.(`[render ${jobId}] TLABS beat ${i}: TIER-A soft-accept — re-verifying ${aTop.length} candidate(s)`);
          try {
            const aVv = await verifyCandidatesWithVision({
              candidates: aTop, sourcePath, query: events.join(" | "),
              anthropicApiKey, jobId, beatIndex: i, log, maxCandidates: 3, softAccept: true,
            });
            if (aVv?.matched) {
              fallback = { ...aVv.candidate, visionReason: aVv.reason || null };
              beatLog[i].match_source = "soft-accept";
              log?.(`[render ${jobId}] TLABS beat ${i}: TIER-A soft-accept ACCEPTED ${aVv.candidate.startSec.toFixed(1)}-${aVv.candidate.endSec.toFixed(1)}s — ${aVv.reason || ""}`);
            } else {
              log?.(`[render ${jobId}] TLABS beat ${i}: TIER-A soft-accept rejected — ${aVv?.reason || "no match"}`);
            }
          } catch (aErr) {
            log?.(`[render ${jobId}] TLABS beat ${i}: TIER-A error (non-fatal): ${aErr?.message}`);
          }
        }
        // ── END TIER A ────────────────────────────────────────────────────────

        // ── TIER B: Query Simplification Retry ───────────────────────────────
        // All prior tiers failed. Try progressively simpler versions of the VSO
        // query to recover over-specified beats where the original query was too
        // complex for Marengo to match (e.g. "character X does Y in Z while
        // holding W"). Each level strips one dimension of specificity.
        // Targets Category 1 beats: over-specified queries with good footage.
        if (!fallback) {
          let simplifiedLevels;
          try { simplifiedLevels = await simplifyVisualQuery(vso, events, anthropicApiKey, log); }
          catch (se) { simplifiedLevels = []; log?.(`[render ${jobId}] TLABS beat ${i}: simplifyVisualQuery error: ${se?.message}`); }

          // Narrative-position sanity check for Tier B: if Claude's origCenter
          // is > 30% of film duration away from where beat i is expected to fall
          // narratively (i/N × srcDur), search near the narrative estimate instead.
          // This prevents a single misplaced beat from anchoring the chrono guard
          // at the wrong film position and blocking downstream beats (e.g. beat 1
          // placed at 3500s in a 6300s film when it should be at ~83s).
          const bNarrativePos = srcDur > 0 ? (i / Math.max(beatTexts.length - 1, 1)) * srcDur : origCenter;
          const bNarrativeDeviation = srcDur > 0 ? Math.abs(origCenter - bNarrativePos) / srcDur : 0;
          const bCenter = (srcDur > 0 && bNarrativeDeviation > 0.3) ? bNarrativePos : origCenter;
          if (srcDur > 0 && bNarrativeDeviation > 0.3) {
            log?.(`[render ${jobId}] TLABS beat ${i}: TIER-B origCenter deviation ${(bNarrativeDeviation * 100).toFixed(0)}% — searching narrativePos ${bNarrativePos.toFixed(0)}s instead of ${origCenter.toFixed(0)}s`);
          }

          for (const [level, sQuery] of (simplifiedLevels || [])) {
            if (fallback) break;
            log?.(`[render ${jobId}] TLABS beat ${i}: TIER-B level ${level}: "${sQuery.slice(0, 80)}"`);
            try {
              if (searchDelayMs > 0) await sleep(searchDelayMs);
              const bSpanLo = Math.max(0, bCenter - 300);
              const bSpanHi = bCenter + 300;
              const bResult = await searchBeatMoment({
                apiKey, indexId: indexEntry.indexId, videoId: indexEntry.videoId,
                query: sQuery, spanStart: bSpanLo, spanEnd: bSpanHi,
              });
              if (!bResult || bResult.noHits || bResult.outOfSpan) {
                log?.(`[render ${jobId}] TLABS beat ${i}: TIER-B level ${level} — no hits in span`);
                continue;
              }
              const bCands = bResult.candidates?.slice(0, 3) || [{ startSec: bResult.startSec, endSec: bResult.endSec, center: bResult.center, score: bResult.confidence }];
              // Normal verify first
              const bVv = sourcePath ? await verifyCandidatesWithVision({
                candidates: bCands, sourcePath, query: sQuery,
                anthropicApiKey, jobId, beatIndex: i, log, maxCandidates: 3,
              }) : null;
              if (bVv?.matched) {
                fallback = { ...bVv.candidate, visionReason: bVv.reason || null };
                beatLog[i].match_source = `simplified-l${level}`;
                log?.(`[render ${jobId}] TLABS beat ${i}: TIER-B level ${level} ACCEPTED — ${bVv.reason || ""}`);
              } else if (sourcePath) {
                // Soft-accept on the Tier B candidate too
                const bSoftVv = await verifyCandidatesWithVision({
                  candidates: [bCands[0]], sourcePath, query: sQuery,
                  anthropicApiKey, jobId, beatIndex: i, log, maxCandidates: 1, softAccept: true,
                });
                if (bSoftVv?.matched) {
                  fallback = { ...bCands[0], visionReason: bSoftVv.reason || null };
                  beatLog[i].match_source = `simplified-soft-l${level}`;
                  log?.(`[render ${jobId}] TLABS beat ${i}: TIER-B level ${level} soft-accept ACCEPTED — ${bSoftVv.reason || ""}`);
                } else {
                  log?.(`[render ${jobId}] TLABS beat ${i}: TIER-B level ${level} both normal+soft rejected — ${bSoftVv?.reason || "no match"}`);
                }
              }
            } catch (bErr) {
              log?.(`[render ${jobId}] TLABS beat ${i}: TIER-B level ${level} error (non-fatal): ${bErr?.message}`);
            }
          }
        }
        // ── END TIER B ────────────────────────────────────────────────────────

        // ── TIER C: Narrative-Position Best-Available Fallback ────────────────
        // All retrieval + simplification tiers exhausted. Run one final Marengo
        // search constrained to a narrative-position window: beat i should fall
        // roughly at i/N of the film. We allow ±25% of film duration slack so
        // beats with wildly wrong Claude windows can still be recovered, but we
        // avoid pulling clips from completely wrong sections (e.g. using end-act
        // footage for an opening scene or vice-versa).
        // Targets Category 2 beats: footage is in the film but outside the
        // ±300s primary search span.
        if (!fallback && srcDur > 0 && sourcePath) {
          const cQuery = (vso.primaryAction || events[0]?.split(" ").slice(0, 6).join(" ") || rawNarration.slice(0, 80)).trim();
          const narrativePos = (i / Math.max(beatTexts.length - 1, 1)) * srcDur;
          const cSpanLo = Math.max(0, narrativePos - srcDur * 0.25);
          const cSpanHi = Math.min(srcDur, narrativePos + srcDur * 0.25);
          log?.(`[render ${jobId}] TLABS beat ${i}: TIER-C narrative-pos search: "${cQuery.slice(0, 80)}" window=${cSpanLo.toFixed(0)}-${cSpanHi.toFixed(0)}s`);
          try {
            if (searchDelayMs > 0) await sleep(searchDelayMs);
            const cResult = await searchBeatMoment({
              apiKey, indexId: indexEntry.indexId, videoId: indexEntry.videoId,
              query: cQuery, spanStart: cSpanLo, spanEnd: cSpanHi,
            });
            if (cResult && !cResult.noHits && !cResult.outOfSpan) {
              const cCand = cResult.candidates?.[0] || { startSec: cResult.startSec, endSec: cResult.endSec, center: cResult.center, score: cResult.confidence };
              const cVv = await verifyCandidatesWithVision({
                candidates: [cCand], sourcePath, query: cQuery,
                anthropicApiKey, jobId, beatIndex: i, log, maxCandidates: 1, softAccept: true,
              });
              if (cVv?.matched) {
                fallback = { ...cCand, visionReason: cVv.reason || null };
                beatLog[i].match_source = "best-available";
                log?.(`[render ${jobId}] TLABS beat ${i}: TIER-C best-available ACCEPTED ${cCand.startSec.toFixed(1)}-${cCand.endSec.toFixed(1)}s — ${cVv.reason || ""}`);
              } else {
                log?.(`[render ${jobId}] TLABS beat ${i}: TIER-C best-available rejected — ${cVv?.reason || "no match"}`);
              }
            } else {
              log?.(`[render ${jobId}] TLABS beat ${i}: TIER-C full-film search — no hits`);
            }
          } catch (cErr) {
            log?.(`[render ${jobId}] TLABS beat ${i}: TIER-C error (non-fatal): ${cErr?.message}`);
          }
        }
        // ── END TIER C ────────────────────────────────────────────────────────

        // ── TIER D: CLIP ViT-B-32 Embedding Fallback ─────────────────────────
        // All Marengo / simplification tiers exhausted. As a last resort, query
        // the local CLIP ViT-B-32 sidecar (port 8788) for the nearest
        // semantically-matching frame from the analyze-phase frame extraction.
        // Unlike Marengo, CLIP searches ALL pre-embedded frames globally — no
        // temporal constraint — so it can recover beats whose footage is far
        // outside Claude's original time window or the ±300s chrono slack.
        // Frames are embedded during analyze when CLIP_SIDECAR_ENABLED=1.
        // Score gate: ViT-B-32/openai cosine similarity ≥ 0.18 (random movie
        // frames typically land at 0.10-0.15 against any movie narration text).
        if (!fallback && clipSidecarUrl && clipAnalyzeJobId) {
          try {
            log?.(`[render ${jobId}] TLABS beat ${i}: TIER-D CLIP search — "${rawNarration.slice(0, 80)}"`);
            const _clipAc = new AbortController();
            const _clipTimer = setTimeout(() => _clipAc.abort(), 10_000);
            let _clipBody = null;
            try {
              const _clipResp = await fetch(`${clipSidecarUrl}/match`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jobId: clipAnalyzeJobId, texts: [rawNarration.slice(0, 300)] }),
                signal: _clipAc.signal,
              });
              clearTimeout(_clipTimer);
              if (_clipResp.ok) _clipBody = await _clipResp.json();
            } catch (_clipFetchErr) {
              clearTimeout(_clipTimer);
              log?.(`[render ${jobId}] TLABS beat ${i}: TIER-D CLIP fetch error: ${_clipFetchErr?.message}`);
            }
            const _clipHit = _clipBody?.results?.[0];
            if (_clipHit && typeof _clipHit.score === "number" && _clipHit.score >= 0.18) {
              const _clipCenter = _clipHit.timeSec;
              const _clipHalfWin = 4;
              const _clipCand = {
                startSec: Math.max(0, _clipCenter - _clipHalfWin),
                endSec:   _clipCenter + _clipHalfWin,
                center:   _clipCenter,
                score:    _clipHit.score,
              };
              log?.(`[render ${jobId}] TLABS beat ${i}: TIER-D CLIP candidate center=${_clipCenter.toFixed(1)}s score=${_clipHit.score.toFixed(3)}`);
              if (sourcePath) {
                const _dVv = await verifyCandidatesWithVision({
                  candidates: [_clipCand], sourcePath,
                  query: events[0] || rawNarration.slice(0, 200),
                  anthropicApiKey, jobId, beatIndex: i, log, maxCandidates: 1, softAccept: true,
                });
                if (_dVv?.matched) {
                  fallback = { ..._clipCand, visionReason: _dVv.reason || null };
                  beatLog[i].match_source = "clip-tier";
                  log?.(`[render ${jobId}] TLABS beat ${i}: TIER-D CLIP ACCEPTED center=${_clipCenter.toFixed(1)}s — ${_dVv.reason || ""}`);
                } else {
                  log?.(`[render ${jobId}] TLABS beat ${i}: TIER-D CLIP rejected by vision — ${_dVv?.reason || "no match"}`);
                }
              } else {
                if (_clipHit.score >= 0.22) {
                  fallback = { ..._clipCand, visionReason: null };
                  beatLog[i].match_source = "clip-tier-nosrc";
                  log?.(`[render ${jobId}] TLABS beat ${i}: TIER-D CLIP soft-accepted (no sourcePath) score=${_clipHit.score.toFixed(3)}`);
                }
              }
            } else {
              log?.(`[render ${jobId}] TLABS beat ${i}: TIER-D CLIP score ${(_clipHit?.score ?? 0).toFixed(3)} below 0.18 threshold`);
            }
          } catch (_dErr) {
            log?.(`[render ${jobId}] TLABS beat ${i}: TIER-D CLIP error (non-fatal): ${_dErr?.message}`);
          }
        }
        // ── END TIER D ────────────────────────────────────────────────────────

        // ── Tier A/B/C/D quality guard ────────────────────────────────────────
        // All four fallback tiers bypass the primary-path chronological and
        // duplicate-window guards. Re-apply them here to prevent:
        //   (a) massive backward timeline jumps (films playing out-of-order)
        //   (b) the same clip window being reused for multiple beats
        //   (c) end-credits being accepted for non-final beats
        if (fallback) {
          const tc = fallback.center;
          const lastAcceptedTs = sceneGraph[sceneGraph.length - 1]?.timestamp;

          // (a) Chrono guard: allow up to 300s backward (flashbacks are real)
          //     but reject clips that jump back further than that.
          if (lastAcceptedTs !== undefined && tc < lastAcceptedTs - 300) {
            log?.(`[render ${jobId}] TLABS beat ${i}: TIER-ABC chrono-reject: ${tc.toFixed(1)}s jumped back ${(lastAcceptedTs - tc).toFixed(0)}s from last accepted ${lastAcceptedTs.toFixed(1)}s`);
            fallback = null;
          }

          // (b) Dup guard: reject if within 25s of any already-accepted clip center.
          if (fallback) {
            const dupHit = sceneGraph.find((n) => Math.abs(n.timestamp - tc) < 25);
            if (dupHit) {
              log?.(`[render ${jobId}] TLABS beat ${i}: TIER-ABC dup-reject: ${tc.toFixed(1)}s duplicates beat ${dupHit.beatId} at ${dupHit.timestamp.toFixed(1)}s`);
              fallback = null;
            }
          }

          // (c) End-credits guard: reject clips in the final 3% of the film for
          //     beats that aren't near the end of the narration.
          if (fallback && srcDur > 0 && i < beatTexts.length - 4 && tc > srcDur * 0.97) {
            log?.(`[render ${jobId}] TLABS beat ${i}: TIER-ABC credits-guard: ${tc.toFixed(1)}s is in final 3% of ${srcDur.toFixed(0)}s film`);
            fallback = null;
          }
        }
        // ── END Tier A/B/C/D quality guard ────────────────────────────────────

        // Apply any match found by Tier A (soft-accept), Tier B (simplified query),
        // or Tier C (narrative-position). Mirrors the same accept block above.
        if (fallback) {
          const _fbS3 = Math.min(fallback.startSec, fallback.endSec);
          const _fbE3 = Math.max(fallback.startSec, fallback.endSec);
          outScenes[i] = {
            ...outScenes[i],
            startSec: _fbS3,
            endSec:   _fbE3,
            focusSec: fallback.center,
            reason: `${outScenes[i]?.reason || ""} [tlabs:${beatLog[i].match_source || "last-resort"}]`,
          };
          beatLog[i].status = "accepted";
          beatLog[i].vision_verified = true;
          beatLog[i].vision_reason = fallback.visionReason;
          beatLog[i].video_start = _fbS3;
          beatLog[i].video_end   = _fbE3;
          beatLog[i].clip_duration = _fbE3 - _fbS3;
          log?.(`[render ${jobId}] TLABS beat ${i}: ACCEPTED (${beatLog[i].match_source}) center=${fallback.center.toFixed(1)}s`);
          sceneMemory.timestamp = fallback.center;
          if (vso.location) sceneMemory.location = vso.location;
          if (vso.characters?.length) sceneMemory.characters = vso.characters;
          if (vso.primaryAction) sceneMemory.primaryAction = vso.primaryAction;
          if (beatLog[i].chapter_match?.title) { sceneMemory.chapter = beatLog[i].chapter_match.title; sceneMemory.chapterStart = beatLog[i].chapter_match.start; sceneMemory.chapterEnd = beatLog[i].chapter_match.end; }
          sceneMemory.beatId = i; sceneMemory.narration = rawNarration;
          sceneMemory.nextExpectedNarration = i < beatTexts.length - 1 ? (String(beatTexts[i + 1] || "").slice(0, 150) || null) : null;
          beatLog[i].scene_memory_used = { beatId: sceneMemory.beatId, location: sceneMemory.location, chapter: sceneMemory.chapter, timestamp: sceneMemory.timestamp };
          sceneGraph.push({ beatId: i, timestamp: fallback.center, chapter: sceneMemory.chapter, location: sceneMemory.location, characters: [...(sceneMemory.characters || [])] });
          applied++;
          continue;
        }

        const kindToStatus = { "no-result": "no-result", "low-score": "rejected-low-score", "vision-no-match": "rejected-vision-no-match", protected: "rejected-protected", chronological: "rejected-chronological", duplicate: "rejected-duplicate" };
        beatLog[i].status = kindToStatus[lastRejection?.kind] || "rejected-vision-no-match";
        if (Number.isFinite(lastRejection?.confidence)) beatLog[i].confidence = lastRejection.confidence;
        if (Number.isFinite(lastRejection?.confidenceGap)) beatLog[i].confidence_gap = lastRejection.confidenceGap;
        if (lastRejection?.visionVerified !== undefined) beatLog[i].vision_verified = lastRejection.visionVerified;
        if (lastRejection?.visionReason) beatLog[i].vision_reason = lastRejection.visionReason;
        beatLog[i].rejection_reason = events.length > 1
          ? `all ${events.length} sub-events rejected — last: ${lastRejection?.reason || "no candidate matched"} (fallback window also unverified)`
          : (lastRejection?.reason || "no candidate matched") + " (fallback window also unverified)";
        rejected++;
        continue;
      }

      // ── Window expansion to cover narration duration ─────────────────────
      // Multi-event beats split the target width evenly across kept
      // sub-events (v1: no proportional weighting — see plan) so each
      // sub-clip gets a fair share of the beat's runtime instead of one
      // dominating. Single-event beats get perEventWidth === minWidth,
      // identical to the old formula.
      const minWidth = Math.max(minWindowSec, need * COVERAGE_TARGET);
      const perEventWidth = minWidth / kept.length;
      const expanded = kept.map((k) => {
        let finalStart = k.startSec;
        let finalEnd   = k.endSec;
        if (finalEnd - finalStart < perEventWidth) {
          const wantExtra  = perEventWidth - (finalEnd - finalStart);
          const roomBefore = finalStart - spanStart;
          const roomAfter  = spanEnd   - finalEnd;
          let growBefore   = Math.min(roomBefore, wantExtra / 2);
          let growAfter    = Math.min(roomAfter,  wantExtra / 2);
          const shortfall  = wantExtra - growBefore - growAfter;
          if (shortfall > 0.01) {
            growBefore = Math.min(roomBefore, growBefore + shortfall);
            growAfter  = Math.min(roomAfter,  wantExtra - growBefore);
          }
          finalStart -= growBefore;
          finalEnd   += growAfter;
        }
        return { ...k, startSec: finalStart, endSec: finalEnd };
      });
      // Sub-windows are only ever grown against the shared beat span, not
      // against each other — clamp any growth-induced overlap between
      // consecutive kept events back to their midpoint.
      for (let e = 1; e < expanded.length; e++) {
        if (expanded[e].startSec < expanded[e - 1].endSec) {
          const mid = (expanded[e].startSec + expanded[e - 1].endSec) / 2;
          expanded[e - 1].endSec = mid;
          expanded[e].startSec = mid;
        }
      }

      const finalStart = expanded[0].startSec;
      const finalEnd   = expanded[expanded.length - 1].endSec;
      const finalCenter = expanded[expanded.length - 1].center;
      const multi = expanded.length > 1;
      const allVisionVerified = expanded.every((k) => k.visionVerified);
      // Reversed-window guard: TL occasionally returns candidates with startSec > endSec.
      // Swap here so timeline assembly always gets a valid non-negative window.
      const _finalStart = Math.min(finalStart, finalEnd);
      const _finalEnd   = Math.max(finalStart, finalEnd);

      outScenes[i] = {
        ...outScenes[i],
        startSec: _finalStart,
        endSec:   _finalEnd,
        focusSec: finalCenter,
        reason: `${outScenes[i]?.reason || ""} [tlabs:s${expanded[0].confidence.toFixed(2)}g${(expanded[0].confidenceGap || 0).toFixed(2)}v${allVisionVerified ? 1 : 0}${multi ? `multi${expanded.length}` : ""}]`,
        ...(multi ? { subWindows: expanded.map((k) => ({ startSec: k.startSec, endSec: k.endSec, center: k.center })) } : {}),
      };
      log?.(`[render ${jobId}] TLABS beat ${i}: ACCEPTED ${multi ? `${expanded.length} sub-events` : `score=${expanded[0].confidence.toFixed(3)}`} center=${finalCenter.toFixed(1)}s visionVerified=${allVisionVerified}`);
      beatLog[i].status = "accepted";
      beatLog[i].confidence = expanded[0].confidence;
      beatLog[i].confidence_gap = expanded[0].confidenceGap;
      beatLog[i].video_start = _finalStart;
      beatLog[i].video_end   = _finalEnd;
      beatLog[i].clip_duration = _finalEnd - _finalStart;
      beatLog[i].vision_verified = allVisionVerified;
      if (multi) {
        beatLog[i].subEvents = expanded.map((k) => ({ eventIndex: k.eventIndex, query: k.query, startSec: k.startSec, endSec: k.endSec, center: k.center, confidence: k.confidence, visionVerified: k.visionVerified, visionReason: k.visionReason || null }));
      }
      // Update Scene Memory Engine with this accepted beat (Upgrades 1-5)
      sceneMemory.timestamp = finalCenter;
      if (vso.location) sceneMemory.location = vso.location;
      if (vso.characters?.length) sceneMemory.characters = vso.characters;
      if (vso.primaryAction) sceneMemory.primaryAction = vso.primaryAction;
      if (beatLog[i].chapter_match?.title) { sceneMemory.chapter = beatLog[i].chapter_match.title; sceneMemory.chapterStart = beatLog[i].chapter_match.start; sceneMemory.chapterEnd = beatLog[i].chapter_match.end; }
      sceneMemory.beatId = i; sceneMemory.narration = rawNarration;
      sceneMemory.nextExpectedNarration = i < beatTexts.length - 1 ? (String(beatTexts[i + 1] || "").slice(0, 150) || null) : null;
      beatLog[i].scene_memory_used = { beatId: sceneMemory.beatId, location: sceneMemory.location, chapter: sceneMemory.chapter, timestamp: sceneMemory.timestamp };
      sceneGraph.push({ beatId: i, timestamp: finalCenter, chapter: sceneMemory.chapter, location: sceneMemory.location, characters: [...(sceneMemory.characters || [])] });
      applied++;
    } catch (e) {
      failed++;
      beatLog[i].status = "failed";
      beatLog[i].rejection_reason = e?.message || String(e);
      log?.(`[render ${jobId}] TLABS beat ${i} failed: ${e?.message || e}`);
    }
  }

  // Mark any remaining beats (past maxBeats budget) as budget-exceeded
  for (let i = 0; i < beatLog.length; i++) {
    if (beatLog[i].status === "not-attempted" && attempted >= maxBeats) {
      beatLog[i].status = "budget-exceeded";
    }
  }

  // ── TIMELINE VALIDATOR (Upgrade 13) ────────────────────────────────────
  // Validates the accepted beat set for consistency issues. Never aborts —
  // logs warnings and lets the render continue. Issues are informational
  // and help diagnose remaining retrieval problems without breaking output.
  {
    const _accepted = beatLog.filter((b) => b.status === "accepted" && b.video_start != null);
    const _tvIssues = [];
    const _usedWindows = new Map();
    for (const b of _accepted) {
      const key = Math.round((b.video_start || 0) / 5) * 5;
      if (_usedWindows.has(key)) _tvIssues.push(`dup-clip: beats ${_usedWindows.get(key)}&${b.beat_id} ~${key}s`);
      else _usedWindows.set(key, b.beat_id);
    }
    for (let vi = 1; vi < _accepted.length; vi++) {
      const prev = _accepted[vi - 1], curr = _accepted[vi];
      if ((curr.video_start || 0) < (prev.video_start || 0) - 30)
        _tvIssues.push(`out-of-order: beat ${curr.beat_id}(${(curr.video_start||0).toFixed(0)}s)<beat ${prev.beat_id}(${(prev.video_start||0).toFixed(0)}s)`);
      if ((prev.video_end || 0) > (curr.video_start || 0) + 0.5)
        _tvIssues.push(`overlap: beat ${prev.beat_id} ends ${(prev.video_end||0).toFixed(0)}s, beat ${curr.beat_id} starts ${(curr.video_start||0).toFixed(0)}s`);
    }
    if (_tvIssues.length) {
      log?.(`[render ${jobId}] TIMELINE-VALIDATOR: ${_tvIssues.length} issue(s): ${_tvIssues.slice(0, 8).join(" | ")}`);
    } else {
      log?.(`[render ${jobId}] TIMELINE-VALIDATOR: ${_accepted.length} accepted beats — OK`);
    }
  }
  // ── END TIMELINE VALIDATOR ────────────────────────────────────────────

  log?.(
    `[render ${jobId}] TLABS: attempted=${attempted}, applied=${applied}, ` +
    `rejected=${rejected}, failed=${failed}, skipped=${skipped} | ` +
    `VSO: built=${vsoBuilt}, fallback=${vsoFallback} | ` +
    `SceneGraph: ${sceneGraph.length} nodes | ` +
    `SceneMemory: loc=${sceneMemory.location || "none"}, chars=${(sceneMemory.characters||[]).length}`
  );
  return { scenes: outScenes, stats: { attempted, applied, rejected, failed, skipped }, beatLog };
}

export function isTwelveLabsEnabled() {
  const key = (process.env.TWELVELABS_API_KEY || "").trim();
  const enabled = String(process.env.TWELVELABS_ENABLED ?? "1").toLowerCase();
  return Boolean(key) && enabled !== "0" && enabled !== "false";
}

// ── PEGASUS CHAPTER DETECTION ─────────────────────────────────────────────────
// Pegasus is Twelve Labs' generative model that understands video narrative and
// produces chapter-level timestamps. We create a separate shared Pegasus index
// alongside the existing Marengo index (no re-upload — same assetId reused),
// then call the /generate endpoint to get chapter boundaries. These boundaries
// let us rebase beat windows that Claude mistakenly anchored in the opening
// credits section to the correct story chapters.

async function ensureSharedPegasusIndex(client, apiKey, cacheDir, log) {
  const global = await loadGlobalIndex(cacheDir);
  if (global?.pegasusIndexId) return global.pegasusIndexId;

  log?.("Twelve Labs Pegasus: creating shared Pegasus index…");
  const created = await client.indexes.create({
    indexName: `cinerecap-pegasus-${createHash("sha256").update(apiKey.slice(0, 8)).digest("hex").slice(0, 8)}`,
    models: [{ modelName: "pegasus1.2", modelOptions: ["visual", "audio"] }],
  });
  const pegasusIndexId = created?.id;
  if (!pegasusIndexId) throw new Error("Pegasus index create returned no id");
  await saveGlobalIndex(cacheDir, { ...global, pegasusIndexId, pegasusCreatedAt: Date.now() });
  log?.(`Twelve Labs Pegasus: shared Pegasus index ready (${pegasusIndexId})`);
  return pegasusIndexId;
}

/**
 * Ensure the movie asset is indexed with Pegasus (for chapter generation).
 * Uses the existing assetId from the Marengo cache — no re-upload required.
 * Runs as a background sidecar: call without await to avoid blocking the render.
 * Returns the cache entry {pegasusIndexId, pegasusVideoId} or null on failure.
 */
export async function ensurePegasusIndexed({ apiKey, cacheDir, fileId, assetId, log }) {
  if (!apiKey || !assetId) return null;
  const cacheKey = `${fileId}-pegasus`;
  try {
    const cached = await loadCache(cacheDir, cacheKey);
    if (cached?.pegasusIndexId && cached?.pegasusVideoId) {
      log?.(`Twelve Labs Pegasus: cache hit for ${fileId}`);
      return cached;
    }
    const client = createClient(apiKey);
    const pegasusIndexId = await ensureSharedPegasusIndex(client, apiKey, cacheDir, log);

    const existing = await findIndexedAssetsForAssetInIndex(client, pegasusIndexId, assetId);
    const target = pickIndexingTarget(existing);
    let pegasusIndexedAssetId;

    if (target?.mode === "ready") {
      log?.(`Twelve Labs Pegasus: reusing ready Pegasus entry for asset ${assetId}`);
      pegasusIndexedAssetId = target.indexedAsset.id;
    } else if (target?.mode === "wait") {
      log?.(`Twelve Labs Pegasus: waiting on in-progress Pegasus indexing…`);
      await waitForIndexedAsset(client, pegasusIndexId, target.indexedAsset.id, log, 90 * 60 * 1000);
      pegasusIndexedAssetId = target.indexedAsset.id;
    } else {
      log?.("Twelve Labs Pegasus: indexing asset with Pegasus (no re-upload)…");
      const indexed = await client.indexes.indexedAssets.create(pegasusIndexId, { assetId });
      pegasusIndexedAssetId = indexed?.id;
      if (!pegasusIndexedAssetId) throw new Error("Pegasus indexed-asset create returned no id");
      log?.("Twelve Labs Pegasus: indexing (this runs in background — chapters ready next render)…");
      await waitForIndexedAsset(client, pegasusIndexId, pegasusIndexedAssetId, log, 90 * 60 * 1000);
    }

    const pegasusVideoId = (await resolveVideoId(client, pegasusIndexId, assetId, log)) || pegasusIndexedAssetId;
    const entry = { pegasusIndexId, pegasusVideoId, pegasusIndexedAssetId, assetId, indexedAt: Date.now() };
    await saveCache(cacheDir, cacheKey, entry);
    log?.(`Twelve Labs Pegasus: index entry ready (videoId=${pegasusVideoId})`);
    return entry;
  } catch (err) {
    log?.(`Twelve Labs Pegasus: indexing failed (${err?.message}) — chapters unavailable this render`);
    return null;
  }
}

/**
 * Fetch chapter timestamps for a Pegasus-indexed video.
 * Uses client.analyze() (the /v1.3/analyze endpoint) with a structured prompt,
 * then parses the text response for chapter timestamps.
 * Returns [{number, title, summary, start, end}] or null on failure.
 */
/**
 * splitAndIndexWithPegasus — Pegasus chapter detection for feature-length films.
 *
 * Pegasus has a hard 60-minute duration limit, so films > 3600s cannot be
 * indexed directly. This function works around that by:
 *   1. FFmpeg-splitting the source at the midpoint (-c copy, ~30s, no re-encode)
 *   2. Uploading each half to Twelve Labs as separate assets
 *   3. Adding each half to the shared Pegasus index and waiting for indexing
 *   4. Fetching chapters for each half, then offsetting Part 2 timestamps by
 *      the split point so all chapter times are in original-movie coordinates
 *   5. Merging + sorting the two chapter lists and caching the result
 *   6. Cleaning up the intermediate split files (they are large)
 *
 * Designed to be called fire-and-forget during the analyze step (parallel with
 * Claude analysis) so chapters are ready in cache by the time the user taps
 * Render. The render step reads the cache directly and never blocks on upload.
 *
 * @returns {Array|null} combined chapter array or null on failure
 */
export async function splitAndIndexWithPegasus({ apiKey, cacheDir, fileId, filePath, duration, log }) {
  if (!apiKey || !filePath) return null;

  // 1. Check combined chapters cache — return immediately if already done
  const splitCachePath = path.join(cacheDir, `${fileId}-pegasus-split.json`);
  try {
    const cached = JSON.parse(await fs.readFile(splitCachePath, "utf8"));
    if (Array.isArray(cached?.combinedChapters) && cached.combinedChapters.length > 0) {
      log?.(`PEGASUS-SPLIT: ${cached.combinedChapters.length} chapters from cache`);
      return cached.combinedChapters;
    }
  } catch {}

  const splitPoint = Math.floor(duration / 2);

  // 2. FFmpeg split (-c copy = fast stream copy, no re-encode, ~30s for a 3GB film)
  const part1Path = path.join(cacheDir, `${fileId}-split-part1.mp4`);
  const part2Path = path.join(cacheDir, `${fileId}-split-part2.mp4`);

  log?.(`PEGASUS-SPLIT: splitting at ${splitPoint}s (~${(splitPoint / 60).toFixed(1)} min)…`);
  // Part 1: from 0 to splitPoint; Part 2: from splitPoint to end.
  // Use -ss before -i for Part 2 so ffmpeg keyframe-seeks instead of decoding the whole file.
  await Promise.all([
    runFfmpeg(["-y", "-i", filePath, "-t", String(splitPoint), "-c", "copy", part1Path]),
    runFfmpeg(["-y", "-ss", String(splitPoint), "-i", filePath, "-c", "copy", part2Path]),
  ]);
  log?.("PEGASUS-SPLIT: split complete — uploading both halves to Twelve Labs…");

  // 3. Upload + Pegasus-index each part, collect offset chapters
  const client = createClient(apiKey);
  const pegasusIndexId = await ensureSharedPegasusIndex(client, apiKey, cacheDir, log);

  async function indexOnePart(partPath, partLabel, offsetSec) {
    const partFileId = `${fileId}-split-${partLabel}`;
    const partLog = (msg) => log?.(`PEGASUS-SPLIT [${partLabel}]: ${msg}`);
    try {
      const assetId = await uploadAsset(client, partPath, partLog);
      await waitForAssetReady(client, assetId, partLog);
      partLog(`uploaded (assetId=${assetId})`);

      const indexedAssetId = await ensureIndexingForAsset({
        client, indexId: pegasusIndexId, assetId,
        fileId: partFileId, fingerprint: partFileId,
        cacheDir, log: partLog,
        pollMax: 90 * 60 * 1000, // 90 min max per part
      });
      partLog(`indexed (indexedAssetId=${indexedAssetId})`);

      const videoId = (await resolveVideoId(client, pegasusIndexId, assetId, partLog)) || indexedAssetId;
      const chapters = await getPegasusChapters({ apiKey, videoId, cacheDir, fileId: partFileId, log: partLog });
      if (!chapters?.length) { partLog("no chapters returned"); return []; }

      // Offset all timestamps into original-movie coordinates
      return chapters.map((c) => ({ ...c, start: c.start + offsetSec, end: c.end + offsetSec }));
    } catch (err) {
      partLog(`failed: ${err?.message}`);
      return [];
    }
  }

  // Parts can upload and index concurrently — they are different assets in the same index
  const [part1Chapters, part2Chapters] = await Promise.all([
    indexOnePart(part1Path, "part1", 0),
    indexOnePart(part2Path, "part2", splitPoint),
  ]);

  const combinedChapters = [...part1Chapters, ...part2Chapters]
    .sort((a, b) => a.start - b.start)
    .map((c, i) => ({ ...c, number: i }));

  log?.(`PEGASUS-SPLIT: ${combinedChapters.length} combined chapters (part1=${part1Chapters.length}, part2=${part2Chapters.length})`);

  // 4. Cache combined chapters for render-time use
  if (combinedChapters.length > 0) {
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        splitCachePath,
        JSON.stringify({ splitPoint, combinedChapters, cachedAt: Date.now() }, null, 2),
        "utf8",
      );
    } catch (e) {
      log?.(`PEGASUS-SPLIT: cache write failed (non-fatal): ${e?.message}`);
    }
  }

  // 5. Delete split files — large intermediates no longer needed after TL upload
  await Promise.all([fs.unlink(part1Path).catch(() => {}), fs.unlink(part2Path).catch(() => {})]);

  return combinedChapters.length > 0 ? combinedChapters : null;
}

export async function getPegasusChapters({ apiKey, videoId, cacheDir, fileId, log }) {
  if (!apiKey || !videoId) return null;
  const cacheKey = `${fileId}-pegasus-chapters`;
  try {
    const cached = await loadCache(cacheDir, cacheKey);
    if (Array.isArray(cached?.chapters) && cached.chapters.length > 0) {
      log?.(`Twelve Labs Pegasus: chapters cache hit (${cached.chapters.length} chapters)`);
      return cached.chapters;
    }
  } catch {}

  try {
    log?.("Twelve Labs Pegasus: generating chapter timestamps via client.analyze…");
    const client = createClient(apiKey);

    // Structured prompt — Pegasus returns plain text; we parse pipe-delimited lines.
    const prompt = [
      "Identify all major chapters or story sections of this video.",
      "For each chapter output exactly one line with no other text, no headers, no numbering:",
      "START_SEC|END_SEC|CHAPTER_TITLE|ONE_SENTENCE_SUMMARY",
      "where START_SEC and END_SEC are whole-number seconds.",
      "The first chapter should start at 0. Cover the entire video duration.",
    ].join(" ");

    // client.analyze returns { data: "complete generated text string" }
    const result = await client.analyze({ videoId, prompt });
    const text = result?.data || "";

    if (!text) {
      log?.("Twelve Labs Pegasus: no text in analyze response");
      return null;
    }

    // Parse lines: START_SEC|END_SEC|TITLE|SUMMARY
    const chapters = [];
    for (const line of String(text).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes("|")) continue;
      const parts = trimmed.split("|");
      if (parts.length < 3) continue;
      const start = parseFloat(parts[0]);
      const end   = parseFloat(parts[1]);
      if (isNaN(start) || isNaN(end) || end <= start) continue;
      chapters.push({
        number:  chapters.length,
        title:   (parts[2] || `Chapter ${chapters.length + 1}`).trim(),
        summary: (parts[3] || "").trim(),
        start,
        end,
      });
    }

    if (chapters.length === 0) {
      log?.(`Twelve Labs Pegasus: no parseable chapters in response (raw: ${String(text).slice(0, 300)})`);
      return null;
    }

    log?.(`Twelve Labs Pegasus: ${chapters.length} chapters — ${chapters.map((c) => `"${c.title}" (${c.start.toFixed(0)}-${c.end.toFixed(0)}s)`).join(", ")}`);
    if (cacheDir && fileId) {
      await saveCache(cacheDir, cacheKey, { chapters, fetchedAt: Date.now() }).catch(() => {});
    }
    return chapters;
  } catch (err) {
    log?.(`Twelve Labs Pegasus: chapter fetch failed (${err?.message})`);
    return null;
  }
}
