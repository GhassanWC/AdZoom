# Cloud export on Google Cloud Batch

Paid (Pro/Creator) cloud export runs as a **one-shot Google Cloud Batch task**:
one container per export that claims the job, renders, uploads, writes the
terminal Firestore status, and **exits**. Nothing runs between exports, so idle
compute cost is ~zero — the goal of moving off the always-on GCE VM.

It is the **same Docker image** as the VM/Cloud Run worker. The run mode is
chosen purely by env: `EXPORT_JOB_ID` present ⇒ single-job (Batch) mode.

```
User clicks Export (Pro/Creator)
  → POST /api/export/cloud  (Next.js)
      → createCloudExportJob: plan + minutes + length gate, reserve minutes,
        create users/{uid}/exportJobs/{jobId}  (status: queued)
      → enqueueExportJob (EXPORT_BACKEND=batch) → submitBatchJob
          → Batch.createJob (image from Artifact Registry, env injected)
          → job doc → status: batch_submitted (+ batchJobId/batchJobName)
  → Batch provisions a 4 vCPU / 16 GB VM, runs the container ONCE
      → SingleJobRunner: claim → rendering → upload → ready  (then EXIT 0)
  → container + VM torn down by Batch (no idle cost)
```

Stale jobs (a container OOM-killed/preempted mid-render) are swept by the
existing `POST /api/cron/reconcile-exports` Cloud Scheduler (10-min window) —
there is no always-on reconciler in Batch mode. Batch task retries
(`BATCH_MAX_RETRY_COUNT`) re-run the container, which re-claims the still
non-terminal job (`forceReclaim`).

---

## 1. Build & push the image to Artifact Registry

Build context is the **repo root** (the render-CLI bundle inlines shared code).

```bash
PROJECT=adzoom-prod
REGION=us-central1
REPO=framevo
IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/export-api"

# One-time: create the Artifact Registry repo
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker --location="$REGION" --project="$PROJECT"

# Build (from repo root) and push
gcloud auth configure-docker "$REGION-docker.pkg.dev"
docker build -f services/export-api-dotnet/Dockerfile \
  --build-arg BUILD_VERSION="$(git rev-parse --short HEAD)" \
  -t "$IMAGE:latest" -t "$IMAGE:$(git rev-parse --short HEAD)" .
docker push "$IMAGE:latest"
docker push "$IMAGE:$(git rev-parse --short HEAD)"
```

(Or `gcloud builds submit` using `services/export-api-dotnet/cloudbuild.yaml`.)

---

## 2. Service accounts & IAM (least privilege)

Two identities are involved:

### a) Submitter (the Next.js / App Hosting runtime SA)
Whatever SA the Next.js server runs as needs to create Batch jobs and act as the
worker SA:

```bash
SUBMITTER="framevo-app@$PROJECT.iam.gserviceaccount.com"   # App Hosting runtime SA

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SUBMITTER" --role="roles/batch.jobsEditor"
# Required so Batch can run tasks AS the worker SA below:
gcloud iam service-accounts add-iam-policy-binding "$WORKER_SA" \
  --member="serviceAccount:$SUBMITTER" --role="roles/iam.serviceAccountUser"
```

### b) Worker (the SA the Batch task runs AS) — `BATCH_SERVICE_ACCOUNT`
Create a dedicated SA with ONLY what the render needs:

```bash
WORKER_SA="framevo-export-worker@$PROJECT.iam.gserviceaccount.com"
gcloud iam service-accounts create framevo-export-worker --project="$PROJECT"

# Firestore: read + update export jobs / usage ledger
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$WORKER_SA" --role="roles/datastore.user"
# Cloud Storage: read source + write output objects (scope to the bucket if possible)
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$WORKER_SA" --role="roles/storage.objectAdmin"
# Batch agent needs to write logs + report task status
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$WORKER_SA" --role="roles/logging.logWriter"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$WORKER_SA" --role="roles/batch.agentReporter"
# Pull the image from Artifact Registry
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$WORKER_SA" --role="roles/artifactregistry.reader"
# (Optional) read secrets (e.g. internal secret) from Secret Manager
# gcloud projects add-iam-policy-binding "$PROJECT" \
#   --member="serviceAccount:$WORKER_SA" --role="roles/secretmanager.secretAccessor"
```

