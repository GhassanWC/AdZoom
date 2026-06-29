# Framevo Remotion renderer — Cloud Run JOB image (run-to-completion).
#
# BUILD CONTEXT MUST BE THE REPO ROOT (the composition + render math live in
# ../../src and are bundled by Remotion's webpack at runtime via the "@" alias):
#   docker build -f services/remotion-renderer/Dockerfile -t framevo-remotion-renderer .
#
# node:22-bookworm-slim + the Chromium shared libs @remotion/renderer needs (Chrome
# Headless Shell is fetched by `npx remotion browser ensure` and baked in). Alpine
# is explicitly NOT supported by Remotion.

# ── Build stage: install deps + bundle the worker + prebundle the composition ──
FROM node:22-bookworm-slim AS build
WORKDIR /app/services/remotion-renderer
COPY services/remotion-renderer/package.json ./
RUN npm install --no-audit --no-fund
COPY services/remotion-renderer/ ./
# Shared app source the composition + render math import via the "@" alias.
COPY src /app/src
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production
# Build/version stamp (git sha) — logged at startup + recorded per job.
ARG BUILD_VERSION=dev
ENV BUILD_VERSION=${BUILD_VERSION}
WORKDIR /app/services/remotion-renderer

# Chromium runtime dependencies for @remotion/renderer (headless Chrome).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
    libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
    libpango-1.0-0 libcairo2 libcups2 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/services/remotion-renderer/package.json ./
COPY --from=build /app/services/remotion-renderer/node_modules ./node_modules
COPY --from=build /app/services/remotion-renderer/dist ./dist
# The composition source the runtime webpack bundle reads (resolved as "@" → /app/src).
COPY --from=build /app/src /app/src

# Fetch + bake Chrome Headless Shell so the first render doesn't download it.
# Use the programmatic @remotion/renderer API (the `remotion`/@remotion/cli CLI is
# NOT a dependency, so `npx remotion …` would have to fetch it from the network and
# the build would be non-deterministic / could fail). `ensureBrowser()` downloads
# the same Headless Shell into the Remotion cache reused at render time.
RUN node -e "import('@remotion/renderer').then(m=>m.ensureBrowser()).then(()=>console.log('[remotion] chrome headless shell ensured')).catch(e=>{console.error(e);process.exit(1)})"

# Run-to-completion Job: render one export, then exit.
CMD ["node", "dist/run.js"]
