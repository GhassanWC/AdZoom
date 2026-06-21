# Framevo Export API (C# / ASP.NET Core)

A clean export backend that owns the cloud-export API + the whole job lifecycle
and runs the render as an **in-process background job** — it never renders inside
an HTTP request and does **not** use Cloud Tasks. It replaces the Node Cloud-Run
worker + Cloud Tasks; the existing Node **render core** is reused as a child
process for the actual frame compositing (full effect parity, no re-implementation).

```
Next.js (front door, verifies Firebase token)
   │  POST /exports/enqueue  (X-Internal-Secret + trusted uid)
   ▼
ExportApi (Cloud Run, always-on)
   ├─ HTTP: /health, /exports/enqueue, /exports/{id}/cancel, GET /exports/{id}, /logs   (return fast)
   ├─ ExportRunner (BackgroundService): poll Firestore + in-memory signal → claim (heartbeat lease) → render
   │      claim → download (GCS) → spawn Node render CLI → upload (GCS) → settle minutes
   └─ Reconciler (BackgroundService): fail + release stale jobs (no Cloud Scheduler needed)
                                   │ spawn
                                   ▼
        node render-cli/cli.js  (the worker render core: ffprobe/ffmpeg + @napi-rs/canvas compositor)
        ← NDJSON on stdout: preflight | stage | progress | first-frame | warning | done | error
```

Firestore is the channel back to the browser (the app keeps its existing
`exportJobs` real-time subscription); the REST `GET` endpoints are supplementary
diagnostics.

## Render CLI (built from the Node worker)

The render core is bundled into `services/export-worker/dist/cli.js` and copied
into this image. Build it standalone with:

```bash
cd services/export-worker
npm install
npm run build:cli           # → dist/cli.js
node test/cli-smoke.mjs     # NDJSON + valid MP4 smoke test
```

Spec (argv[2] = a JSON file) → NDJSON events on stdout, `[worker:*]` logs on
stderr, `cancel` line on stdin aborts. Exit 0 = done, 1 = error, 2 = canceled.

## Local development

```bash
# In services/export-api-dotnet:
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json   # Firestore + Storage
export GCLOUD_PROJECT=adzoomdev
export NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=adzoomdev.firebasestorage.app
export EXPORT_API_INTERNAL_SECRET=dev-secret
# Point at a locally-built CLI:
export RENDER_CLI_NODE=node
export RENDER_CLI_ENTRY=../export-worker/dist/cli.js
dotnet run
# → [export:startup] …  listening on :8080
curl localhost:8080/health        # → ok
```

## Build + deploy to Cloud Run

Use the deploy script (Cloud Build from the repo root via `cloudbuild.yaml`,
then `gcloud run deploy` with the required flags, then verifies `/health` + an
enqueue smoke). Run from the repo root:

```bash
# Required: the shared secret (or EXPORT_API_INTERNAL_SECRET_NAME for Secret Manager).
export EXPORT_API_INTERNAL_SECRET='<long-random-secret>'
# Prod defaults are baked in (PROJECT_ID=adzoom-prod, REGION=us-central1,
# ARTIFACT_REPO=framevo, bucket=adzoom-prod.firebasestorage.app); override via env.
npm run export-api:deploy
```

It runs:

```bash
gcloud builds submit --config services/export-api-dotnet/cloudbuild.yaml \
  --substitutions=_IMAGE=REGION-docker.pkg.dev/PROJECT/framevo/export-api:latest .

gcloud run deploy export-api \
  --image REGION-.../export-api:latest --region REGION \
  --no-allow-unauthenticated \
  --no-cpu-throttling --min-instances=1 --max-instances=5 \
  --cpu=4 --memory=8Gi --timeout=3600 --concurrency=1 \
  --service-account export-api@PROJECT.iam.gserviceaccount.com \
  --set-env-vars NODE_ENV=production,NEXT_PUBLIC_FIREBASE_PROJECT_ID=adzoom-prod,\
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=adzoom-prod.firebasestorage.app,\
WORKER_CONCURRENCY=1,WORKER_NORMALIZE_ENABLED=1,EXPORT_API_INTERNAL_SECRET=<secret>
# (with EXPORT_API_INTERNAL_SECRET_NAME set, the secret goes via --set-secrets instead)
```

