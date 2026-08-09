#!/usr/bin/env bash
# Start deterministic v5 render server.
set -euo pipefail

# Keep yt-dlp current without a full image rebuild.
echo "[start] Upgrading yt-dlp..."
pip3 install --quiet --break-system-packages --upgrade yt-dlp 2>&1 | tail -1 || true
echo "[start] yt-dlp version: $(yt-dlp --version)"

echo "[start] Node render server on :${PORT:-8787}"
exec node src/index.js
