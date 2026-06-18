// Bundle the worker (+ the shared `@/lib/render` + `@/lib/timeline` code it
// imports) into a single ESM file. Native / heavy deps stay external and load
// from node_modules at runtime. The `@` alias resolves to the main app's `src`.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = resolve(here, "../../src");

await build({
  entryPoints: [resolve(here, "src/server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(here, "dist/server.js"),
  banner: {
    // esbuild ESM output sometimes needs require() for externalized CJS deps.
    js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);",
  },
  alias: { "@": appSrc },
  external: [
    "@napi-rs/canvas",
    "firebase-admin",
    "ffmpeg-static",
    "ffprobe-static",
    "google-auth-library",
    "express",
  ],
  logLevel: "info",
});