- **`--no-cpu-throttling`** and **`--min-instances=1`** are mandatory: rendering
  happens outside HTTP requests, so the instance needs CPU between requests and
  must not be reaped. (The old Node worker rendered *inside* the request and
  needed a long `--timeout`; here `--timeout 3600` is just an upper HTTP bound.)
- **`--concurrency=1`** to start (render memory headroom; raise once validated).
- The service account needs `roles/datastore.user` + `roles/storage.objectAdmin`.
- Multiple instances are safe: the claim transaction lets exactly one win each job.

### Post-deploy verification

The service is private (`--no-allow-unauthenticated`), so every request — incl.
`/health` — needs a Cloud Run identity token. The script does this automatically;
manually:

```bash
URL=$(gcloud run services describe export-api --region REGION --format='value(status.url)')
TOKEN=$(gcloud auth print-identity-token --audiences="$URL")

# Health (→ 200 "ok"):
curl -H "Authorization: Bearer $TOKEN" "$URL/health"

# Enqueue smoke with the internal secret (a free/unknown uid → 402
# cloud_export_requires_paid, proving auth + Firestore + the gate, with NO job
# created / no minutes touched):
curl -X POST "$URL/exports/enqueue" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Internal-Secret: $EXPORT_API_INTERNAL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"uid":"smoke-test-uid","projectId":"smoke","projectTitle":"smoke",
       "sourceStoragePath":"users/smoke-test-uid/projects/smoke/original/none.mp4",
       "outputWidth":1920,"outputHeight":1080,"fps":30,"resolution":"1080p",
       "durationSeconds":1,"serializedRecipe":{}}'
```

First log line of each revision is `[export:startup] …` with config + loud
warnings (missing `EXPORT_API_INTERNAL_SECRET`/bucket, bad reconcile thresholds).

The Firestore composite index `(status, updatedAt)` collection-group on
`exportJobs` (already in `firestore.indexes.json`) is reused by both the poller
and the reconciler — no new index required.

## Build + deploy to the GCE VM worker (production)

Production rendering runs on the **long-lived GCE VM** (`services/export-vm-worker/docker-compose.yml`)
— the SAME image as Cloud Run, but `EXPORT_WORKER_MODE=firestore-poll` so a 2–3 min
render is never cut off. Next.js creates the job doc (`EXPORT_BACKEND=vm`); the VM
poller claims + renders. Deploy a new build with a **unique tag** so a stale image is
obvious, then recreate the container and confirm the build in the logs:

```bash
# 1. Build + push a uniquely-tagged image (Cloud Build, repo-root context). The
#    git sha is baked into BUILD_VERSION AND used as the image tag.
TAG=$(git rev-parse --short HEAD)
IMAGE=us-central1-docker.pkg.dev/adzoom-prod/framevo/export-api:$TAG
gcloud builds submit --project=adzoom-prod \
  --config=services/export-api-dotnet/cloudbuild.yaml \
  --substitutions=_IMAGE=$IMAGE,_BUILD_VERSION=$TAG .

# 2. On the VM: point docker-compose at the new tag, pull, recreate.
gcloud compute ssh framevo-export-vm --zone=<zone> --command "\
  cd /opt/framevo/export-vm-worker && \
  sed -i 's#export-api:.*#export-api:$TAG#' .env 2>/dev/null; \
  EXPORT_IMAGE=$IMAGE docker compose pull && \
  EXPORT_IMAGE=$IMAGE docker compose up -d --force-recreate"

# 3. Verify the NEW build is running (both lines must show the new $TAG):
gcloud compute ssh framevo-export-vm --zone=<zone> --command \
  "docker logs --tail=200 framevo-export-worker 2>&1 | grep -E 'startup|cli-version'"
#   [export:startup] … build=<TAG> …
#   [vm-worker:cli-version] job=… build=<TAG> …   (emitted on the first render)
```