> Tighten `storage.objectAdmin` to the specific bucket with an IAM condition or a
> bucket-level binding (`gcloud storage buckets add-iam-policy-binding`) so the
> worker can only touch the export bucket.

**No admin credentials are ever exposed to the frontend.** All Batch submission
is server-side (`src/lib/export/batch-backend.ts`, `import "server-only"`); the
worker authenticates via the Batch VM's attached SA (ADC) — no key files.

---

## 3. Next.js server env

Set these on the Next.js runtime (App Hosting / Cloud Run env or Secret Manager):

```ini
# Turn on cloud export + pick the Batch backend
CLOUD_EXPORT_ENABLED=true
NEXT_PUBLIC_CLOUD_EXPORT_ENABLED=true
EXPORT_BACKEND=batch

# Batch target (required)
BATCH_REGION=us-central1
BATCH_IMAGE=us-central1-docker.pkg.dev/adzoom-prod/framevo/export-api:latest
BATCH_SERVICE_ACCOUNT=framevo-export-worker@adzoom-prod.iam.gserviceaccount.com

# Batch sizing (optional — defaults shown). Mirrors the old VM: 4 vCPU / 16 GB.
BATCH_PROJECT_ID=adzoom-prod          # else GCLOUD_PROJECT / NEXT_PUBLIC_FIREBASE_PROJECT_ID
BATCH_MACHINE_TYPE=e2-standard-4
BATCH_CPU_MILLI=4000
BATCH_MEMORY_MIB=16384
BATCH_BOOT_DISK_GB=100                # temp space for source + chunks + output
BATCH_MAX_RUN_SECONDS=7200            # hard per-export ceiling (2h)
BATCH_MAX_RETRY_COUNT=1
BATCH_PROVISIONING_MODEL=STANDARD     # or SPOT for cheaper, preemptible VMs
# BATCH_CHUNKED_RENDER=1              # enable the worker's chunked path (see §5)

# Firebase admin (already configured for the app)
NEXT_PUBLIC_FIREBASE_PROJECT_ID=adzoom-prod
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=adzoom-prod.firebasestorage.app

# Stale-job reconciler cron secret (Cloud Scheduler → /api/cron/reconcile-exports)
EXPORT_RECONCILE_SECRET=<long-random>
```

The container receives `EXPORT_JOB_ID`, `EXPORT_JOB_UID`, `EXPORT_WORKER_MODE=single-job`,
`NODE_ENV=production`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET` (and the
`NEXT_PUBLIC_*` equivalents the worker reads) — injected per task by
`submitBatchJob`. You do **not** set `EXPORT_JOB_ID` by hand.

---

## 4. Cloud Scheduler — stale-job reconciler

Batch has no always-on reconciler, so keep (or create) the cron that fails +
refunds jobs stuck non-terminal past 10 minutes:

```bash
gcloud scheduler jobs create http framevo-reconcile-exports \
  --location="$REGION" --schedule="*/5 * * * *" \
  --uri="https://<your-app-domain>/api/cron/reconcile-exports" \
  --http-method=POST \
  --headers="x-cron-secret=$EXPORT_RECONCILE_SECRET"
```

It sweeps `queued | batch_submitted | rendering | uploading` jobs.

---

## 5. Parallel chunked rendering (long videos) — gated, default OFF

For eligible long videos, one Batch job renders **N chunks in parallel** then merges
them — same architecture (one job per export), faster wall-clock, low cost.

```
createCloudExportJob: planChunking() decides single vs chunked (renderMode on the doc)
  → submitBatchJob: ONE Batch job, taskGroup { taskCount = parallelism = workerCount }
      (workerCount = plan cap, NOT chunkCount — e.g. 24 chunks → 4–6 SHARD workers)
      → each shard worker (BATCH_TASK_INDEX = workerIndex) renders a CONTIGUOUS
        range of chunks: chunksPerWorker = ceil(EXPORT_CHUNK_COUNT / EXPORT_WORKER_COUNT);
        start = workerIndex*chunksPerWorker; end = min(chunkCount, start+chunksPerWorker).
        Source downloaded + normalized ONCE per worker. Per chunk: render window →
        upload → RecordChunkDoneAsync (per-chunk marker gates an exactly-once counter
        + writes the progress summary) → attempt merge (NotReady until all done).
      → the worker that records the LAST chunk wins TryClaimMergeAsync → concat the
        silent chunks → global audiomux → upload final → SettleSuccessAsync
  → every other worker exits 0; cancel/fail → cancelBatchJob deletes the one job
