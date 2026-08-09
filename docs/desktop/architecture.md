# Desktop architecture — the audit and the decisions

This documents the repository audit the desktop work was based on, what was
incompatible with static packaging, and the seam chosen for each problem.

---

## 1. What the web app already had

| Path | What it is | Consequence for desktop |
| --- | --- | --- |
| `src/lib/render/recipe.ts` | `buildRenderRecipe` — DOM-free, pure; resolves crop, canvas fit, base placement, cut/speed timeline map | Reusable as-is. Became the parity anchor. |
| `src/lib/render/compose-frame.ts` | `composeFrame(ctx, frame, recipe, t)` — the whole compositor, typed against `CanvasRenderingContext2D` but DOM-agnostic | Reusable as-is, on `@napi-rs/canvas`. |
| `services/export-worker/src/cli.ts` | A **local-files-only** render CLI: NDJSON progress on stdout, `cancel` on stdin, exit 0/1/2 | This *is* the desktop export engine. Nothing was rewritten. |
| `src/components/dashboard/real-editor/*` | The editor (context 2.8k lines, timeline, inspector, export panel) | Reused verbatim; only its persistence was abstracted. |
| `src/lib/firebase/materialize-project.ts` | Pure Firestore-data → `ProjectDoc` whitelist mapper | Reused by the local store, so both backends yield identical documents. |
| `src/lib/firebase/project-writer.ts` | Per-project serialized write queue, no Firebase imports | Reused unchanged by the local store. |
| `src/lib/export/editframe/build-composition.ts` | In-browser engine adapter — already proves "same recipe, different engine" | The desktop provider is its sibling. |

**The key finding:** the editor's entire persistence coupling was one
`projectRef` (a Firestore `DocumentReference`), ~28 `setDoc(ref, patch, {merge:true})`
calls, one `getDoc`, and four field sentinels (`arrayUnion`, `arrayRemove`,
`deleteField`, `serverTimestamp`). That is a single abstractable seam, not a
rewrite.

## 2. What was incompatible with static packaging

| Blocker | Why | Resolution |
| --- | --- | --- |
| `output: "standalone"` in `next.config.ts` | Requires a Node server | The desktop renderer is a **separate Next app** (`desktop/renderer`) with `output: "export"`, importing the same `src/` via the `@/` alias. The website's config is untouched. |
| 33 API route handlers | `output: "export"` refuses non-static routes | They are exactly the code that must stay server-side (Gemini, Firebase Admin, Lemon Squeezy). The desktop app **calls** them over HTTPS via `NEXT_PUBLIC_CLOUD_API_BASE`. |
| `/dashboard/projects/[id]` dynamic route | Static export needs `generateStaticParams`; project ids are created at runtime | The route is real and pre-rendered ONCE under a placeholder id; the protocol handler folds every real id onto that artifact without touching the URL, and the page reads its id from `location.pathname`. See §3 *Routing*. |
| `RealEditorPage` needed to know which backend | Local and cloud projects both open in it | The document names its own home (`userId === "local"` vs a Firebase uid); `platform.storageFor(doc)` picks the store per project. |
| 18 relative `fetch("/api/…")` call sites | No origin behind a custom protocol | One `apiFetch` helper (`src/lib/platform/api.ts`); identical to `fetch` on the web. |
| `RealEditorPage` required a Firebase user | A local project has no user | Auth gate became "can this storage load?" — cloud still requires a user, local does not. |
| `next/font/google` | Needs network at build time | Fine: fonts are downloaded and self-hosted into the static output at build time. |

## 3. The seams

### Routing — real routes, one static bundle

`desktop/renderer/src/app` mirrors the website's route tree: `/login`,
`/dashboard`, and the nine dashboard screens are all genuinely pre-rendered, so
`next/link`, `usePathname`, `router.push`, browser back/forward and a hard
reload behave exactly as they do on the web. There is no hash router and no
bespoke navigation layer.

Two things make that work with no server behind it:

* **No `assetPrefix`.** Assets resolve absolutely (`/_next/…`) from the origin
  root, which the protocol handler serves out of the bundle. A document-relative
  prefix breaks the moment a route is nested — `/dashboard/projects/_next/…`
  does not exist.
