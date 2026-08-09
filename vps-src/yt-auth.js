/**
 * One-time script to obtain a YouTube refresh token for your channel.
 *
 * Prerequisites:
 *   1. Create a Google Cloud project: https://console.cloud.google.com/projectcreate
 *   2. Enable YouTube Data API v3: https://console.cloud.google.com/apis/library/youtube.googleapis.com
 *   3. Create OAuth 2.0 credentials of type "Desktop app":
 *        https://console.cloud.google.com/apis/credentials
 *      Copy the client ID and client secret into .env as YT_CLIENT_ID / YT_CLIENT_SECRET.
 *   4. Run: node src/yt-auth.js
 *      It will print a URL — open it in your browser, sign in with the channel
 *      you want to upload to, then paste the resulting code back into this prompt.
 *
 * The script prints a YT_REFRESH_TOKEN value — paste it into .env. From then on
 * the render server can upload videos to that channel automatically.
 */
import "dotenv/config.js";
import readline from "node:readline/promises";
import { google } from "googleapis";

const clientId = process.env.YT_CLIENT_ID;
const clientSecret = process.env.YT_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set YT_CLIENT_ID and YT_CLIENT_SECRET in .env before running this.");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, "urn:ietf:wg:oauth:2.0:oob");
const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/youtube.upload"],
});

console.log("Step 1. Open this URL in your browser and sign in:\n");
console.log(authUrl);
console.log("\nStep 2. Google will redirect you to a localhost page that won't load — that's fine. Copy the `code` query parameter from the URL.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question("Paste the code here: ")).trim();
rl.close();

const { tokens } = await oauth2.getToken(code);
if (!tokens.refresh_token) {
  console.error("\nNo refresh token returned. Revoke previous authorisation at https://myaccount.google.com/permissions and try again.");
  process.exit(1);
}
console.log("\nSuccess. Add this line to your .env:\n");
console.log(`YT_REFRESH_TOKEN=${tokens.refresh_token}`);
console.log("\nThen restart the render server with: docker compose up -d --build");
