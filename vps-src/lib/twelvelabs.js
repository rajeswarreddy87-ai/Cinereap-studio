/**
 * Twelve Labs Marengo integration — index movie once, search per beat.
 * Replaces GSPAN (Gemini span-localization) and SigLIP/CLIP for visual matching.
 */
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const API_BASE = process.env.TWELVELABS_API_BASE || "https://api.twelvelabs.io/v1.3";
const DIRECT_UPLOAD_MAX = 200 * 1024 * 1024; // 200 MB
const MULTIPART_UPLOAD_MAX = 4 * 1024 * 1024 * 1024; // 4 GB
const POLL_INTERVAL_MS = 5000;
const INDEX_POLL_MAX_MS = 45 * 60 * 1000; // 45 min for long films
const UPLOAD_CONCURRENCY = 4;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiJson(apiKey, method, endpoint, body = null) {
  const resp = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: {
      "x-api-key": apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await resp.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const msg = data?.message || data?.code || text.slice(0, 200) || resp.statusText;
    throw new Error(`TwelveLabs ${method} ${endpoint}: HTTP ${resp.status} — ${msg}`);
  }
  return data;
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

async function ensureSharedIndex(apiKey, cacheDir, log) {
  const envIndex = (process.env.TWELVELABS_INDEX_ID || "").trim();
  if (envIndex) return envIndex;

  const global = await loadGlobalIndex(cacheDir);
  if (global?.indexId) return global.indexId;

  log?.("Twelve Labs: creating shared Marengo index…");
  const created = await apiJson(apiKey, "POST", "/indexes", {
    index_name: `cinerecap-${createHash("sha256").update(apiKey.slice(0, 8)).digest("hex").slice(0, 8)}`,
    models: [{ model_name: "marengo3.0", model_options: ["visual", "audio"] }],
  });
  const indexId = created?._id || created?.id;
  if (!indexId) throw new Error("TwelveLabs index create returned no id");
  await saveGlobalIndex(cacheDir, { indexId, createdAt: Date.now() });
  log?.(`Twelve Labs: shared index ready (${indexId})`);
  return indexId;
}

async function waitForAssetReady(apiKey, assetId, log, maxMs = INDEX_POLL_MAX_MS) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const asset = await apiJson(apiKey, "GET", `/assets/${assetId}`);
    if (asset?.status === "ready") return asset;
    if (asset?.status === "failed") throw new Error(`TwelveLabs asset ${assetId} failed`);
    log?.(`Twelve Labs: asset processing (${asset?.status || "pending"})…`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`TwelveLabs asset ${assetId} timed out`);
}

