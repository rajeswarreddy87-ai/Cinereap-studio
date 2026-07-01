#!/usr/bin/env bash
# Pre-deploy gate: syntax + no-undef lint on the render server source.
# Runs INSIDE the container (that is where node + node_modules live).
# Exit non-zero on any problem so deploy.sh aborts before restarting.
set -euo pipefail

CONTAINER="${RENDER_CONTAINER:-cinerecap-render}"
FILES="src/index.js src/analyze.js src/beats.js src/scenes.js src/ffmpeg-args.js src/music.js"

echo "[check] node --check (syntax)…"
for f in $FILES; do
  if docker exec "$CONTAINER" test -f "/app/$f"; then
    docker exec "$CONTAINER" node --check "/app/$f"
    echo "  ok: $f"
  fi
done

echo "[check] eslint no-undef (reference errors)…"
if docker exec "$CONTAINER" sh -c 'test -x /app/node_modules/.bin/eslint'; then
  # Only ./src is mounted into the container, so copy the flat config in first.
  docker cp eslint.config.js "$CONTAINER":/app/eslint.config.js
  docker exec "$CONTAINER" sh -c 'cd /app && node_modules/.bin/eslint src/'
else
  echo "  [warn] eslint not installed in container; run: docker exec $CONTAINER npm install --no-save eslint@10"
  echo "  [warn] (add eslint to devDependencies + rebuild to make the gate permanent)"
  exit 3
fi

echo "[check] PASSED"
