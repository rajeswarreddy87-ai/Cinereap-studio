#!/usr/bin/env bash
# Start render server. SigLIP/CLIP sidecar disabled by default (v3.1.0).
set -euo pipefail

CLIP_ENABLED="${CLIP_SIDECAR_ENABLED:-0}"

if [ "$CLIP_ENABLED" = "1" ]; then
  echo "[start] CLIP/SigLIP sidecar enabled — starting on :8788"
  python3 clip_server.py &
  CLIP_PID=$!
  trap 'kill "$CLIP_PID" 2>/dev/null || true' EXIT
else
  echo "[start] CLIP/SigLIP sidecar disabled (CLIP_SIDECAR_ENABLED=0)"
fi

echo "[start] Node render server on :${PORT:-8787}"
exec node src/index.js
