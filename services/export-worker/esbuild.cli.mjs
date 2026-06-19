// Bundle the render CLI (src/cli.ts) — the subprocess the C# export API spawns
// to render one job. Mirrors esbuild.mjs (same `@` alias + native externals);
// only the entry/outfile differ. Native deps (@napi-rs/canvas, ffmpeg-static,
// ffprobe-static) stay external and load from node_modules at runtime.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = resolve(here, "../../src");

await build({
  entryPoints: [resolve(here, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(here, "dist/cli.js"),
  banner: {
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