The `[vm-worker:cli-version] build=<TAG>` line is the proof the VM is on the new
render core; if it shows an old value (or never appears), the image didn't roll.
No new env vars are required by this change — `BUILD_VERSION` is set by the image
ARG and `EXPORT_WORKER_ID` defaults to `hostname#pid` (the container id + process).

## Firestore job schema

Doc: `users/{uid}/exportJobs/{jobId}` (client read-only per `firestore.rules`;
this API writes via server credentials).

| field | type | notes |
|-------|------|-------|
| `status` | string | `queued`→`rendering`→`uploading`→`ready` \| `failed` \| `canceled` |
| `stage` | string | `queued`/`downloading`/`normalizing`/`decoding`/`rendering`/`encoding`/`uploading` |
| `progress` | number | 0..1 |
| `plan` / `priority` | string | `pro`\|`creator` / `normal`\|`priority` |
| `sourceStoragePath` / `outputPath` | string | `users/{uid}/projects/{pid}/original/<file>` / `…/exports/{jobId}.mp4` |
| `outputWidth`/`outputHeight`/`fps`/`durationSeconds` | number | from the recipe |
| `estimatedExportMinutes` / `consumedExportMinutes` | number | reserved at enqueue; consumed at success |
| `monthlyBucket` | string | `YYYY-MM` (UTC) — the minutes ledger key |
| `renderRecipe` | map | opaque; stored + forwarded to the CLI |
| `warnings` | string[] | e.g. unsupported-audio notice |
| `preflight` | map | `{ videoCodec, audioCodec, risky, normalized }` |
| `errorCode` / `errorMessage` | string | clean, user-facing on failure (codes below) |
| `cancelRequested` | bool | set by cancel |
| `downloadUrl` | string | set at success |
| `exportPath` | string | always `cloud` for this collection (browser exports live in `exports`) |
| `settingsHash` | string | dedup key (project+source+format/res/fps+recipe) — repeated identical export returns the active job |
| `workerId` / `buildVersion` | string | which container + image touched the job (claim/fail) — names the producer on a failed row |
| `claimedAt` / `lastHeartbeatAt` | Timestamp | claim time + liveness beat (every patch/heartbeat); drives stale detection |
| `progressStage` | string | friendly UI stage: `queued`/`preparing`/`rendering`/`uploading`/`ready` |
| `createdAt`/`updatedAt`/`startedAt`/`completedAt`/`failedAt`/`canceledAt` | Timestamp | server timestamps (`failedAt` set on failure) |

