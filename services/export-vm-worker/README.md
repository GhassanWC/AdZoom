# Framevo export worker on a Google Compute Engine VM

Run the Framevo cloud-export renderer on a **long-lived GCE VM** instead of Cloud
Run. Cloud Run shuts the instance down mid-render on 2–3 min FFmpeg jobs; a VM
process has no request lifecycle, so renders run to completion.

**It reuses the existing C# export-api image as-is** — the `ExportRunner`
background service already polls Firestore, claims jobs with a heartbeat lease,
renders via the bundled Node CLI + ffmpeg, uploads the MP4, and writes status
back to Firestore. The only differences are *where* it runs (a VM) and *how* it's
woken (the Firestore poller, not an HTTP signal).

```
Next.js / App Hosting ── creates exportJob doc ──▶ Firestore
                                                      │  (VM polls every 5s)
                                                      ▼
                         GCE VM worker ── claim ▶ download ▶ normalize ▶ render
                                       ▶ upload MP4 ▶ status=ready
```

Files here:
- `docker-compose.yml` — runs the export-api image in VM-worker mode.
- `.env.example` — copy to `.env`; prod defaults, no secrets.
- `framevo-export-worker.service` — systemd unit (restart on crash/reboot).
- `setup-ubuntu.sh` — installs Docker, auth, the unit.

All commands assume the **prod** project. Override the obvious values for other
environments.

---

## 0. Prerequisites (run once, from the repo root on your workstation)

```bash
gcloud auth login
gcloud config set project adzoom-prod
```

Variables used below:

```bash
PROJECT=adzoom-prod
REGION=us-central1
ZONE=us-central1-a
BUCKET=adzoom-prod.firebasestorage.app
SA=export-api@adzoom-prod.iam.gserviceaccount.com   # reuse the export-api runtime SA
IMAGE=us-central1-docker.pkg.dev/adzoom-prod/framevo/export-api:latest
```

---

## 1. Build + push the image

The VM pulls the **same image** the Cloud Run export-api uses. If you've recently
run `npm run export-api:deploy`, the image already exists — skip to step 2.
Otherwise build it without touching Cloud Run (build context **must** be the repo
root):

```bash
gcloud builds submit \
  --project="$PROJECT" \
  --config=services/export-api-dotnet/cloudbuild.yaml \
  --substitutions=_IMAGE="$IMAGE",_BUILD_VERSION="$(git rev-parse --short HEAD)" \
  .
```

This image bundles the latest render core, so it includes the always-on
normalization (the MOV/APAC multi-audio-stream fix) and the `canvas.data()`
memory fix. `_BUILD_VERSION` stamps the git sha into the image so the running
build is verifiable in the logs (see step 5).

---

## 2. Service account + IAM

Reuse the existing `export-api` runtime SA. Confirm it has the three roles the
worker needs (idempotent — safe to re-run):

```bash
# Firestore read/write (claim, heartbeat, settle).
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/datastore.user"

# Pull the image from Artifact Registry.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/artifactregistry.reader"

# Read source + write output objects on the bucket (GetObject/Patch/Download/Upload).
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"
```

---

## 3. Create the VM

`e2-standard-4` (4 vCPU / 16 GB) matches the Cloud Run sizing; `cloud-platform`
scope + the SA's IAM roles govern access (ADC needs no key file).

```bash
gcloud compute instances create framevo-export-worker \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --machine-type=e2-standard-4 \
  --boot-disk-size=50GB \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --service-account="$SA" \
  --scopes=https://www.googleapis.com/auth/cloud-platform
```

---

## 4. Deploy the worker onto the VM

Copy this directory up and run the setup script:

```bash
gcloud compute scp --zone="$ZONE" --recurse \
  services/export-vm-worker framevo-export-worker:~/export-vm-worker

gcloud compute ssh framevo-export-worker --zone="$ZONE" \
  --command="cd ~/export-vm-worker && bash setup-ubuntu.sh"
```

The defaults in `.env.example` target prod, so no edits are needed. To change
anything, edit `/opt/framevo/export-vm-worker/.env` on the VM and
`sudo systemctl restart framevo-export-worker`.

**Verify startup:**

```bash
gcloud compute ssh framevo-export-worker --zone="$ZONE" \
  --command="sudo docker logs --tail=50 framevo-export-worker && curl -s localhost:8080/health"
```

Expect:
- `[vm-worker:startup] build=<git sha> mode=firestore-poll runWorker=True ... creds=ADC(metadata SA)`
- `[vm-worker:poll] idle` (repeating)
- `ok` from `/health`

**Confirm the build is current** — the `build=` on the startup line must match the
sha you deployed. If it shows an older sha (or `unknown`/`dev`), the VM is running
a stale image: rebuild (step 1) and `docker compose pull` + restart (Operations).

---

## 5. Point Next.js at the VM backend

Set these on **App Hosting / Next.js** and redeploy:

| Env | Value | Why |
|-----|-------|-----|
| `EXPORT_BACKEND` | `vm` | Create the job only; the VM poller renders it (no Cloud Tasks, no HTTP signal). |
| `CLOUD_EXPORT_ENABLED` | `true` | Server gate — `/api/export/cloud` creates jobs. |
| `NEXT_PUBLIC_CLOUD_EXPORT_ENABLED` | `true` | Client gate — shows the cloud-export UI. |
| `EXPORT_API_URL` | *(unset)* | Nothing points at Cloud Run for rendering/cancel. |

Cancellation still works without Cloud Run: `/api/export/cancel` falls back to its
authoritative Firestore transaction (sets `cancelRequested` + releases minutes),
which the VM's per-job cancel poll reads.

---

## 6. Disable Cloud Run rendering

So the VM is the **only** renderer (no double-claim, no mid-render shutdown), do
ONE of these to the Cloud Run `export-api` service:

```bash
# (a) RECOMMENDED — keep a cheap /health + control endpoint, stop it claiming jobs:
gcloud run services update export-api --project="$PROJECT" --region="$REGION" \
  --update-env-vars=EXPORT_WORKER_MODE=disabled

# (b) Or scale it to zero:
gcloud run services update export-api --project="$PROJECT" --region="$REGION" \
  --min-instances=0

# (c) Or remove it entirely:
gcloud run services delete export-api --project="$PROJECT" --region="$REGION"
```

With `EXPORT_WORKER_MODE=disabled`, the Cloud Run instance serves HTTP only and
never registers the `ExportRunner`/`Reconciler` — so it logs no `[export:claim]`.

---

## 7. Proof (run BEFORE any pricing/plan changes)

From the app, run a cloud export for each scenario and confirm the job reaches
`status: ready` with a downloadable MP4 — no Cloud Run involvement, no audio crash.

1. **Clean MP4, ~2–3 min** — proves long renders survive (the Cloud Run failure).
2. **MOV with weird / APAC audio** — proves the multi-audio-stream fix: audio is
   preserved if any stream is decodable, else the export is silent + warned.
3. **Existing project with no normalized cache** — proves in-job normalization
   runs before the render for older projects.

Watch the VM logs during each:

```bash
gcloud compute ssh framevo-export-worker --zone="$ZONE" \
  --command="sudo docker logs -f framevo-export-worker"
```

Expected milestone sequence per job (the `cli-version` + `render-input` lines
PROVE the latest code ran and exactly what the renderer read):

```
[vm-worker:poll] claimable=1
[vm-worker:claim] uid=… jobId=…
[vm-worker:cli-version] job=… cliVersion=2025.06-normalize+canvasdata build=<sha>
[vm-worker:normalize-start] job=…
[vm-worker:normalize-ready] job=…
[vm-worker:render-input] job=… input=…/source.mov normalizedFile=…/normalized-source.mp4 wasNormalizationRun=True renderSource=…/normalized-source.mp4
[vm-worker:render-start] job=…
[vm-worker:progress] job=… pct=…          # rssMB stays flat (no leak)
[vm-worker:upload-start] job=…
[vm-worker:complete] job=… minutes=… audio=preserved|removed|none
```

If `wasNormalizationRun=False` (or `cli-version`/`normalize-start` never appear),
the worker is **not** normalizing — the job FAILS with `normalize_not_executed`
rather than silently rendering the original. That almost always means a **stale
image**: rebuild (step 1) and redeploy (Operations).

Pass criteria: Firestore `exportJobs/{id}.status == "ready"`, the MP4 exists under
`users/{uid}/projects/{pid}/exports/{jobId}.mp4` in `gs://adzoom-prod.firebasestorage.app`,
it downloads + plays, and the Cloud Run service logged **no** `[export:claim]` for
those jobs. For scenario 2, `audio_removed_unsupported` (if it fired) shows in the
export panel and the job's `warnings[]`.

> Local render-core check before deploying (catches normalization regressions):
> `npm run worker:build && npm --prefix services/export-worker run test:e2e`

---

## Operations

```bash
# Roll out a new image (after step 1 rebuilds :latest):
gcloud compute ssh framevo-export-worker --zone="$ZONE" --command="\
  sudo docker compose -f /opt/framevo/export-vm-worker/docker-compose.yml --env-file /opt/framevo/export-vm-worker/.env pull && \
  sudo systemctl restart framevo-export-worker"

# Tail logs / status:
gcloud compute ssh framevo-export-worker --zone="$ZONE" --command="sudo docker logs -f framevo-export-worker"
gcloud compute ssh framevo-export-worker --zone="$ZONE" --command="sudo systemctl status framevo-export-worker"

# Stop / start:
gcloud compute ssh framevo-export-worker --zone="$ZONE" --command="sudo systemctl stop framevo-export-worker"
```

A clean shutdown (`systemctl stop`, VM reboot) leaves an in-flight job at
`rendering`; its heartbeat lease goes stale and the worker re-claims it on the
next poll (or the reconciler fails it after the stale window). No job is lost.