```

**Eligibility (app-side, `chunk-plan.ts`):** kill switch ON, MP4, output ≥
`EXPORT_CHUNK_MIN_VIDEO_SECONDS` (360s), and NO unsupported effect TYPES (fail-closed
allowlist: `zoom, click-highlight, cursor-focus, speed-up, cut, crop`). **Timeline-aware:
cuts + speed ARE chunkable** — chunks are sliced by OUTPUT time and the render core maps
each output frame to source time via the recipe timeline map; only an effect type the
chunk renderer can't reproduce (→ `chunk_unsupported_effects`) forces the single path.
Each chunk renders SILENT; final audio is composed once over the whole timeline and muxed
in by the merge leader (`audiomux`: video `-c copy`, audio direct/filter, `-shortest`).
`chunkCount = clamp(ceil(dur/EXPORT_CHUNK_SECONDS), 2, EXPORT_CHUNK_MAX_TOTAL_CHUNKS)` is
the TOTAL chunk count; `workerCount = min(EXPORT_CHUNK_MAX_PARALLEL_<plan>, chunkCount)`
is the Batch task count (= parallelism). **EXPORT_CHUNK_MAX_PARALLEL_\* caps the WORKER
count, not the chunk count.**

**Kill switch / rollout:** ship with `EXPORT_CHUNKED_RENDER` unset/`0` (single only).
Set `EXPORT_CHUNKED_RENDER=1` on the **Next.js** runtime to enable; the submitter
injects `EXPORT_RENDER_MODE=chunked` + `EXPORT_CHUNK_COUNT` (total) +
`EXPORT_WORKER_COUNT` (shard tasks) + `EXPORT_CHUNK_SECONDS` into the shard tasks (you
do not set those by hand). Per-task Batch timeout is fixed
(`EXPORT_CHUNK_TASK_TIMEOUT_SECONDS`, default 5400) since each worker renders many chunks.

Next.js runtime env:

```ini
EXPORT_CHUNKED_RENDER=1                 # master switch (0/unset = single only)
EXPORT_CHUNK_MIN_VIDEO_SECONDS=360
EXPORT_CHUNK_SECONDS=15                 # small chunks; many sharded onto few workers
EXPORT_CHUNK_MAX_TOTAL_CHUNKS=80
EXPORT_CHUNK_MAX_PARALLEL_PRO=4         # = WORKER (Batch task) count for Pro
EXPORT_CHUNK_MAX_PARALLEL_CREATOR=6     # = WORKER (Batch task) count for Creator
EXPORT_CHUNK_TASK_TIMEOUT_SECONDS=5400  # per shard-task Batch timeout
EXPORT_MAX_ACTIVE_BATCH_JOBS=2          # concurrent shard JOBS (each uses 4–6 VMs)
EXPORT_CHUNK_MAX_RETRY_COUNT=1          # per shard-task Batch retries
EXPORT_MERGE_LEASE_SECONDS=300          # worst-case merge < this < 600s reconcile window
EXPORT_MAX_ACTIVE_BATCH_EXPORTS=...     # global concurrency cap (optional)
# Dynamic per-task timeout tunables (optional): EXPORT_TASK_COLD_START_SECONDS,
# EXPORT_TASK_DOWNLOAD_SECONDS, EXPORT_CHUNK_RUNTIME_FACTOR, EXPORT_MERGE_BASE_SECONDS,
# EXPORT_MERGE_FACTOR, EXPORT_CHUNK_TASK_MIN_SECONDS
EXPORT_CHUNK_BOUNDARY_PADDING_SECONDS=0 # exact windows (boundaries are deterministic)
```

> Legacy in-container SEQUENTIAL chunking (`BATCH_CHUNKED_RENDER=1` →
> `EXPORT_CHUNKED_RENDER` on a single job) still exists as a fallback and is NOT used
> when `EXPORT_RENDER_MODE=chunked`.

**Idempotency invariant:** per-chunk markers gate the `chunksCompleted` increment, so
a Batch task retry re-uploads its chunk without double-counting; exactly one task
sees the count reach `chunkCount` and merges. Minutes are reserved once, settled once
(merge leader), released once (fail/cancel/reconcile).

---

## 6. Plan gating (enforced server-side)

| Plan    | Cloud export | Minutes/mo | Max video length |
|---------|--------------|-----------:|-----------------:|
| Free    | ❌ (browser only, ≤3 min upload) | 0   | —      |
| Pro     | ✅ Batch      | 150        | 30 min |
| Creator | ✅ Batch (priority) | 500  | 60 min |

`createCloudExportJob` blocks Free, enforces the length cap, reserves minutes at
creation, and settles (consume) on success / releases (refund) on failure/cancel/
stale — so minutes are only permanently deducted for exports that actually
finish. Constants live in `src/lib/usage/cloud-minutes.ts`.

---

## 7. Verify the acceptance criteria

```bash
# Watch a submitted Batch job
gcloud batch jobs list --location="$REGION" --project="$PROJECT"
gcloud batch jobs describe export-<jobid>-<suffix> --location="$REGION"

