// Bundle the ASR worker (+ the shared `@/lib/transcript`, `@/lib/usage`,
// `@/lib/analysis` code it imports) into a single ESM file. Native / heavy
// deps stay external and load from node_modules at runtime. The `@` alias
// resolves to the main app's `src` (same pattern as services/export-worker).
//
// `server-only` is aliased to an empty stub: the shared firebase admin module
// imports it as a Next.js guard, and the real package throws when loaded
// outside a Next server context.
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
  alias: {
    "@": appSrc,
    "server-only": resolve(here, "src/server-only-stub.ts"),
  },
  external: ["firebase-admin", "google-auth-library"],
  logLevel: "info",
});
