# AdZoom Deployment Runbook

This document is the source of truth for shipping AdZoom to dev and
production. **No deploy command should run that isn't documented here.**

## Projects at a glance

| Alias  | Firebase project ID | Env file              | Audience            |
|--------|---------------------|-----------------------|---------------------|
| `dev`  | `adzoomdev`         | `.env.local`          | You + collaborators |
| `prod` | `adzoom-prod`       | `.env.production`     | Real customers      |

The mapping above is canonical. It appears in three places that must
stay in lockstep:
- [`.firebaserc`](.firebaserc) — Firebase CLI project aliases
- [`scripts/deploy-rules.mjs`](scripts/deploy-rules.mjs) — `PROJECT_IDS`
  map
- [`scripts/firebase-active.mjs`](scripts/firebase-active.mjs) —
  `EXPECTED` map

If you rename a project, update all three in the same commit.

## Who am I right now?

Before any deploy command, run:

```bash
npm run fb:whoami
```

This prints the Firebase CLI's active alias, the project id baked into
`.env.local` and `.env.production`, and the expected mapping. It exits
non-zero if any env file disagrees with the expected mapping — making it
safe to chain into CI.

---

## Part 1 — One-time Firebase Console setup (manual)

These steps cannot be safely scripted. Do them in the
[Firebase Console](https://console.firebase.google.com/).

### For the `adzoom-prod` project (do once, before first prod deploy)

1. **Verify the project exists.** Open the console; confirm
   `adzoom-prod` is listed. If not, create it.
2. **Enable Authentication providers.** Console → Authentication →
   Sign-in method. Enable the same providers the dev project uses
   (Email/Password, Google, anything else). Authorised domains: add
   your live custom domain(s) when ready.
3. **Create the Firestore database.** Console → Firestore Database →
   Create. Pick **Native mode**, region matching dev. Start in
   **production rules** mode (locked) — the rules deploy below will
   overwrite them anyway.
4. **Enable Cloud Storage.** Console → Storage → Get started. Pick
   the same region as Firestore.
5. **Generate a service-account key.** Console → Project settings →
   Service accounts → Generate new private key. Save the JSON, then
   base64-encode it (`base64 -w0 key.json` or
   `[Convert]::ToBase64String([IO.File]::ReadAllBytes("key.json"))`
   on PowerShell). You'll paste the result into App Hosting secrets
   (Part 3) and optionally into `.env.production` (Part 2).
6. **Register a web app.** Console → Project settings → Your apps →
   Add app → Web. Note the six `firebaseConfig` values — they fill
   the `NEXT_PUBLIC_FIREBASE_*` variables.
7. **App Hosting backend.** Console → App Hosting → Create backend.
   Connect the GitHub repo + the branch you want auto-deployed (e.g.
   `main` or `prod`). Note the **backend ID** that App Hosting
   assigns — you'll use it in Part 3.

### For the `adzoomdev` project

Already provisioned. The same setup should apply (Auth providers,
Firestore in production rules, Storage, service-account key, App
Hosting backend on a dev branch).

---

## Part 2 — Local environment files

### Dev

```bash
cp .env.local.example .env.local
# Fill in the values from adzoomdev project (Console → Project settings
# → Your apps; also Service accounts for FIREBASE_SERVICE_ACCOUNT_B64).
```

After this, `npm run dev` and the `scripts/*` deploy commands will
target `adzoomdev`.

### Production (local prod-style testing only)

`.env.production` is for running the prod build on your machine to
verify it before pushing. App Hosting reads its real secrets from
Google Secret Manager (Part 3), not from this file.

```bash
cp .env.production.example .env.production
# Paste adzoom-prod values. DO NOT commit this file (it's gitignored).
```

Then test the prod build locally:

```bash
NODE_ENV=production npm run build
npm start
# → http://localhost:3000, fully prod build against adzoom-prod.
```

---

## Part 3 — Production App Hosting secrets

For each variable listed in [`apphosting.yaml`](apphosting.yaml),
register a secret in the **prod** project. Run these once.

```bash
firebase use prod   # one-time alias switch

firebase apphosting:secrets:set NEXT_PUBLIC_FIREBASE_API_KEY            --project=prod
firebase apphosting:secrets:set NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN        --project=prod
firebase apphosting:secrets:set NEXT_PUBLIC_FIREBASE_PROJECT_ID         --project=prod
firebase apphosting:secrets:set NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET     --project=prod
firebase apphosting:secrets:set NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID --project=prod
firebase apphosting:secrets:set NEXT_PUBLIC_FIREBASE_APP_ID             --project=prod

firebase apphosting:secrets:set GEMINI_API_KEY                          --project=prod
firebase apphosting:secrets:set FIREBASE_SERVICE_ACCOUNT_B64            --project=prod

firebase apphosting:secrets:set LEMONSQUEEZY_API_KEY                    --project=prod
firebase apphosting:secrets:set LEMONSQUEEZY_STORE_ID                   --project=prod
firebase apphosting:secrets:set LEMONSQUEEZY_WEBHOOK_SECRET             --project=prod
firebase apphosting:secrets:set LEMONSQUEEZY_PRO_VARIANT_ID             --project=prod
firebase apphosting:secrets:set LEMONSQUEEZY_CREATOR_VARIANT_ID         --project=prod
```

Each command prompts you to paste the value. The secret is stored in
Google Secret Manager under the prod project; App Hosting reads it at
build and runtime.

Repeat the same set for `--project=dev` if you also want App Hosting
to host a dev backend (recommended for staging).

---

## Part 4 — Verify the build BEFORE deploying

Always run these locally first. If they fail, the deploy will fail too
— better to find out without burning a backend rollout.

```bash
npm run typecheck   # tsc --noEmit
npm run build       # next build
```

`build` produces the `.next/` output. App Hosting will repeat this
inside its own container — running it locally just catches issues
faster.

---

## Part 5 — Deploy commands

### Rules and indexes (Firestore + Storage)

These do NOT touch the Next.js app — they just publish security
rules and Firestore indexes to the named project.

```bash
# Dev (safe, fast, hit it as often as you want)
npm run deploy:rules:dev          # Firestore + Storage rules
npm run deploy:indexes:dev        # Firestore indexes
npm run deploy:dev                # Both, in order

# Production (guarded — see safety notes below)
npm run deploy:rules:prod         # Prompts for confirmation
npm run deploy:rules:prod -- --yes
npm run deploy:indexes:prod
npm run deploy:prod               # Both, in order
```

The `deploy-rules.mjs` script enforces three guards:
1. `.env.local` (for `--project=dev`) or `.env.production` (for
   `--project=prod`) must have `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   matching the expected id.
2. The service-account key's `project_id` must match too.
3. `--project=prod` requires either `--yes` or typing the literal
   project id at an interactive prompt.

The indexes deploy uses the `firebase` CLI directly (Firebase doesn't
expose indexes via a comparable REST shortcut). Make sure you've run
`firebase login` once on this machine, or use a service-account
token via `GOOGLE_APPLICATION_CREDENTIALS`.

### Hosting (App Hosting backends)

App Hosting builds the Next.js app from a connected GitHub branch.
Two paths:

**Auto-deploy (default).** Push to the connected branch and App
Hosting builds + rolls out automatically. The branch is configured
in the Console when you created the backend.

**Manual rollout.** When you want to deploy without pushing
(e.g. backfill a failed rollout):

```bash
# List backends to find the BACKEND_ID
firebase apphosting:backends:list --project=prod

# Create a rollout from a specific commit / branch
firebase apphosting:rollouts:create <BACKEND_ID> \
  --git-branch=main \
  --project=prod
```

Track the rollout in Console → App Hosting → your backend → Rollouts.

---

## Part 6 — Post-deploy smoke tests (in this exact order)

Hit your prod URL (Console → App Hosting → backend → domain).

1. **Login / signup.** Create a brand new account with a throw-away
   email. Confirm the verification email arrives and clicking it
   logs you in.
2. **Firestore permissions.** Open the Settings page →
   API keys. Create a key. Confirm it appears in the list (proves
   `users/{uid}/apiKeys/{keyId}` reads work) and that no Firestore
   permission errors hit the console.
3. **Storage permissions.** Upload a small (≤ 20 MB) test recording.
   Confirm upload completes (proves `users/{uid}/projects/...`
   storage rules allow write).
4. **AI analysis.** Click Analyze. Wait. Confirm Gemini returns,
   moments appear on the timeline. If you see "GEMINI_API_KEY is
   not set", the secret didn't propagate — re-run
   `firebase apphosting:secrets:set GEMINI_API_KEY --project=prod`.
5. **Save project.** Drag a moment, change a preset. Refresh the
   page. Confirm the change survives (proves Firestore write +
   read of `users/{uid}/projects/{id}` works).
6. **Export.** Render a 1080p export. Confirm the download arrives.
7. **API key smoke.** Copy a plaintext API key from creation,
   `curl -H "Authorization: Bearer ak_test_…" https://<prod-domain>/api/v1/me`
   → expect `{ uid, keyId, type }`.
8. **Chatbot.** Open the floating chat bubble. Ask "What's in the
   Pro plan?". Confirm streamed response.
9. **Notifications + search (dashboard).** Confirm the navbar
   notifications dropdown loads and search returns recent projects.
10. **Rules denial check.** Open browser devtools → console. Run
    `await firebase.firestore().collection("apiKeyIndex").get()`
    (you'd need the Firebase JS SDK loaded — easier: try to fetch a
    sibling user's project doc by ID). Expect permission-denied.

If any of 1-10 fail, the rules / secrets / backend are
mis-configured. Don't open the gates to real customers until all 10
pass.

---

## Safety guarantees this runbook gives

- **Project mismatch is fatal.** `deploy-rules.mjs` cross-checks
  three independent signals (CLI flag, env file, service-account
  key) before writing rules. A misconfigured env file fails at
  step 1, not at the customer.
- **Prod requires explicit consent.** Every prod-targeting npm
  script either prompts for typed confirmation or requires `--yes`.
- **Secrets never live in git.** `.env*` is gitignored; only the
  `.example` templates are committed.
- **Hosting is git-driven.** Production code only ships via
  `git push` to the App Hosting branch (or a deliberate
  `apphosting:rollouts:create`). Nothing runs `firebase deploy
  --only hosting` against prod.

## Quick reference

```
npm run fb:whoami              # show active project + env file state
npm run fb:use:dev              # switch CLI to dev
npm run fb:use:prod             # switch CLI to prod
npm run typecheck
npm run build

npm run deploy:rules:dev        # firestore + storage rules → dev
npm run deploy:rules:prod       # firestore + storage rules → prod (guarded)
npm run deploy:indexes:dev      # firestore indexes → dev
npm run deploy:indexes:prod     # firestore indexes → prod
npm run deploy:dev              # rules + indexes → dev
npm run deploy:prod             # rules + indexes → prod (guarded)
```

For App Hosting (Next.js app): push to the connected branch, or use
`firebase apphosting:rollouts:create` per Part 5.