async function uploadDirect(apiKey, filePath, filename, log) {
  log?.("Twelve Labs: direct upload (<200MB)…");
  const form = new FormData();
  form.append("method", "direct");
  form.append("file", new Blob([await fs.readFile(filePath)]), filename);
  const resp = await fetch(`${API_BASE}/assets`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(600_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`TwelveLabs direct upload: HTTP ${resp.status} — ${data?.message || ""}`);
  return data?._id || data?.id;
}

async function readChunk(filePath, offset, length) {
  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function uploadMultipart(apiKey, filePath, filename, totalSize, log) {
  log?.(`Twelve Labs: multipart upload (${(totalSize / 1e9).toFixed(2)} GB)…`);
  const session = await apiJson(apiKey, "POST", "/assets/multipart-uploads", {
    filename,
    type: "video",
    total_size: totalSize,
  });
  const uploadId = session.upload_id;
  const assetId = session.asset_id;
  const chunkSize = session.chunk_size;
  const totalChunks = session.total_chunks;
  if (!uploadId || !assetId || !chunkSize) throw new Error("TwelveLabs multipart session missing fields");

  const urlMap = new Map((session.upload_urls || []).map((u) => [u.chunk_index, u.url]));
  const completed = [];

  // Initial response often includes only the first ~10 URLs — fetch the rest
  // using start/count (max 50 per call), not chunk_indexes.
  async function fetchPresignedUrls(start, count) {
    const extra = await apiJson(apiKey, "POST", `/assets/multipart-uploads/${uploadId}/presigned-urls`, {
      start,
      count,
    });
    for (const u of extra?.upload_urls || []) {
      if (u?.chunk_index && u?.url) urlMap.set(u.chunk_index, u.url);
    }
  }

  const initialMax = urlMap.size > 0 ? Math.max(...urlMap.keys()) : 0;
  if (totalChunks > initialMax) {
    log?.(`Twelve Labs: requesting presigned URLs for chunks ${initialMax + 1}–${totalChunks}…`);
    for (let start = initialMax + 1; start <= totalChunks; start += 50) {
      const count = Math.min(50, totalChunks - start + 1);
      await fetchPresignedUrls(start, count);
    }
  }

  async function ensureUrl(chunkIndex) {
    if (urlMap.has(chunkIndex)) return urlMap.get(chunkIndex);
    await fetchPresignedUrls(chunkIndex, 1);
    return urlMap.get(chunkIndex);
  }

  async function uploadOne(chunkIndex) {
    const offset = (chunkIndex - 1) * chunkSize;
    const len = Math.min(chunkSize, totalSize - offset);
    const data = await readChunk(filePath, offset, len);
    const url = await ensureUrl(chunkIndex);
    if (!url) throw new Error(`TwelveLabs missing presigned URL for chunk ${chunkIndex}`);
    const resp = await fetch(url, {
      method: "PUT",
      body: data,
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) throw new Error(`TwelveLabs chunk ${chunkIndex} upload failed: HTTP ${resp.status}`);
    const etag = resp.headers.get("etag") || resp.headers.get("ETag") || "";
    return { chunk_index: chunkIndex, proof: etag.replace(/"/g, ""), proof_type: "etag", chunk_size: len };
  }

  const pending = [];
  for (let i = 1; i <= totalChunks; i++) pending.push(i);

  while (pending.length > 0) {
    const batch = pending.splice(0, UPLOAD_CONCURRENCY);
    const results = await Promise.all(batch.map(uploadOne));
    completed.push(...results);
    await apiJson(apiKey, "POST", `/assets/multipart-uploads/${uploadId}`, {
      completed_chunks: results,
    });
    if (completed.length % 10 === 0 || completed.length === totalChunks) {
      log?.(`Twelve Labs: uploaded ${completed.length}/${totalChunks} chunks`);
    }
    nextBatchStart += batch.length;
  }

  const start = Date.now();
  while (Date.now() - start < INDEX_POLL_MAX_MS) {
    const status = await apiJson(apiKey, "GET", `/assets/multipart-uploads/${uploadId}`);
    if (status?.status === "completed") return assetId;
    if (status?.status === "failed") throw new Error("TwelveLabs multipart upload failed");
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("TwelveLabs multipart upload timed out");
}

async function uploadAsset(apiKey, filePath, log) {
  const st = await fs.stat(filePath);
  const filename = path.basename(filePath);
  if (st.size > MULTIPART_UPLOAD_MAX) {
    throw new Error(`File ${(st.size / 1e9).toFixed(2)} GB exceeds TwelveLabs 4GB limit`);
  }
  if (st.size <= DIRECT_UPLOAD_MAX) {
    try {
      return await uploadDirect(apiKey, filePath, filename, log);
    } catch (e) {
      log?.(`Twelve Labs: direct upload failed (${e.message}) — trying multipart`);
    }
  }
  return uploadMultipart(apiKey, filePath, filename, st.size, log);
}

async function waitForIndexedAsset(apiKey, indexId, indexedAssetId, log) {
  const start = Date.now();
  while (Date.now() - start < INDEX_POLL_MAX_MS) {
    const ia = await apiJson(apiKey, "GET", `/indexes/${indexId}/indexed-assets/${indexedAssetId}`);
    if (ia?.status === "ready") return ia;
    if (ia?.status === "failed") throw new Error(`TwelveLabs indexing failed for ${indexedAssetId}`);
    log?.(`Twelve Labs: indexing (${ia?.status || "processing"})…`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`TwelveLabs indexing timed out for ${indexedAssetId}`);
}

/**
 * Ensure the movie is uploaded and indexed. Returns cache entry or null on failure.
 */
export async function ensureMovieIndexed({ apiKey, cacheDir, sourcePath, fileId, log }) {
  if (!apiKey) return null;
  const fingerprint = await fileFingerprint(sourcePath);
  const cached = await loadCache(cacheDir, fileId);
  if (cached?.fingerprint === fingerprint && cached?.indexId && cached?.videoId) {
    log?.(`Twelve Labs: cache hit for ${fileId} (video ${cached.videoId})`);
    return cached;
  }

  const indexId = await ensureSharedIndex(apiKey, cacheDir, log);
  log?.(`Twelve Labs: uploading ${path.basename(sourcePath)}…`);
  const assetId = await uploadAsset(apiKey, sourcePath, log);
  await waitForAssetReady(apiKey, assetId, log);

  log?.("Twelve Labs: starting Marengo indexing…");
  const indexed = await apiJson(apiKey, "POST", `/indexes/${indexId}/indexed-assets`, { asset_id: assetId });
  const indexedAssetId = indexed?._id || indexed?.id;
  if (!indexedAssetId) throw new Error("TwelveLabs indexed-asset create returned no id");

  const ready = await waitForIndexedAsset(apiKey, indexId, indexedAssetId, log);
  const videoId = ready?.video_id || ready?._id || indexedAssetId;

  const entry = {
    fileId,
    fingerprint,
    indexId,
    assetId,
    indexedAssetId,
    videoId,
    indexedAt: Date.now(),
  };
  await saveCache(cacheDir, fileId, entry);
  log?.(`Twelve Labs: indexed ${fileId} → video ${videoId}`);
  return entry;
}

/**
 * Search narration text against indexed movie. Returns best match or null.
 */
export async function searchBeatMoment({ apiKey, indexId, videoId, narration, spanStart, spanEnd }) {
  const query = String(narration || "").trim().slice(0, 1800);
  if (!query) return null;

  const form = new FormData();
  form.append("query_text", query);
  form.append("index_id", indexId);
  form.append("search_options", "visual");
  form.append("search_options", "audio");
  form.append("search_options", "transcription");
  form.append("operator", "or");
  form.append("page_limit", "8");
  form.append("group_by", "clip");
  if (videoId) {
    form.append("filter", JSON.stringify({ id: [videoId] }));
  }

  const resp = await fetch(`${API_BASE}/search`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`TwelveLabs search: HTTP ${resp.status} — ${data?.message || ""}`);
  }

  const hits = Array.isArray(data?.data) ? data.data : [];
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
  const maxRank = Math.max(1, Number(process.env.TWELVELABS_MAX_RANK) || 3);
  const minWindowSec = Math.max(6, Number(process.env.TWELVELABS_MIN_WINDOW_SEC) || 8);
  const COVERAGE_TARGET = 1.2;
  const MAX_SPAN_SEC = 300;

  const _preSpanScenes = scenes.map((sc) => ({ ...sc }));
  let attempted = 0, applied = 0, rejected = 0, failed = 0, skipped = 0;
  let _lastAcceptedCenter = -Infinity;
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
        if (Math.abs(center - origCenter) > 45) {
          log?.(`[render ${jobId}] TLABS beat ${i}: protected relocation ${Math.abs(center - origCenter).toFixed(1)}s — rejected`);
          rejected++;
          continue;
        }
      }
      if (center < _lastAcceptedCenter + 0.5) {
        log?.(`[render ${jobId}] TLABS beat ${i}: chronological guard — rejected`);
        rejected++;
        continue;
      }
      _lastAcceptedCenter = center;

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
