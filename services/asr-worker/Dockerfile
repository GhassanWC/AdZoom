# Framevo ASR worker — Cloud Run image (ffmpeg + Google Speech-to-Text via the
# shared transcript pipeline).
#
# BUILD CONTEXT MUST BE THE REPO ROOT (the bundle inlines shared code from
# ../../src via the "@" alias — see esbuild.mjs):
#
#   docker build -f services/asr-worker/Dockerfile -t framevo-asr-worker .
#
# `gcloud run deploy --source services\asr-worker` would scope the context to
# this directory and lose src/ — use services/asr-worker/cloudbuild.yaml (or
# `npm run asr:deploy`) instead. Only this service + src/ are copied: the .NET
# export API and every other service never enter this image.

# ── Build stage: install deps + bundle ──────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app/services/asr-worker
COPY services/asr-worker/package.json ./
RUN npm install --no-audit --no-fund
COPY services/asr-worker/ ./
# Shared app source the bundle imports via the "@" alias (transcript pipeline,
# caption quota ledger, caption generator, firebase admin).
COPY src /app/src
RUN npm run build && npm prune --omit=dev

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:20-slim
ENV NODE_ENV=production
# ffmpeg — audio extraction for ASR (spawned as `ffmpeg` from PATH; FFMPEG_PATH
# stays unset). Noto fonts — the multilingual set the caption/overlay renderers
# standardize on (Latin/Cyrillic/Greek/Arabic/Hebrew/Devanagari/Thai via
# fonts-noto-core, CJK, emoji); kept in this image for parity with the render
# workers so any future in-worker caption rasterization can't tofu.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fontconfig \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/services/asr-worker
COPY --from=build /app/services/asr-worker/package.json ./
COPY --from=build /app/services/asr-worker/node_modules ./node_modules
COPY --from=build /app/services/asr-worker/dist ./dist
# Cloud Run injects PORT; the server reads it (default 8080).
EXPOSE 8080
CMD ["node", "dist/server.js"]
