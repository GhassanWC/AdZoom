// Bundle the worker entry (src/run.ts) into a single ESM file. Remotion + React +
// firebase-admin stay EXTERNAL (native/heavy; loaded from node_modules at runtime).
// The `@` alias resolves to the main app's `src` for any shared imports. NOTE: the
// COMPOSITION bundle is produced separately by Remotion's `bundle()` (webpack) at
// runtime against the source files copied into the image — esbuild only bundles the
// worker's own node code here.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = resolve(here, "../../src");

await build({
  entryPoints: [resolve(here, "src/run.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: resolve(here, "dist/run.js"),
  banner: {
    js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);",
  },
  alias: { "@": appSrc },
  external: ["@remotion/renderer", "@remotion/bundler", "remotion", "react", "react-dom", "firebase-admin"],
  logLevel: "info",
});
