/**
 * Twelve Labs Marengo integration — index movie once, search per beat.
 * Uses the official twelvelabs-js SDK for upload/index/search (multipart handled by SDK).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
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
 * Search narration text against indexed movie. Returns best match or null.
 */
export async function searchBeatMoment({ apiKey, indexId, videoId, narration, spanStart, spanEnd }) {
  const query = String(narration || "").trim().slice(0, 1800);
  if (!query) return null;

  const client = createClient(apiKey);
  const pager = await client.search.query({
    indexId,
    queryText: query,
    searchOptions: ["visual", "audio", "transcription"],
    operator: "or",
    pageLimit: 8,
    groupBy: "clip",
    ...(videoId ? { filter: JSON.stringify({ id: [videoId] }) } : {}),
  });

  const hits = [];
  for await (const hit of pager) {
    hits.push(hit);
    if (hits.length >= 8) break;
  }
  if (!hits.length) return null;

  const spanLo = Number(spanStart) || 0;
  const spanHi = Number(spanEnd) || Number.POSITIVE_INFINITY;

  for (const hit of hits) {
    const start = Number(hit.start);
    const end = Number(hit.end);
    const rank = Number(hit.rank) || 99;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const center = (start + end) / 2;
    if (center < spanLo - 2 || center > spanHi + 2) continue;
    return { startSec: start, endSec: end, rank, center, confidence: Math.max(0.4, 1 - (rank - 1) * 0.12) };
  }
  return null;
}

/**
 * Per-beat visual localization via Twelve Labs text search.
 */
export async function localizeBeatsWithTwelveLabs({
  jobId,
  apiKey,
  indexEntry,
  beatTexts,
  voDurs,
  scenes,
  protectedVisualBeats,
  srcDur,
  log,
}) {
  const maxBeats = Math.max(0, Number(process.env.TWELVELABS_MAX_BEATS) || scenes.length);
  const maxRank = Math.max(1, Number(process.env.TWELVELABS_MAX_RANK) || 6);
  const minWindowSec = Math.max(6, Number(process.env.TWELVELABS_MIN_WINDOW_SEC) || 8);
  const protectMaxReloc = Math.max(15, Number(process.env.TWELVELABS_PROTECT_MAX_RELOC_SEC) || 90);
  const chronoSlackSec = Math.max(0, Number(process.env.TWELVELABS_CHRONO_SLACK_SEC) || 15);
  const COVERAGE_TARGET = 1.2;
  const MAX_SPAN_SEC = 300;

  const _preSpanScenes = scenes.map((sc) => ({ ...sc }));
  let attempted = 0, applied = 0, rejected = 0, failed = 0, skipped = 0;
  const outScenes = scenes.map((sc) => ({ ...sc }));
  const searchDelayMs = Math.max(0, Number(process.env.TWELVELABS_SEARCH_DELAY_MS) || 250);

  for (let i = 0; i < outScenes.length && attempted < maxBeats; i++) {
    const isProtected = protectedVisualBeats[i];
    const prevStart = i > 0 ? Number(_preSpanScenes[i - 1].startSec) : 0;
    const nextEnd = i < _preSpanScenes.length - 1
      ? Number(_preSpanScenes[i + 1].endSec)
      : (srcDur || Number(_preSpanScenes[i].endSec) + 60);
    let spanStart = Math.max(0, Math.min(prevStart, Number(_preSpanScenes[i].startSec)));
    let spanEnd = Math.max(nextEnd, Number(_preSpanScenes[i].endSec));
    if (spanEnd - spanStart > MAX_SPAN_SEC) {
      const mid = (Number(_preSpanScenes[i].startSec) + Number(_preSpanScenes[i].endSec)) / 2;
      spanStart = Math.max(spanStart, mid - MAX_SPAN_SEC / 2);
      spanEnd = Math.min(spanEnd, mid + MAX_SPAN_SEC / 2);
    }

    const need = Math.max(minWindowSec, Number(voDurs[i]) || 0);
    if (!(spanEnd - spanStart >= Math.min(need, 4))) { skipped++; continue; }

    attempted++;
    try {
      if (searchDelayMs > 0 && attempted > 1) await sleep(searchDelayMs);
      const v = await searchBeatMoment({
        apiKey,
        indexId: indexEntry.indexId,
        videoId: indexEntry.videoId,
        narration: beatTexts[i],
        spanStart,
        spanEnd,
      });
      if (!v) { rejected++; continue; }
      if (v.rank > maxRank) {
        log?.(`[render ${jobId}] TLABS beat ${i}: rank ${v.rank} > max ${maxRank} — rejected`);
        rejected++;
        continue;
      }

      const center = v.center;
      if (isProtected) {
        const origCenter = (Number(_preSpanScenes[i].startSec) + Number(_preSpanScenes[i].endSec)) / 2;
        if (Math.abs(center - origCenter) > protectMaxReloc) {
          log?.(`[render ${jobId}] TLABS beat ${i}: protected relocation ${Math.abs(center - origCenter).toFixed(1)}s — rejected`);
          rejected++;
          continue;
        }
      }
      // Compare to previous beat's footage position (Claude or TL), not last TL-only accept.
      const prevCenter = i > 0
        ? (Number(outScenes[i - 1].focusSec)
          || (Number(outScenes[i - 1].startSec) + Number(outScenes[i - 1].endSec)) / 2)
        : 0;
      if (center < prevCenter - chronoSlackSec) {
        log?.(`[render ${jobId}] TLABS beat ${i}: chronological guard (${center.toFixed(1)}s < prev ${prevCenter.toFixed(1)}s) — rejected`);
        rejected++;
        continue;
      }

      let finalStart = v.startSec;
      let finalEnd = v.endSec;
      const minWidth = Math.max(minWindowSec, need * COVERAGE_TARGET);
      if (finalEnd - finalStart < minWidth) {
        const wantExtra = minWidth - (finalEnd - finalStart);
        const roomBefore = finalStart - spanStart;
        const roomAfter = spanEnd - finalEnd;
        let growBefore = Math.min(roomBefore, wantExtra / 2);
        let growAfter = Math.min(roomAfter, wantExtra / 2);
        const shortfall = wantExtra - growBefore - growAfter;
        if (shortfall > 0.01) {
          growBefore = Math.min(roomBefore, growBefore + shortfall);
          growAfter = Math.min(roomAfter, wantExtra - growBefore);
        }
        finalStart -= growBefore;
        finalEnd += growAfter;
      }

      outScenes[i] = {
        ...outScenes[i],
        startSec: finalStart,
        endSec: finalEnd,
        focusSec: center,
        reason: `${outScenes[i]?.reason || ""} [tlabs:r${v.rank}]`,
      };
      applied++;
    } catch (e) {
      failed++;
      log?.(`[render ${jobId}] TLABS beat ${i} failed: ${e?.message || e}`);
    }
  }

  log?.(`[render ${jobId}] TLABS: attempted=${attempted}, applied=${applied}, rejected=${rejected}, failed=${failed}, skipped=${skipped}`);
  return { scenes: outScenes, stats: { attempted, applied, rejected, failed, skipped } };
}

export function isTwelveLabsEnabled() {
  const key = (process.env.TWELVELABS_API_KEY || "").trim();
  const enabled = String(process.env.TWELVELABS_ENABLED ?? "1").toLowerCase();
  return Boolean(key) && enabled !== "0" && enabled !== "false";
}
