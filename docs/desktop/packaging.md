# Packaging

## Build it

```bash
npm run desktop:package     # Windows: packaged app + Setup .exe
```

That runs, in order:

1. `esbuild.mjs` → `.vite/main.js`, `.vite/preload.js`, `.vite/render-cli.mjs`
2. `scripts/build-renderer.mjs` → `renderer/out/` (a static Next export)
3. `scripts/stage-resources.mjs` → `.resources/` (renderer, FFmpeg, render CLI,
   migrations, the canvas addon)
4. assembles `out/Framevo-win32-x64/` from `node_modules/electron/dist`
5. `electron-winstaller` → `out/make/squirrel.windows/x64/Framevo-Setup.exe`

## Output locations

| Artifact                | Path                                                     |
| ----------------------- | -------------------------------------------------------- |
| Packaged app            | `desktop/out/Framevo-win32-x64/`                          |
| Executable              | `desktop/out/Framevo-win32-x64/Framevo.exe`               |
| **Installer**           | `desktop/out/make/squirrel.windows/x64/Framevo-Setup.exe` |
| Update package          | `desktop/out/make/squirrel.windows/x64/Framevo-0.1.0-full.nupkg` |
| Release manifest        | `desktop/out/make/squirrel.windows/x64/RELEASES`          |

## Two paths, one result

`npm run desktop:make` runs **Electron Forge** (`forge.config.ts`) — the
canonical, cross-platform path, and the one to use in CI.

`npm run desktop:package` runs **`scripts/package-win.mjs`**, which produces the
same layout without re-extracting the Electron release zip. It exists because
that extraction stalls inside Node on some Windows setups (including this
repo's development machine): the zip's central directory reads fine, then the
first decompressed entry never completes, and the process exits cleanly with
nothing written. File copies are unaffected, so this path copies the Electron
runtime that `npm install` already extracted into `node_modules/electron/dist`.

Both call the SAME `stageResources()`, so `resources/` is identical either way.

If `npm run desktop:make` works in your environment, prefer it.

## What ends up inside

```
Framevo-win32-x64/
  Framevo.exe                     Electron, renamed + version-stamped
  *.dll, locales/, *.pak          the Electron runtime
  resources/
    app.asar                      package.json + main.js + preload.js
    app/                          the static renderer (framevo://app)
    ffmpeg/                       ffmpeg.exe, ffprobe.exe, FFMPEG-LICENSE.txt
    render-cli.mjs                the shared render core
    node_modules/@napi-rs/        the canvas addon the render core loads
    migrations/                   library database schema
```

The app.asar is deliberately tiny. Executables cannot run from inside an
archive and `.node` addons cannot be loaded from one, so anything spawned or
`dlopen`ed lives in `resources/` — which is also how the render subprocess
resolves `@napi-rs/canvas` (Node walks up from `resources/render-cli.mjs` and
finds `resources/node_modules`).

## Verifying a package

```bash
npm run desktop:test:e2e        # includes e2e/packaged.spec.ts
```

`packaged.spec.ts` launches the built `Framevo.exe` (not a dev build) with a
throwaway profile and asserts it boots its own renderer, finds its bundled
FFmpeg, detects encoders, and imports → edits → exports a real MP4. It skips
itself if the package hasn't been built.

## macOS

The structure is platform-neutral: `MakerZIP` is configured for `darwin`,
`stageResources()` picks per-platform binaries, and the updater already speaks
Squirrel.Mac's JSON feed. Adding macOS is:

1. run `npm run desktop:make` **on a Mac** (packaging is not cross-platform),
2. add `MakerDMG` if you want a .dmg rather than a .zip,
3. set the Apple signing/notarisation variables (see code-signing.md).

No application code changes are required.