**Error codes** (`errorCode`, aligned with the Node CLI's `errors.ts`):
`audio_decode_failed` · `normalize_failed` · `render_failed` · `upload_failed` ·
`audio_missing_after_render` (source had usable audio but the final mp4 is silent —
ffprobe-verified before upload) · `stale` (dead worker, swept by the reconciler or
superseded by a fresh export) · plus `decode_failed`/`unsupported_video`/`render_stalled`.

Ledger: `users/{uid}/usage/{YYYY-MM}` — `cloudMinutesReserved`,
`cloudMinutesConsumed` (`remaining = limit − reserved − consumed`;
free 0 / pro 150 / creator 600; `estimate = max(1, ceil(sec/60))`).

## API route examples

```bash
H='-H "X-Internal-Secret: $EXPORT_API_INTERNAL_SECRET" -H "Content-Type: application/json"'

# SIGNAL mode (the cutover path) — the job was already created by Next.js; just
# wake the runner. The poller is the fallback if this is never called.
curl -X POST localhost:8080/exports/enqueue $H -d '{"uid":"U1","jobId":"JOBID"}'
# → 200 { "ok":true, "jobId":"JOBID", "mode":"signal" }   | 404 if the job doesn't exist

# CREATE mode (standalone ownership — C# reserves + creates; omit jobId):
curl -X POST localhost:8080/exports/enqueue $H -d '{
  "uid":"U1","projectId":"P1","projectTitle":"Demo",
  "sourceStoragePath":"users/U1/projects/P1/original/in.mp4",
  "outputWidth":1920,"outputHeight":1080,"fps":30,"resolution":"1080p",
  "durationSeconds":42, "serializedRecipe": { /* opaque */ } }'
# → 200 { ok, jobId, estimatedExportMinutes, plan, priority, limit }
# → 402 { kind:"cloud_export_requires_paid"|"tier_requires_pro" } | 429 { kind:"cloud_minutes_exhausted" }

curl -X POST localhost:8080/exports/JOBID/cancel $H -d '{"uid":"U1"}'   # → { ok, state:"canceled" }
curl "localhost:8080/exports/JOBID?uid=U1" -H "X-Internal-Secret: $EXPORT_API_INTERNAL_SECRET"        # → job view
curl "localhost:8080/exports/JOBID/logs?uid=U1" -H "X-Internal-Secret: $EXPORT_API_INTERNAL_SECRET"   # → recent diagnostics
```

## Next.js integration (implemented, behind a flag)

The cutover is wired in Next.js behind `EXPORT_BACKEND` (default `cloudtasks` →
old Node worker; set `dotnet` → this service). The browser path is unchanged; the
Firestore `useCloudExport` subscription still drives status.

- **`src/lib/export/dotnet-backend.ts`** — `exportBackend()`, `dotnetEnqueueSignal()`,
  `dotnetCancel()`. Calls carry `X-Internal-Secret` + a Cloud Run identity token
  (metadata server; the service is `--no-allow-unauthenticated`).
- **`src/lib/export/enqueue.ts`** — when `EXPORT_BACKEND=dotnet`, signals the C#
  runner (`POST /exports/enqueue { uid, jobId }`, SIGNAL mode) instead of Cloud
  Tasks. Best-effort: the C# runner polls Firestore, so a failed signal still gets
  delivered. **Next.js still owns** Firebase auth + plan + minute reservation + job
  creation (the `/api/export/cloud` transaction is unchanged), and keeps building
  `serializedRecipe` via `buildRenderRecipe` — the recipe stays opaque to C#.
- **`src/app/api/export/cancel/route.ts`** — when `dotnet`, proxies to
  `POST /exports/{jobId}/cancel { uid }`; the local authoritative cancel txn remains
  as an idempotent fallback (no double-release).
- Logs show the backend: `[export-enqueue] backend=dotnet|cloudtasks …`,
  `[export-cancel] backend=dotnet proxied …` / `local txn …`.

App env (set on the Next.js service when flipping to dotnet): `EXPORT_BACKEND=dotnet`,
`EXPORT_API_URL` (this service's Cloud Run URL), `EXPORT_API_INTERNAL_SECRET` (same
secret the service reads). The Next.js service account needs `roles/run.invoker` on
this service (private). **Not yet done:** retiring the Node worker + Cloud Tasks
queues and deleting `/api/cron/reconcile-exports` — left intact as the fallback.

## Notes / risks

- Image is large (~1 GB: aspnet + node + Skia + ffmpeg). The Node binary is copied
  from `node:20-slim`; if Skia/ffmpeg fail to load on the aspnet base, `apt-get
  install -y libstdc++6 fontconfig` in the runtime stage (text/watermark rendering
  needs fonts — paid exports don't watermark, so this is usually unnecessary).
- SIGTERM mid-render: the runner kills the child and leaves the job `rendering`;
  the heartbeat lease lets another instance re-claim it (no double-charge — the
  reservation persists and settle/release re-check status).
- `WORKER_CONCURRENCY=1` first; raise once memory/CPU headroom is validated.