# Worker lifecycle logs. The single-job worker writes RAW stdout lines tagged
# [batch-worker] (a Cloud Logging textPayload) for every milestone — container
# started, env, claim, download, render, upload, settle, heartbeat, exit code.
# (The ILogger [batch:*] / [export:*] lines are structured jsonPayload instead, so
# grepping textPayload for those returns NOTHING — that was the old "no logs" trap.)
gcloud logging read \
  'resource.type="batch.googleapis.com/Job" AND textPayload:"[batch-worker]"' \
  --limit=100 --order=asc --project="$PROJECT"
```

- Free user → `/api/export/cloud` returns 402 (no Batch job created).
- Pro/Creator → a Batch job appears; the container runs once and exits 0.
- `[batch-worker] container started` appears within ~30s of the task entering
  RUNNING (it's the first thing the container prints, before any Firebase/ADC init).
- Final MP4 lands at `users/{uid}/projects/{pid}/exports/{jobId}.mp4`.
- Job doc transitions `queued → batch_submitted → rendering → uploading → ready`.
- `gcloud batch jobs list` shows the job SUCCEEDED, then the VM is gone — no
  instance stays running, idle cost ~zero.

### Cancellation + hang protection

- **Cancel stops the VM.** `/api/export/cancel` marks the job `canceled` (releasing
  minutes) AND calls Google Batch `cancelJob` (falling back to `deleteJob`) so the
  running VM is torn down and STOPS BILLING. The worker also polls `cancelRequested`
  every 1s and exits on its own, so the render stops even if the Batch teardown call
  fails. Verify: after canceling, `gcloud batch jobs describe …` shows the job
  heading to `CANCELLED`/`DELETION_IN_PROGRESS` and the VM disappears.
- **Startup watchdog.** If the container doesn't claim the job (→ `rendering`) within
  `BATCH_STARTUP_TIMEOUT_SECONDS` (default 120s), it fails the job with
  `errorCode: "startup_timeout"` and hard-exits (so a wedged VM can't bill to the
  `BATCH_MAX_RUN_SECONDS` ceiling). The remediation is itself time-bounded, so even a
  total Firestore outage still results in a process exit.
- **Heartbeat.** While rendering, the worker bumps `heartbeatAt` (+ `lastHeartbeatAt`,
  `updatedAt`) every 30s; the stale reconciler and the UI use it to detect a dead VM.
