import { google } from "googleapis";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

const STORAGE_DIR = process.env.STORAGE_DIR || "/data";
const YT_TOKEN_PATH = path.join(STORAGE_DIR, "youtube-token.json");

/**
 * Resolve the YouTube refresh token. Priority:
 *   1. YT_REFRESH_TOKEN env (set-and-forget)
 *   2. Persisted token file written by the browser OAuth callback
 */
async function resolveRefreshToken() {
  if (process.env.YT_REFRESH_TOKEN) return process.env.YT_REFRESH_TOKEN;
  try {
    const raw = await fs.readFile(YT_TOKEN_PATH, "utf8");
    return JSON.parse(raw).refresh_token || null;
  } catch {
    return null;
  }
}

/**
 * Upload a finished MP4 to YouTube. Defaults to Unlisted so you can review in
 * YouTube Studio before publishing.
 *
 * Requires YT_CLIENT_ID + YT_CLIENT_SECRET, plus a refresh token obtained
 * either via YT_REFRESH_TOKEN env or the in-app "Connect YouTube" OAuth flow
 * (which persists the token to ${STORAGE_DIR}/youtube-token.json).
 */
export async function uploadToYouTube({ filePath, title, description, tags, privacyStatus = "unlisted" }) {
  const clientId = process.env.YT_CLIENT_ID;
  const clientSecret = process.env.YT_CLIENT_SECRET;
  const refreshToken = await resolveRefreshToken();
  if (!clientId || !clientSecret) {
    throw new Error("YouTube upload is not configured. Set YT_CLIENT_ID / YT_CLIENT_SECRET on the server.");
  }
  if (!refreshToken) {
    throw new Error("YouTube is not connected. Use 'Connect YouTube' in the app, or set YT_REFRESH_TOKEN.");
  }

  // Use the configured redirect URI so the OAuth client matches the one that
  // minted the refresh token. Falls back to the deprecated oob if no PUBLIC_URL.
  const base = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  const redirectUri = base ? `${base}/youtube/callback` : "urn:ietf:wg:oauth:2.0:oob";

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const youtube = google.youtube({ version: "v3", auth: oauth2 });

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: (title || "Movie Recap").slice(0, 100),
        description: (description || "").slice(0, 5000),
        tags: Array.isArray(tags) ? tags.slice(0, 30) : [],
        categoryId: "1", // Film & Animation
      },
      status: {
        privacyStatus, // unlisted | private | public
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: createReadStream(filePath),
    },
  });
  return { videoId: res.data.id };
}
