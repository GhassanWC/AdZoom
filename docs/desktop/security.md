# Desktop security

The renderer runs code that draws user content and talks to the network. It is
treated as untrusted. Everything below is enforced in code, not convention.

## Renderer isolation

`desktop/src/main/index.ts`:

```ts
webPreferences: {
  contextIsolation: true,      // the page cannot touch preload internals
  sandbox: true,               // OS-level renderer sandbox
  nodeIntegration: false,      // no require(), no process, no fs
  nodeIntegrationInWorker: false,
  webviewTag: false,           // no <webview> escape hatch
  webSecurity: true,           // same-origin policy stays on
}
```

- **Navigation is pinned.** `will-navigate` blocks anything that isn't
  `framevo://app` (plus the dev server in development); `setWindowOpenHandler`
  denies every popup and hands http(s) links to the user's real browser.
- **No remote code.** The renderer is a static bundle served from
  `framevo://app` by the app's own protocol handler. Nothing is fetched from a
  CDN, and there is no local HTTP server listening on a port.
- **Electron fuses** (`forge.config.ts`) disable `NODE_OPTIONS`, the CLI
  inspector, and loading an app from outside the asar, and enable asar
  integrity validation. `RunAsNode` stays ON because the export subprocess
  depends on it — that is the one deliberate exception, and it is the same
  binary re-launched with our own arguments, not an arbitrary program.

## The IPC surface

`src/lib/platform/desktop/ipc.ts` defines every channel. The preload exposes a
fixed list of functions — there is **no** generic `invoke(channel, args)`, no
filesystem read/write channel, and no shell execution.

Every handler validates before it acts:

| Input               | Rule                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| ids (project/media/output/job) | `^[A-Za-z0-9_-]{6,64}$` — CSPRNG-generated, never a path       |
| document patches    | plain JSON only; `__proto__`/`constructor`/`prototype` rejected; depth ≤ 16; ≤ 8 MB |
| titles              | control characters stripped, ≤ 200 chars, non-empty                        |
| export requests     | fps ∈ {30,60}; resolution ∈ {720p,1080p,4K}; dimensions 16–16384; moments ≤ 20000; encoder from a fixed allow-list |
| external URLs       | `http(s)` only — `file:`, `javascript:`, `data:` and custom schemes refused |
| imported files      | absolute path, no NUL, extension ∈ {.mp4,.mov,.webm,.mkv,.m4v}, real non-empty file, then probed by FFprobe |

`desktop/test/ipc-security.test.mts` exercises each of these with the payloads
an attacker would actually send.

## Paths never cross the boundary

The renderer holds **opaque handles**, never paths:

- `mediaId` → the main process maps it to the validated absolute path.
- `outputId` → the main process knows where the user chose to save; the
  renderer only ever learns the file *name*.
- "Reveal in folder" takes an `outputId`, not a path.

This is why a compromised renderer cannot ask for `C:\Users\...\.ssh\id_rsa`:
there is no channel that accepts a path at all.

## Content-Security-Policy

Set by the protocol handler on every HTML response
(`desktop/src/main/protocol-rules.ts`):

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; media-src 'self' blob: data:; font-src 'self' data:;
connect-src 'self' <api origin> https://*.googleapis.com … ; worker-src 'self' blob:;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`script-src 'unsafe-inline'` is required because a static Next export inlines
its bootstrap and there is no server to mint a nonce. `'unsafe-eval'` is
development-only. `connect-src` names the app's API origin and Firebase — not a
wildcard.

## Logging and crash reporting

`desktop/src/main/logger.ts` redacts before anything is written or sent:

- absolute paths → `«path»\filename`
- bearer tokens, API keys, Firebase ID tokens → `«token»` / `«redacted»`
- the renderer's console is **not** piped to disk (only errors, redacted)

Crash reporting is off unless `FRAMEVO_SENTRY_DSN` is set, and the event
payload goes through the same redaction. No media, no file contents, no
project text.

## What the desktop app does NOT do

- It does not upload your video. Import is a reference; cloud features are an
  explicit, separate action.
- It does not run a local web server.
- It does not ship any private credential. Server-side keys (Gemini, Firebase
  Admin, Lemon Squeezy, Google Cloud) stay on the server; the app calls the
  deployed API with the signed-in user's ID token.
- It does not auto-update unless a feed URL is configured.
