# Framevo Export Worker

Server-side cloud MP4 export for paid plans. Renders each output frame with the
**shared canvas render core** (`@/lib/render/compose-frame`, the exact code the
browser exporter runs) on `@napi-rs/canvas`, and uses **FFmpeg only for decode,
encode, and audio** — so preview and cloud export match pixel-for-pixel.

```
Cloud Tasks ──(OIDC)──▶ POST /  { uid, jobId }
                         │
                         ├─ claim job (lease, idempotent)
                         ├─ download source from Storage
                         ├─ ffmpeg decode (rawvideo rgba) ─┐
                         ├─ composeFrame() per output frame │  canvas parity
                         ├─ ffmpeg encode H.264/AAC + audio ┘  + cuts/speed
                         ├─ upload MP4 → Storage
                         ├─ settle minutes, status "ready" + downloadUrl
                         └─ (cancel polled between frames → release + "canceled")
```

## How it fits the app

- `POST /api/export/cloud` (main app) gates plan + minutes, creates
  `users/{uid}/exportJobs/{jobId}` (`status:"queued"`), reserves the minute
  estimate, and enqueues the job (`src/lib/export/enqueue.ts`).
- This worker picks it up, renders, uploads, and writes every status/progress
  transition back to Firestore via the Admin SDK. There is **no callback route** —
  Firestore is the channel back to the client (`subscribeExportJobs`).
- Cancellation: `POST /api/export/cancel` sets `cancelRequested`; the worker
  polls it between frames and tears down both ffmpeg processes.

## Local development (no GCP)

The whole pipeline runs on a dev box with the app's local dispatch:

```bash
# In the main app: set EXPORT_DISPATCH=local (default) in .env.local.
npm run dev

# In services/export-worker:
npm install
# Needs Firebase Admin creds + the Storage bucket:
#   FIREBASE_SERVICE_ACCOUNT_B64=<base64 service-account json>   (or GOOGLE_APPLICATION_CREDENTIALS)
#   NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=<your-bucket>
npm run dev    # tsx watch; DEV_DISABLE_OIDC=1, listens on :8787, renders in background
```

`/api/export/cloud` POSTs `{ uid, jobId }` to `EXPORT_WORKER_LOCAL_URL`
(default `http://127.0.0.1:8787/`); the worker acks 202 and renders async, so the
app request returns the `jobId` immediately. Watch the job go
`queued → rendering → uploading → ready` live on `/dashboard/exports`.

ffmpeg/ffprobe come from the bundled `ffmpeg-static`/`ffprobe-static` packages —
nothing to install. `@napi-rs/canvas` ships a prebuilt binary (incl. Windows).

## Build + deploy to Cloud Run

```bash
# From the REPO ROOT (the bundle inlines shared code from ../../src):
docker build -f services/export-worker/Dockerfile -t REGION-docker.pkg.dev/PROJECT/framevo/export-worker:latest .
docker push REGION-docker.pkg.dev/PROJECT/framevo/export-worker:latest

gcloud run deploy framevo-export-worker \
  --image REGION-docker.pkg.dev/PROJECT/framevo/export-worker:latest \
  --region REGION \
  --no-allow-unauthenticated \
  --memory 4Gi --cpu 4 \
  --timeout 3600 \
  --concurrency 1 \
  --min-instances 0 --max-instances 10 \
  --service-account export-worker@PROJECT.iam.gserviceaccount.com \
  --set-env-vars NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=BUCKET,WORKER_OIDC_AUDIENCE=https://WORKER_URL,EXPORT_INVOKER_SA=export-invoker@PROJECT.iam.gserviceaccount.com
```

- `--no-allow-unauthenticated` + `run.invoker` on the invoker SA keeps the worker
  private; the worker ALSO verifies the OIDC token (`aud` + `email`).
- `--concurrency 1` so one render owns the instance's CPU; scale out via instances.
- Give the worker's service account `roles/datastore.user` +
  `roles/storage.objectAdmin` (read source, write export).
- `--cpu 4` for 1080p/4K headroom. 4K60 is CPU-bound — start at 4K/30
  (`CLOUD_EXPORT_4K` flag) and validate before enabling 60fps.

## Cloud Tasks queues (priority)

Two queues target the same worker; the app picks one by plan:

