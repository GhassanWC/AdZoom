# Framevo ASR worker

Dedicated Cloud Run service for transcription: ffmpeg audio extraction +
Google Speech-to-Text + caption generation + caption-quota verification +
Firestore updates — all via the **shared** pipeline in `src/lib/transcript/`
(`processTranscriptionJob`). The image contains Node 20, ffmpeg, and the
multilingual Noto font set; nothing from the .NET export API or any other
service is copied or built.

## Endpoint contract (matches `dispatchTranscription`)

```
POST /api/internal/transcribe
  header: x-internal-secret: $TRANSCRIPT_WORKER_SECRET   (REQUIRED here)
  body:   { "uid": "...", "projectId": "...", "forceRetranscribe": false }
GET /healthz → 200 {"ok":true,...}
```

The request is **held open** until ASR + quota finalization + Firestore
writes complete. The app's dispatcher aborts its fetch after ~10s by design —
deploy with `--no-cpu-throttling` so the instance keeps CPU while the job
finishes, and `--timeout 900` to bound the longest job.

## Why NOT `gcloud run deploy --source .` or `--source services\asr-worker`

- `--source .` (repo root, no root Dockerfile) → Cloud Build falls back to
  **Buildpacks**, scans the whole monorepo, and fails on the two nested .NET
  project files (`ExportApi.csproj` + `ExportApi.Tests.csproj`). That was the
  original failure — not IAM, not the Speech API.
- `--source services\asr-worker` → the upload/context is ONLY this folder, so
  the Dockerfile could never `COPY src` (the shared `src/lib` modules the
  worker imports). Imports would break.

Per the root-context rule, the build uses `services/asr-worker/cloudbuild.yaml`
with the **repo root** as context; the Dockerfile copies exactly
`services/asr-worker/` + `src/` and nothing else.

## Deploy (Windows CMD, from the repo root)

One-command path (build + deploy, mirrors the other workers):

```cmd
set PROJECT_ID=YOUR_PROJECT_ID
set REGION=us-central1
set BUCKET=YOUR_PROJECT_ID.appspot.com
set TRANSCRIPT_WORKER_SECRET=your-long-random-secret
npm run asr:deploy
```

Raw gcloud equivalent:

```cmd
gcloud builds submit --project YOUR_PROJECT_ID --config services\asr-worker\cloudbuild.yaml --substitutions _IMAGE=gcr.io/YOUR_PROJECT_ID/framevo-asr-worker:latest .

gcloud run deploy framevo-asr-worker ^
  --project YOUR_PROJECT_ID ^
  --region us-central1 ^
  --image gcr.io/YOUR_PROJECT_ID/framevo-asr-worker:latest ^
  --platform managed ^
  --allow-unauthenticated ^
  --no-cpu-throttling ^
  --memory 1Gi --cpu 1 --concurrency 4 --timeout 900 ^
  --set-env-vars TRANSCRIPT_PROVIDER=google_speech,TRANSCRIPT_WORKER_SECRET=your-long-random-secret,TRANSCRIPT_MODEL=latest_long,GOOGLE_CLOUD_PROJECT_ID=YOUR_PROJECT_ID,NEXT_PUBLIC_FIREBASE_PROJECT_ID=YOUR_PROJECT_ID,NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=YOUR_PROJECT_ID.appspot.com
```

(For Secret Manager instead of a plain env var, replace the secret entry with
`--set-secrets TRANSCRIPT_WORKER_SECRET=framevo-transcript-worker-secret:latest`.)

## After deploying — point the app at the worker

Set on the **Next app** (App Hosting env / `.env`):

```
TRANSCRIPT_EXECUTION=worker
TRANSCRIPT_WORKER_URL=https://framevo-asr-worker-....run.app
TRANSCRIPT_WORKER_SECRET=<same secret>
```

## Runtime requirements

- **APIs**: Cloud Speech-to-Text enabled on the project.
- **Runtime service account roles**: Firestore user (project/ledger writes),
  Storage object admin on the bucket (long-audio FLAC uploads under
  `transcripts/tmp/`), and token creation is via ADC (no key file needed).
- Auth to Google APIs uses ADC on Cloud Run; `FIREBASE_SERVICE_ACCOUNT_B64`
  is only needed off-GCP.

## Local build & smoke

```cmd
npm run asr:install
npm run asr:typecheck
npm run asr:build
docker build -f services\asr-worker\Dockerfile -t framevo-asr-worker .
docker run --rm -p 8080:8080 -e TRANSCRIPT_WORKER_SECRET=dev framevo-asr-worker
curl http://localhost:8080/healthz
```
