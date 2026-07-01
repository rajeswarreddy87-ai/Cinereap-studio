# CineRecap Render Server
# Node 20 + FFmpeg + Python CLIP sidecar (CPU-only torch for semantic frame matching).
FROM node:20-bookworm-slim

# System packages: ffmpeg, python3, pip, ca-certs, curl, unzip (for Deno)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ffmpeg ca-certificates curl python3 python3-pip unzip aria2 \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp for video download
RUN pip3 install --no-cache-dir --break-system-packages "yt-dlp[default,curl-cffi]"

# Deno JS runtime (required by yt-dlp for YouTube challenge JS)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && /usr/local/bin/deno --version

# CLIP sidecar dependencies — CPU-only torch keeps image portable
# torch is ~230MB compressed; model weights (~600MB) download to /data/models on first run.
RUN pip3 install --no-cache-dir --break-system-packages \
    torch --index-url https://download.pytorch.org/whl/cpu
RUN pip3 install --no-cache-dir --break-system-packages \
    open_clip_torch Pillow transformers sentencepiece protobuf transformers sentencepiece \
    --extra-index-url https://download.pytorch.org/whl/cpu "fastapi[standard]" "uvicorn[standard]" numpy

WORKDIR /app

# Node deps first (cache layer)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Application source
COPY src ./src
COPY gen_music.sh ./gen_music.sh
COPY public ./public

# CLIP sidecar + startup script
COPY clip_server.py ./clip_server.py
COPY start.sh ./start.sh
RUN chmod +x start.sh

# Persistent data directories (bind-mounted in docker-compose)
RUN mkdir -p /data/uploads /data/output /data/jobs /data/cookies /data/music /data/models

ENV NODE_ENV=production
ENV PORT=8787
ENV STORAGE_DIR=/data

EXPOSE 8787 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/health || exit 1

CMD ["./start.sh"]
