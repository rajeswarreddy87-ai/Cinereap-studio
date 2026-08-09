/**
 * Runtime worker that takes a fetch plan (from url-ingest.js) and produces
 * a local MP4 file in the uploads cache. Side-effects are confined to here so
 * the planner stays pure and testable.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync as fsExistsSync, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import path from "node:path";

import { buildFetchPlan, suggestCacheFilename } from "./url-ingest.js";

/**
 * Stable hash of the source URL — used as part of the cache filename so that
 * re-rendering the same movie does not re-download it.
 */
export function hashUrl(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
}

export async function ingestFromUrl({ sourceUrl, uploadsDir, onProgress }) {
  const plan = buildFetchPlan(sourceUrl);
  if (plan.kind === "unsupported") {
    const err = new Error(plan.reason);
    err.code = "UNSUPPORTED_SOURCE";
    throw err;
  }

  const urlHash = hashUrl(plan.url);
  const filename = suggestCacheFilename(plan, urlHash);
  const outPath = path.join(uploadsDir, filename);
  // Sentinel file written ONLY after a fully-successful download. The cache
  // check requires it so that a partial/in-progress download is never served
  // as a complete file — which would cause analysis to probe wrong duration.
  const donePath = outPath + ".done";

  // Only return a cached result if the download was previously completed.
  try {
    await fs.access(donePath); // throws if sentinel is absent
    const stat = await fs.stat(outPath);
    if (stat.size > 0) {
      if (onProgress) onProgress({ phase: "cached", bytes: stat.size });
      return { fileId: filename, path: outPath, bytes: stat.size, cached: true, plan };
    }
  } catch { /* not cached or download was incomplete — proceed */ }

  // Remove any leftover partial file so the downloader starts fresh.
  try { await fs.unlink(outPath); } catch { /* may not exist */ }
  try { await fs.unlink(donePath); } catch { /* may not exist */ }

  if (plan.kind === "http") {
    await downloadHttp(plan, outPath, onProgress);
  } else if (plan.kind === "ytdlp") {
    await downloadYtDlp(plan, outPath, onProgress);
  } else {
    throw new Error(`Unhandled plan kind: ${plan.kind}`);
  }

  const stat = await fs.stat(outPath);
  // Mark as complete — future cache hits will see this file as fully downloaded.
  await fs.writeFile(donePath, String(Date.now()));
  return { fileId: filename, path: outPath, bytes: stat.size, cached: false, plan };
}

async function downloadHttp(plan, outPath, onProgress) {
  if (onProgress) onProgress({ phase: "http-start", url: plan.url });
  const res = await fetch(plan.url, { headers: plan.headers || {}, redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error("Download returned no body");

  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  const stream = Readable.fromWeb(res.body);
  stream.on("data", (chunk) => {
    received += chunk.length;
    if (onProgress) onProgress({ phase: "http-progress", received, total });
  });
  await pipeline(stream, createWriteStream(outPath));
  if (onProgress) onProgress({ phase: "http-done", bytes: received });
}

async function downloadYtDlp(plan, outPath, onProgress) {
  if (onProgress) onProgress({ phase: "ytdlp-start", url: plan.url });
  await new Promise((resolve, reject) => {
    // Key flags for fragmented streams (HLS/DASH — used by Dailymotion and others):
    //   --no-part            Write directly to output path instead of using .part temp
    //                        files. Avoids the "Unable to rename .part-FragNNN" crash
    //                        that occurs when the filesystem is slow or the fragment
    //                        temp file disappears before yt-dlp can rename it.
    //   --retries 10         Retry the whole download up to 10× on network errors.
    //   --fragment-retries 10  Retry each individual HLS/DASH fragment up to 10×
    //                        before failing the download.
    //   --concurrent-fragments 1  Download one fragment at a time. Prevents filesystem
    //                        race conditions when many fragments are written in parallel.
    //
    // Format selection:
    //   -f best[ext=mp4]/best  Pick best single-file mp4 (avoids remux cost).
    //   --merge-output-format mp4  Ensure mp4 output for downstream FFmpeg.
    const args = [
      "--no-playlist",
      "--no-part",
      "--retries", "10",
      "--fragment-retries", "10",
      "--concurrent-fragments", "1",
      "-f", "best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      // YouTube increasingly blocks datacenter IPs as bots. If the operator
      // has dropped a Netscape-format cookies.txt file at /data/cookies.txt
      // (mounted from the host), we pass it to yt-dlp so requests look like
      // a logged-in browser. Without it, requests to youtube.com return
      // "Sign in to confirm you're not a bot" and exit 1.
      ...(process.env.YT_DLP_COOKIES_FILE && fsExistsSync(process.env.YT_DLP_COOKIES_FILE)
        ? ["--cookies", process.env.YT_DLP_COOKIES_FILE]
        : []),
      // Fall back to the built-in default path if no env var was set but a
      // file is sitting at /data/cookies.txt anyway (the Docker volume mount
      // we recommend in the README).
      ...(!process.env.YT_DLP_COOKIES_FILE && fsExistsSync("/data/cookies.txt")
        ? ["--cookies", "/data/cookies.txt"]
        : []),
      "-o", outPath,
      plan.url,
    ];
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      const line = chunk.toString();
      const m = line.match(/(\d+(?:\.\d+)?)%/);
      if (m && onProgress) onProgress({ phase: "ytdlp-progress", percent: Number(m[1]) });
    });
    let stderrBuf = "";
    child.stderr.on("data", (c) => { stderrBuf += c.toString(); });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderrBuf.slice(-800);
      // Make the YouTube bot-block message actionable for the mobile client
      // instead of dumping the full stderr.
      if (/Sign in to confirm you['']re not a bot/i.test(tail) || /confirm.*not.*a bot/i.test(tail)) {
        reject(
          new Error(
            "YouTube blocked the download as bot traffic. On the VPS, drop a Netscape cookies.txt at /data/cookies.txt (or set YT_DLP_COOKIES_FILE) and restart the container. Tip: install the 'Get cookies.txt LOCALLY' browser extension on a logged-in YouTube tab and copy the file to your VPS.",
          ),
        );
        return;
      }
      // Dailymotion / generic: surface the last 400 chars so the app shows
      // a meaningful error rather than a raw yt-dlp exit code.
      reject(new Error(`yt-dlp exited with ${code}: ${tail}`));
    });
  });
  if (onProgress) onProgress({ phase: "ytdlp-done" });
}
