/**
 * Produce the Remotion serve URL (a webpack bundle of the Framevo composition).
 * Memoized per process so repeated renders reuse it. The composition source lives
 * in the main app's `src/remotion` (+ the pure render math in `src/lib`), copied
 * into the image at `/app/src` — the webpack alias resolves `@` to it.
 *
 * Cold-start tip: a prebundled directory can be baked into the image and pointed
 * at via REMOTION_SERVE_DIR to skip webpack on the first render.
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { bundle } from "@remotion/bundler";

const here = dirname(fileURLToPath(import.meta.url));
// dist/run.js (prod) and src/bundle.ts (dev) are BOTH one level under the service
// root, so `../../../src` resolves to the repo's `src` in both (/app/src in the image).
const APP_SRC = process.env.REMOTION_APP_SRC || resolve(here, "../../../src");
const ENTRY = join(APP_SRC, "remotion", "Root.tsx");

let cached: Promise<string> | undefined;

export function getServeUrl(): Promise<string> {
  if (cached) return cached;
  const prebuilt = process.env.REMOTION_SERVE_DIR;
  if (prebuilt && existsSync(prebuilt)) {
    cached = Promise.resolve(prebuilt);
    return cached;
  }
  cached = bundle({
    entryPoint: ENTRY,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        alias: { ...(config.resolve?.alias ?? {}), "@": APP_SRC },
      },
    }),
  });
  return cached;
}
