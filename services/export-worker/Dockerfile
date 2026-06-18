# Framevo export worker — Cloud Run image.
#
# BUILD CONTEXT MUST BE THE REPO ROOT (the bundle inlines shared code from
# ../../src):
#   docker build -f services/export-worker/Dockerfile -t framevo-export-worker .
#
# FFmpeg + ffprobe are provided by the bundled ffmpeg-static / ffprobe-static
# npm packages (linux-x64 binaries), so no apt ffmpeg install is needed.
# @napi-rs/canvas ships a prebuilt Skia binary — no system canvas libs required.

# ── Build stage: install deps + bundle ──────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app/services/export-worker
COPY services/export-worker/package.json ./
RUN npm install --no-audit --no-fund
COPY services/export-worker/ ./
# Shared app source the bundle imports via the "@" alias.
COPY src /app/src
RUN npm run build

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app/services/export-worker
COPY --from=build /app/services/export-worker/package.json ./
COPY --from=build /app/services/export-worker/node_modules ./node_modules
COPY --from=build /app/services/export-worker/dist ./dist
# Cloud Run sets PORT; the worker reads it (default 8787).
EXPOSE 8787
CMD ["node", "dist/server.js"]
