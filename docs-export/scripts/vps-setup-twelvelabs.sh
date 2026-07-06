#!/usr/bin/env bash
# One-shot VPS setup: deploy v3.1.0 Twelve Labs + disable GSPAN/SigLIP.
# Usage (on VPS):
#   export TWELVELABS_API_KEY='tlk_...'
#   bash scripts/vps-setup-twelvelabs.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ -z "${TWELVELABS_API_KEY:-}" ]; then
  echo "ERROR: set TWELVELABS_API_KEY before running this script."
  exit 1
fi

ENV_FILE="${ENV_FILE:-$ROOT/.env}"
touch "$ENV_FILE"

upsert_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

echo "== updating .env =="
upsert_env "TWELVELABS_API_KEY" "$TWELVELABS_API_KEY"
upsert_env "TWELVELABS_ENABLED" "1"
upsert_env "GEMINI_SPAN_LOCALIZATION" "0"
upsert_env "CLIP_SIDECAR_ENABLED" "0"

mkdir -p src/lib storage/twelvelabs-cache

# Copy from repo if files exist alongside docker-compose
for f in index.js lib/twelvelabs.js; do
  if [ -f "src/$f" ]; then
    echo "  src/$f present"
  fi
done

if [ -f start.sh ]; then chmod +x start.sh; fi

echo "== gate =="
if [ -f scripts/check.sh ]; then bash scripts/check.sh; else node --check src/index.js; fi

echo "== restart container =="
docker compose up -d --force-recreate render

echo "== health =="
sleep 10
curl -s --max-time 15 http://localhost:4040/health | python3 -m json.tool 2>/dev/null | head -30 || curl -s http://localhost:4040/health | head -c 400
echo
echo "== done: expect version 3.1.0, twelvelabsConfigured true =="
