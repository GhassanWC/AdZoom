# Framevo Desktop

The Framevo editor, running locally: import a video from your computer, edit it
with the same timeline the website has, and export an MP4 with your GPU — no
upload, no account, no network required.

This is **not** a second product. The desktop app renders the same React
components, uses the same edit model, and exports through the same render core
as framevo.app. What differs is where the data lives and who does the encoding.

---

## How it fits together

```
desktop/
  src/main/        Electron main process — windows, protocol, SQLite, export
  src/preload/     the ONLY renderer↔main bridge (contextBridge, no Node)
  renderer/        a static Next.js export of the SHARED src/ components
  scripts/         dev launcher, renderer build, Windows packaging
  test/ e2e/       unit tests (node:test) and Electron integration tests

src/lib/platform/  the ports both platforms implement (see below)
```

### The platform ports

`src/lib/platform` is what lets one editor serve two runtimes. UI code never
asks "am I in Electron?" — it asks the platform for a capability:

| Port             | Browser                            | Desktop                                   |
| ---------------- | ---------------------------------- | ----------------------------------------- |
| `ProjectStorage` | Firestore (`users/{uid}/projects`) | SQLite (`framevo-library.db`) over IPC    |
| `MediaService`   | `canPickLocalFiles: false`         | OS file picker → validated path reference  |
| `ExportService`  | `null` (browser/cloud engines)     | local render subprocess + GPU encoder      |
| `PlatformBridge` | `kind: "web"`                      | `kind: "desktop"`, app info, external links |

`window.framevo` is touched in exactly one file:
`src/lib/platform/desktop/bridge.ts`. If you need a new desktop capability, add
it to the port — do not sniff the runtime somewhere else.

### One render recipe, four engines

Preview, in-browser export, cloud export and desktop export all build the same
`RenderRecipe` from the same inputs (`src/lib/render/recipe.ts`) and composite
with the same `composeFrame` (`src/lib/render/compose-frame.ts`). The desktop
app runs `services/export-worker`'s render CLI — the cloud worker's code —
bundled to `resources/render-cli.mjs`.

`tests/desktop-export-parity.test.ts` asserts the recipes are deep-equal, so a
desktop-only tweak fails CI instead of silently drifting.

---

## Local setup

```bash
npm install                 # the web app (repo root)
npm run desktop:install     # the desktop package
npm run desktop:dev         # Next dev server + Electron
```

`desktop:dev` starts the renderer on `:3010` and opens Electron against it, so
editing anything under `src/` hot-reloads inside the desktop window.

### Required tooling

- **Node 22+** (the repo is developed on Node 26).
- **No native toolchain.** The database is Node's built-in `node:sqlite`
  (Drizzle's `sqlite-proxy` driver), and the only native addon
  (`@napi-rs/canvas`) ships as a prebuilt N-API binary. There is no node-gyp,
  no Visual Studio, no Python, and no `electron-rebuild` step.

---

## Environment variables

| Variable                       | Where        | Effect                                                                 |
| ------------------------------ | ------------ | ---------------------------------------------------------------------- |
| `NEXT_PUBLIC_CLOUD_API_BASE`   | build time   | Origin for `/api/*` (AI analysis, captions, billing). Unset ⇒ local-only. |
| `FRAMEVO_UPDATE_FEED_URL`      | runtime      | Enables auto-update. Unset ⇒ the updater never runs.                   |
| `FRAMEVO_SENTRY_DSN`           | runtime      | Enables crash reporting. Unset ⇒ nothing is sent anywhere.             |
| `FRAMEVO_FFMPEG_PATH` / `_FFPROBE_PATH` | runtime | Override the bundled FFmpeg (also passed to the render subprocess).    |
| `WINDOWS_CERTIFICATE_FILE` / `_PASSWORD` | package | Code signing. Unset ⇒ an unsigned (but installable) build.        |
| `APPLE_ID` / `APPLE_ID_PASSWORD` / `APPLE_TEAM_ID` | package | macOS notarisation.                              |

**No secret is ever bundled.** Gemini, Firebase Admin, Google Cloud and Lemon
Squeezy credentials stay on the server; the desktop app calls the deployed API
with the user's Firebase ID token, exactly like the website.

---

## Commands

| Command                        | What it does                                            |
| ------------------------------ | ------------------------------------------------------- |
| `npm run dev`                  | the website (unchanged)                                 |
| `npm run build`                | the website's production build (unchanged)              |
| `npm run desktop:dev`          | desktop development (renderer + Electron)               |
| `npm run desktop:build`        | bundles + the static renderer                           |
| `npm run desktop:package`      | Windows package **and installer** (see packaging.md)    |
| `npm run desktop:make`         | the same via Electron Forge                             |
| `npm test`                     | web unit tests (`node --test`)                          |
| `npm run desktop:test`         | desktop unit tests (IPC, library, media, encoders, export) |
| `npm run desktop:test:e2e`     | Electron integration tests (real import/edit/export)    |
| `npm run desktop:audit`        | fails if a secret or dev config reached the package     |
| `npm run desktop:release`      | hashes artifacts → checksums + the website's manifest   |
| `npm run desktop:release:upload` | uploads to Firebase Storage (verifies hashes first)   |
| `npm run typecheck`            | the web app                                             |
| `npm run desktop:typecheck`    | main + preload                                          |

---

## Where things live at runtime

| Path                                        | Contents                                  |
| ------------------------------------------- | ----------------------------------------- |
| `%APPDATA%\Framevo\framevo-library.db`      | projects, media references, autosaves     |
| `%APPDATA%\Framevo\logs\framevo-desktop.log`| redacted application log                  |
| `resources/app/`                            | the static renderer                       |
| `resources/ffmpeg/`                         | ffmpeg + ffprobe + licence                |
| `resources/render-cli.mjs`                  | the shared render core                    |
| `resources/node_modules/@napi-rs/`          | the canvas addon the renderer core needs  |

Your **video files are never copied**. The library stores a validated absolute
path plus size/mtime; if the file moves, the project says so instead of
silently breaking.

---

## Further reading

- [architecture.md](./architecture.md) — the audit this was built from, and why each seam is where it is
- [security.md](./security.md) — sandboxing, IPC validation, CSP, what the renderer can and cannot reach
- [packaging.md](./packaging.md) — building the installer, output locations, macOS notes
- [ffmpeg-licensing.md](./ffmpeg-licensing.md) — which FFmpeg ships, the obligations, how to swap it
- [code-signing.md](./code-signing.md) — Windows/macOS signing and the credentials you need
- [releases.md](./releases.md) — cutting a release, the publish interlock, auto-update
- [website-integration.md](./website-integration.md) — the download page, the desktop-first gate, deep links, analytics
