/**
 * Pure helpers that decide how to fetch a movie file given a user-supplied URL.
 * Side-effect-free so they can be unit-tested with `node --test`.
 *
 * Returns a "fetch plan" object that the runtime ingest worker can act on:
 *   { kind: 'http', url }                   -> straight fetch with curl/got
 *   { kind: 'ytdlp', url }                  -> spawn yt-dlp -o <path> <url>
 *   { kind: 'unsupported', reason }         -> reject up-front
 */

const DRIVE_HOST = /(^|\.)drive\.google\.com$/i;
const DROPBOX_HOST = /(^|\.)dropbox\.com$/i;
const DROPBOXUSERCONTENT_HOST = /(^|\.)dropboxusercontent\.com$/i;
const STREAMING_HOSTS = [
  /(^|\.)netflix\.com$/i,
  /(^|\.)primevideo\.com$/i,
  /(^|\.)amazon\.com$/i,
  /(^|\.)hotstar\.com$/i,
  /(^|\.)hulu\.com$/i,
  /(^|\.)disneyplus\.com$/i,
  /(^|\.)apple\.com$/i, // Apple TV+
  /(^|\.)max\.com$/i,
  /(^|\.)hbomax\.com$/i,
];
const YTDLP_HOSTS = [
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)archive\.org$/i,
  /(^|\.)dailymotion\.com$/i,
  /(^|\.)twitch\.tv$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
];

const MAGNET_PREFIX = /^magnet:/i;

/**
 * Top-level: turn an arbitrary user-supplied string into a fetch plan.
 */
export function buildFetchPlan(rawInput) {
  if (typeof rawInput !== "string" || !rawInput.trim()) {
    return { kind: "unsupported", reason: "Empty URL" };
  }
  const input = rawInput.trim();

  if (MAGNET_PREFIX.test(input)) {
    return { kind: "unsupported", reason: "Magnet / torrent links are not supported by this server." };
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    return { kind: "unsupported", reason: "Not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "unsupported", reason: `Unsupported scheme: ${url.protocol}` };
  }

  // Reject DRM-protected streaming services explicitly.
  if (STREAMING_HOSTS.some((re) => re.test(url.hostname))) {
    return {
      kind: "unsupported",
      reason: "DRM-protected streaming services (Netflix, Prime, etc.) are not supported.",
    };
  }

  // Google Drive: rewrite share links to the direct download endpoint.
  if (DRIVE_HOST.test(url.hostname)) {
    const fileId = extractDriveId(url);
    if (!fileId) return { kind: "unsupported", reason: "Could not extract Google Drive file id from URL" };
    return {
      kind: "http",
      url: `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`,
      headers: { "User-Agent": "Mozilla/5.0 CineRecap" },
      detectedSource: "google-drive",
    };
  }

  // Dropbox: ensure the dl=1 parameter is set so we get the file body, not the HTML preview page.
  if (DROPBOX_HOST.test(url.hostname) || DROPBOXUSERCONTENT_HOST.test(url.hostname)) {
    url.searchParams.set("dl", "1");
    return { kind: "http", url: url.toString(), detectedSource: "dropbox" };
  }

  // yt-dlp territory: YouTube, archive.org, etc.
  if (YTDLP_HOSTS.some((re) => re.test(url.hostname))) {
    return { kind: "ytdlp", url: url.toString(), detectedSource: url.hostname };
  }

  // Direct HTTP/HTTPS download — assume the URL is a media file URL.
  return { kind: "http", url: url.toString(), detectedSource: "direct" };
}

/**
 * Pull the file id out of any common Google Drive sharing URL form:
 *   https://drive.google.com/file/d/{id}/view
 *   https://drive.google.com/open?id={id}
 *   https://drive.google.com/uc?id={id}&export=download
 *   https://drive.google.com/drive/folders/{id} -> not a single file -> null
 */
export function extractDriveId(url) {
  const idParam = url.searchParams.get("id");
  if (idParam) return idParam;
  const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
  if (fileMatch) return fileMatch[1];
  const ucMatch = url.pathname.match(/\/uc\/([^/]+)/);
  if (ucMatch) return ucMatch[1];
  return null;
}

/**
 * Suggest a target filename for a fetch plan, given a hash of the source URL.
 * The hash keeps the path stable across re-renders of the same movie.
 */
export function suggestCacheFilename(plan, urlHash) {
  if (plan.kind === "ytdlp") return `ingest-${urlHash}.mp4`;
  if (plan.kind === "http") {
    // Default to .mp4 — yt-dlp / direct downloads of MKV will be normalised to MP4 on first probe.
    return `ingest-${urlHash}.mp4`;
  }
  return `ingest-${urlHash}.bin`;
}
