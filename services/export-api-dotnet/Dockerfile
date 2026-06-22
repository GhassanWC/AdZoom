# Framevo export worker (C#) — ONE image, three run modes (chosen by env):
#   • Google Cloud Batch (production paid export): EXPORT_JOB_ID + EXPORT_JOB_UID
#     ⇒ claim that one job, render, upload, write terminal status, EXIT 0/non-zero.
#     One container per export → near-zero idle compute cost.
#   • GCE VM (legacy): EXPORT_WORKER_MODE=firestore-poll ⇒ long-lived poll loop.
#   • Cloud Run control plane: EXPORT_WORKER_MODE=disabled ⇒ HTTP endpoints only.
#
# BUILD CONTEXT MUST BE THE REPO ROOT (the render-CLI bundle inlines shared code
# from ../../src via the "@" alias):
#   docker build -f services/export-api-dotnet/Dockerfile \
#     --build-arg BUILD_VERSION=$(git rev-parse --short HEAD) -t export-api .
#
# Multi-runtime: the final image runs the .NET worker AND a Node render CLI
# (the existing worker render core) that owns ffmpeg/ffprobe (bundled static
# binaries) + the @napi-rs/canvas compositor.

# ── Stage 1: build the Node render CLI (services/export-worker → dist/cli.js) ──
FROM node:20-slim AS cli-build
WORKDIR /app/services/export-worker
COPY services/export-worker/package.json ./
RUN npm install --no-audit --no-fund
# Surgical copies (no host node_modules/dist) — only what the bundle needs.
COPY services/export-worker/tsconfig.json services/export-worker/esbuild.cli.mjs ./
COPY services/export-worker/src ./src
COPY src /app/src
RUN node esbuild.cli.mjs
# Drop dev deps (esbuild/tsx/typescript) — keep the runtime externals
# (@napi-rs/canvas, ffmpeg-static, ffprobe-static).
RUN npm prune --omit=dev

# ── Stage 2: build the .NET API ───────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS dotnet-build
WORKDIR /src
COPY services/export-api-dotnet/ExportApi.csproj ./
RUN dotnet restore
COPY services/export-api-dotnet/ ./
RUN dotnet publish ExportApi.csproj -c Release -o /out --no-restore

# ── Stage 3: runtime = aspnet + node + render CLI ─────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:8.0
# Build/version stamp (git sha or tag) — logged at startup + per job by BOTH the
# C# API and the Node render CLI so a STALE VM image is obvious in the logs.
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=${BUILD_VERSION}
ENV DOTNET_System_Globalization_Invariant=true
WORKDIR /app
# Node runtime (dynamically linked against libstdc++6/libgcc-s1/libc6, present
# on the Debian-based aspnet image) for the render CLI.
COPY --from=cli-build /usr/local/bin/node /usr/local/bin/node
COPY --from=cli-build /app/services/export-worker/dist/cli.js      ./render-cli/cli.js
COPY --from=cli-build /app/services/export-worker/node_modules     ./render-cli/node_modules
COPY --from=dotnet-build /out ./
ENV RENDER_CLI_NODE=/usr/local/bin/node \
    RENDER_CLI_ENTRY=/app/render-cli/cli.js
# Cloud Run sets PORT (default 8080); Program.cs binds it.
EXPOSE 8080
ENTRYPOINT ["dotnet", "ExportApi.dll"]
