# AdZoom — Firebase + Gemini setup

This is the live setup checklist. The code is wired up — these are the cloud-side steps you still have to run yourself.

## 1. Firebase project

1. Create a project at https://console.firebase.google.com.
2. **Authentication** → **Sign-in method** → enable **Google**.
3. **Firestore Database** → **Create database** → start in *production* mode.
4. **Storage** → **Get started** → start in *production* mode.
5. **Project settings** → **Your apps** → **Web app** → register an app and copy the config values.

## 2. Local env vars

Copy `.env.local.example` to `.env.local` and fill in:

```
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

For server-side admin access (used by the `/api/projects/[id]/analyze` route):

- Either set `FIREBASE_SERVICE_ACCOUNT_B64` to a base64-encoded service-account JSON, or
- Run on Firebase App Hosting / Cloud Run with Application Default Credentials.

For Gemini:

```
GEMINI_API_KEY=...           # https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-2.5-flash  # optional override
```

## 3. CORS for Storage video playback

Browsers must be allowed to load videos from Firebase Storage. Save this to `cors.json`:

```json
[
  {
    "origin": ["http://localhost:3000", "https://your-domain.example"],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Content-Type"],
    "maxAgeSeconds": 3600
  }
]
```

Apply it (replace bucket name):

```
gcloud storage buckets update gs://YOUR-BUCKET-NAME --cors-file=cors.json
```

## 4. Deploy security rules

```
npx firebase login
npx firebase use --add               # select your project
npx firebase deploy --only firestore:rules,storage:rules
```

## 5. App Hosting (optional)

```
firebase init apphosting
firebase deploy --only apphosting
```

`apphosting.yaml` declares the env-var availability (BUILD vs RUNTIME). Public Firebase vars need to be available at **BUILD** so Next.js can embed them at compile time; `GEMINI_API_KEY` and the admin key are **RUNTIME**-only.

## 6. Verify the money flow

1. `npm run dev` → visit `/`.
2. Click **Open App** → sign in with Google.
3. Click **Upload** → drop in an MP4/MOV/WebM.
4. After upload, you land on `/dashboard/projects/{id}`.
5. Click **Analyze with AI** → watch the processing overlay cycle through real stages.
6. When done, click moments on the timeline to seek and inspect.
7. Edit a moment in the right-hand inspector.
8. Click **Export** → the export runs in your browser and uploads the result to Storage.
