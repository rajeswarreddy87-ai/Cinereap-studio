#!/usr/bin/env bash
# Pull latest code from GitHub and deploy on VPS.
# Prereq: git remote origin points at Cinereap-studio repo.
set -euo pipefail
cd /root/cinerecap-render-server

BRANCH="${DEPLOY_BRANCH:-cursor/twelvelabs-visual-match-6d80}"
git fetch origin "$BRANCH"
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git pull origin "$BRANCH"

# Map docs-export mirror files into live src/ if repo layout differs
if [ -f docs-export/index-vps.js ]; then
  mkdir -p src/lib
  cp docs-export/index-vps.js src/index.js
  cp docs-export/lib/twelvelabs.js src/lib/twelvelabs.js
  cp docs-export/beats.js src/beats.js 2>/dev/null || true
  cp docs-export/scenes.js src/scenes.js 2>/dev/null || true
  cp docs-export/docker-compose.yml docker-compose.yml
  cp docs-export/start.sh start.sh
  chmod +x start.sh
fi

if [ -n "${TWELVELABS_API_KEY:-}" ]; then
  bash scripts/vps-setup-twelvelabs.sh
else
  echo "TWELVELABS_API_KEY not set — run: export TWELVELABS_API_KEY='...' && bash scripts/vps-setup-twelvelabs.sh"
  docker compose up -d --force-recreate render
fi