* **One artifact for the dynamic segment.** `/dashboard/projects/[id]` is
  pre-rendered under the reserved id `__project__`;
  `rewriteAppPath` (`desktop/src/main/protocol-rules.ts`) maps every real
  project id — and Next's RSC payload requests for it — onto that file. The URL
  is never rewritten, so `DesktopProjectEditor` recovers the real id from
  `location.pathname`.

Unknown extension-less paths already fall back to the app shell, so a reload of
any client route resolves rather than 404ing. `desktop/test/project-route.test.mts`
locks the two sides of the rewrite together, and the packaged E2E spec proves
each route resolves from inside `app.asar`.

### Which data comes from where

| | Firebase | SQLite (this computer) |
| --- | --- | --- |
| Owns | identity, subscriptions, plan + usage, cloud projects, analysis jobs, cloud export jobs | projects imported/recorded here, media references, autosave + recovery history, exports this machine produced |
| Needs an account | yes | no |
| Works offline | cached reads only | fully |

A project can exist in both. The local row records the Firestore id it mirrors
(`projects.cloud_project_id`), and `mergeProjectSources`
(`src/lib/projects/merge-projects.ts`) keys on it so the library lists the
project **once**, keeping the local copy — the one that opens with no network —
while adopting the cloud document's richer status/analysis.

### Persistence — `ProjectStorage`

```
editor → writeProject(patch) → ProjectStorage.write
                                   ├── cloud:  toFirestorePatch → setDoc(merge)
                                   └── local:  IPC → applyPatch → SQLite → broadcast
```

`src/lib/platform/field-value.ts` defines backend-neutral sentinels; the cloud
store maps them onto Firestore's, and `src/lib/platform/patch.ts` implements
the same semantics for SQLite (deep merge for maps, replace for arrays,
`deleteField` removes, `undefined` ignored). Both stores route through the same
write queue, with the same direct-vs-queued error semantics the code had before.

### Media — a protocol URL, not a path

A local project's `originalVideoUrl` is `framevo://app/__media/<mediaId>`.
That one decision is why the preview, the on-device CV pass, thumbnails,
mediabunny and the export all work with **zero** changes: they were already
consuming a URL. Same-origin (not a second scheme) so canvas readback is not
tainted. Range requests are implemented, because seeking depends on them.

### Export — the cloud worker, locally

```
export panel → serializeRecipeInput()  ← the SAME object a cloud job stores
             → IPC (validated)
             → child process: resources/render-cli.mjs
                  buildRenderRecipe → composeFrame (@napi-rs/canvas) → FFmpeg
```

The only addition to the shared worker was an **optional** `videoEncoder`
override (`{codec, args}`); absent ⇒ the cloud's exact `libx264` behaviour.
The desktop passes the best available hardware encoder.

## 4. Deliberate non-goals

- **No local Next.js server.** Requirement, and also the right call: a listening
  port in a desktop app is an attack surface for no benefit.
- **No second editor, timeline or compositor.** The desktop shell is ~200 lines
  of library UI plus a route hook.
- **No AI analysis on local projects.** It reads the source from Framevo's
  servers, so it needs a cloud project. The editor says so explicitly rather
  than failing deep inside the pipeline.
- **No `window.electron` checks in feature code.** One file
  (`src/lib/platform/desktop/bridge.ts`) touches the global.

## 5. Known limits

- **Cloud sign-in on desktop.** Firebase Auth's `signInWithPopup` cannot run
  from a custom-scheme origin. Cloud features therefore require a signed-in
  session, which the desktop build does not yet establish; the code paths are
  intact and gated (`cloudAvailable`), and the honest fix is a system-browser
  OAuth flow with a loopback redirect, which needs a Google **Desktop** OAuth
  client id. Local editing and export are unaffected.
- **Windows packaging on non-ASCII paths.** `rcedit` (used by both Electron
  Packager and Squirrel) cannot open such paths; the packaging script works
  around it by stamping/building in a temp ASCII directory.
- **Node zip extraction.** On the development machine, extracting the Electron
  release zip inside Node stalls, which breaks `electron-forge package`. The
  `package:win` script avoids re-extraction entirely. See packaging.md.
