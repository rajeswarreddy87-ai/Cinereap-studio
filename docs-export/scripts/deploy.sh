#!/usr/bin/env bash
# Single safe deploy path for the render server.
#   1. gate: scripts/check.sh (syntax + no-undef lint) — aborts on failure
#   2. snapshot: git commit the working tree (single source of truth + rollback)
#   3. restart the render container
#   4. verify /health
# Usage: scripts/deploy.sh "commit message describing the change"
set -euo pipefail

cd "$(dirname "$0")/.."
MSG="${1:-deploy: update render server}"
CONTAINER="${RENDER_CONTAINER:-cinerecap-render}"

echo "== 1/4 gate =="
bash scripts/check.sh

echo "== 2/4 commit =="
git add -A
if git diff --cached --quiet; then
  echo "  (no changes to commit)"
else
  git commit -q -m "$MSG"
  echo "  committed: $(git rev-parse --short HEAD)"
fi

echo "== 3/4 restart =="
docker compose restart "$(basename "$CONTAINER" | sed 's/cinerecap-//')" 2>/dev/null || docker compose restart render

echo "== 4/4 health =="
sleep 8
curl -s --max-time 15 http://localhost:4040/health | head -c 200
echo
echo "== deploy done =="
