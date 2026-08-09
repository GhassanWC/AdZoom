# Releases, distribution and updates

The website never hard-codes an installer URL. It reads ONE generated record —
`src/lib/desktop/current-release.ts` — which carries the version, the release
notes, and each artifact's URL, exact byte size and SHA-256. Everything on
`/download`, the `/api/desktop/*` endpoints and the desktop gate comes from it.

That record also holds the safety interlock: `status` is `"draft"` until a
packaged build has actually passed end-to-end verification.

## The publish interlock

While `status: "draft"`:

- `/api/desktop/download` returns **503** instead of redirecting, so the
  production download is not replaced by an unverified build;
- `/download` renders a "not available yet" state instead of a button;
- **the desktop gate does not block web editing.**

That last point is the reason the two are one flag rather than two. A gate that
pushes people toward an installer that doesn't exist strands every user on the
website with no way forward, so publishing turns the download on and the gate on
in the same edit — and reverting it rolls back both.

`tests/desktop-distribution.test.ts` asserts the committed release is a draft.
That test failing is the intended prompt to ask "was this verified?".

## Cutting a release

```bash
# 1. Version + notes
#    - bump desktop/package.json "version"
#    - add a "## <version>" section at the top of desktop/RELEASE_NOTES.md

# 2. Build (production config is the default; see packaging.md)
npm run desktop:package            # Windows  → out/make/squirrel.windows/x64/
npm --prefix desktop run make      # macOS    → run this ON a Mac

# 3. Prove nothing private got baked in
npm run desktop:audit

# 4. Describe the artifacts (hashes, sizes, notes) — still a DRAFT
npm run desktop:release

# 5. Verify the packaged app (see the checklist below)

# 6. Upload, then publish
npm run desktop:release:upload
npm run desktop:release -- --base-url https://storage.googleapis.com/<bucket>/desktop/releases --publish
```

### What each script does

| Script                        | Does                                                                 | Never does |
| ----------------------------- | -------------------------------------------------------------------- | ---------- |
| `desktop:audit`               | Scans every packaged file for secret values and dev configuration     | Print a secret value |
| `desktop:release`             | Hashes artifacts, writes `checksums.txt`, regenerates the manifest    | Upload, or publish without `--publish` |
| `desktop:release:upload`      | Uploads to Firebase Storage, verifies hashes first                    | Upload a build whose hash disagrees with the manifest |

## The secret audit

`npm run desktop:audit` fails the release if it finds, byte-for-byte, in any
packaged file:

1. **any non-public env value** (service account, OAuth client *secret*, API
   keys, webhook secrets) — the names are reported, the values never are;
2. **development configuration** in a production build (the dev Firebase project
   or dev OAuth client);
3. **a missing production identifier**, which would mean the bundle wasn't built
   with production config and checks 1–2 passed for the wrong reason.

Public by design, and deliberately not flagged: every `NEXT_PUBLIC_*` value and
the desktop OAuth **client id** (it appears in the authorization URL the user's
own browser loads). The client **secret** lives only on the server — see
[security.md](./security.md).

## Storage layout

Firebase Storage, under the production bucket:

```
desktop/releases/<version>/Framevo-Setup.exe     immutable, cached forever
desktop/releases/<version>/checksums.txt         what a user verifies against
desktop/releases/stable/RELEASES                 Squirrel's manifest (60s cache)
desktop/releases/stable/Framevo-<v>-full.nupkg   what the updater downloads
```

Versioned paths are immutable, so any URL ever handed out keeps working. The
`stable/` prefix is the moving update feed and is short-cached on purpose.

Objects are uploaded with a public-read ACL because Squirrel fetches
`<feed>/RELEASES` as a plain URL. If the bucket has uniform bucket-level access
enabled, grant it once instead:

```bash
gcloud storage buckets add-iam-policy-binding gs://<bucket> \
  --member=allUsers --role=roles/storage.objectViewer
```

## Auto-update

Ships in every build, dormant until `FRAMEVO_UPDATE_FEED_URL` is set (the
release script writes it into the manifest as `<base>/stable`).

- checks on launch, then every 6 hours;
- downloads in the background;
- **never interrupts an export** — Squirrel stages the update and applies it on
  quit; the user is offered "Restart now / Later";
- a failed check is logged and ignored, never surfaced as an error;
- development builds never check, regardless of the variable.

Windows uses Squirrel.Windows (a directory URL); macOS uses Squirrel.Mac and the
same code path builds `…/darwin/<arch>/RELEASES.json?version=<v>`.

### Rollback

Squirrel installs the newest version in `RELEASES`. To roll back, ship a bumped
rebuild of the good version rather than re-uploading an old one — clients that
already updated only move on a HIGHER version number. Separately, set the
website manifest back to `status: "draft"` (or re-point it at the previous
version) so new downloads stop immediately.

## Verification checklist

Nothing is published until all of these pass on the target OS. The ones marked
**clean machine** cannot be judged from a development box — install state is
exactly what they test.

- [ ] `npm run desktop:test` and `npm run desktop:test:e2e` green
- [ ] `npm run desktop:audit` passes against the packaged output
- [ ] Sign-in works against the **production** Firebase project
- [ ] A cloud project opens, edits, and syncs back
- [ ] A local project opens and edits with the network off
- [ ] Local export produces a playable MP4
- [ ] Uploading media to Firebase Storage succeeds
- [ ] `framevo://open/dashboard/projects/<id>` focuses the app on that project
- [ ] **clean machine** — install on a machine that has never run Framevo
- [ ] **clean machine** — upgrade over the previous version, projects intact
- [ ] **clean machine** — uninstall leaves no service running and no orphaned data
- [ ] Auto-update: a bumped build in the feed is offered and installs on quit
- [ ] Installer is signed (`Get-AuthenticodeSignature` / `spctl -a -vv`)

## Checklist for a first public release

- [ ] Windows code-signing certificate configured (see [code-signing.md](./code-signing.md))
- [ ] Apple Developer ID + notarisation configured, and the mac build made on a Mac
- [ ] FFmpeg licensing decision ratified (see [ffmpeg-licensing.md](./ffmpeg-licensing.md))
- [ ] `NEXT_PUBLIC_CLOUD_API_BASE` pointed at production
- [ ] `FRAMEVO_SENTRY_DSN` set if you want crash reports
- [ ] Update feed reachable at `<base>/stable/RELEASES`
- [ ] `status: "published"` — last, and only after the list above
