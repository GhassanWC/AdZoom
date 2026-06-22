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

## 5. Chunked rendering (long videos) — OFF by default

For videos longer than `EXPORT_CHUNK_MIN_SECONDS` (default 180s), the worker can
render in independent 60–90s chunks (retried per-chunk) and concat them into one
MP4 — so a single failed chunk retries instead of restarting the whole video.

This is **gated off** (`EXPORT_CHUNKED_RENDER=0`) until render parity is verified:
it touches the shared render core (`services/export-worker`) and currently only
chunks LINEAR timelines (no cuts/speed); a timeline with cuts/speed transparently
falls back to a single whole-video render (`chunk_unsupported_timeline`). To trial
it, set `BATCH_CHUNKED_RENDER=1` on the Next.js runtime (passed through as the
container's `EXPORT_CHUNKED_RENDER`). Tunables: `EXPORT_CHUNK_SECONDS`,
`EXPORT_CHUNK_MIN_SECONDS`, `EXPORT_CHUNK_MAX_RETRIES`.

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

# Worker logs (single-job lifecycle: [batch:single-job] start/finished, [batch:*])
gcloud logging read \
  'resource.type="batch.googleapis.com/Job" AND textPayload:"batch:single-job"' \
  --limit=50 --project="$PROJECT"
```

- Free user → `/api/export/cloud` returns 402 (no Batch job created).
- Pro/Creator → a Batch job appears; the container runs once and exits 0.
- Final MP4 lands at `users/{uid}/projects/{pid}/exports/{jobId}.mp4`.
- Job doc transitions `queued → batch_submitted → rendering → uploading → ready`.
- `gcloud batch jobs list` shows the job SUCCEEDED, then the VM is gone — no
  instance stays running, idle cost ~zero.