```bash
gcloud tasks queues create framevo-export-normal   --location REGION
gcloud tasks queues create framevo-export-priority --location REGION \
  --max-dispatches-per-second 10 --max-concurrent-dispatches 8
```

Set in the **main app** env (and `EXPORT_DISPATCH=cloudtasks`):

| Env | Example |
|-----|---------|
| `EXPORT_DISPATCH` | `cloudtasks` |
| `EXPORT_QUEUE_LOCATION` | `us-central1` |
| `EXPORT_QUEUE_NORMAL` | `framevo-export-normal` |
| `EXPORT_QUEUE_PRIORITY` | `framevo-export-priority` |
| `EXPORT_WORKER_URL` | `https://framevo-export-worker-xxxx.run.app` |
| `EXPORT_INVOKER_SA` | `export-invoker@PROJECT.iam.gserviceaccount.com` |
| `GCLOUD_PROJECT` | `PROJECT` (or reuse `NEXT_PUBLIC_FIREBASE_PROJECT_ID`) |

The invoker SA needs `roles/run.invoker` on the worker service and
`roles/cloudtasks.enqueuer`.

## Worker env

| Env | Purpose | Default |
|-----|---------|---------|
| `PORT` | listen port | `8787` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | source/export bucket | — |
| `FIREBASE_SERVICE_ACCOUNT_B64` | creds (local; Cloud Run uses ADC) | — |
| `WORKER_OIDC_AUDIENCE` | expected token `aud` (= worker URL) | — (required in prod) |
| `EXPORT_INVOKER_SA` | expected token `email` | — |
| `DEV_DISABLE_OIDC` | skip OIDC + render in background (dev) | unset |
| `EXPORT_WORKER_DEV_SECRET` | optional dev shared-secret header | unset |
| `WORKER_X264_CRF` / `WORKER_X264_PRESET` | encode quality/speed | `19` / `veryfast` |
| `WORKER_POLL_EVERY_FRAMES` | cancel-flag + progress cadence | `30` |
| `WORKER_NORMALIZE_ENABLED` | `1` → preflight + transcode "risky" sources to H.264+AAC before render (see below) | unset (off) |
| `WORKER_NORMALIZE_CRF` / `WORKER_NORMALIZE_PRESET` | normalization pass quality/speed | `18` / `veryfast` |

## Source preflight + normalization

Before the (expensive) render commits to a source, the worker ffprobes it
(`computePreflight` in `src/preflight.ts`) and classifies it as worker-safe or
**risky** — a non-H.264 video codec, or audio that isn't AAC (transcode) or
can't be decoded at all (e.g. Apple `apac` → drop audio). When
`WORKER_NORMALIZE_ENABLED=1` and the source is risky, the worker transcodes it
to a worker-safe H.264 + AAC MP4 (`normalizeSource`), stores it at
`users/{uid}/projects/{pid}/normalized/source.mp4`, and **reuses it for future
exports** of that project (cache keyed on the original object's
`generation:md5Hash`, recorded on the `ProjectDoc`). Already-safe sources skip
normalization. Regardless of the flag, the render's `canDecodeAudio` guard still
drops undecodable audio and exports silently with a clear warning — the export
never fails because of an unsupported audio codec.

## Stale-job reconciler

Minutes are reserved at enqueue and settled/released at a terminal state. A
crashed worker would otherwise leave its job stuck non-terminal ("Rendering 0%")
forever AND leak the reservation. The worker heartbeats `updatedAt` every 60s
while alive, and **`POST /api/cron/reconcile-exports`** (in the main app) fails
any non-terminal job whose `updatedAt` is older than 10 min and releases its
reserved minutes (idempotent). Wire it on a Cloud Scheduler cron (~every 5 min)
with header `x-cron-secret: <EXPORT_RECONCILE_SECRET>`. The export panel also
shows a "stuck — cancel & retry" state client-side so the UI never sits at 0%.

## Output tiers

Default export is **1080p / 30fps**. 4K and 60fps require a paid plan (Pro+),
enforced server-side in `/api/export/cloud` (and `/api/billing/export-permit`
for the browser path) and reflected in the export panel.

## Parity test

`tests/render-parity.test.ts` (repo root) diffs worker frames against stored
browser goldens within tolerance. **Keep cloud export behind
`CLOUD_EXPORT_ENABLED` until that test is green** — blur, BT.709 color, and font
metrics are the known parity risks.
