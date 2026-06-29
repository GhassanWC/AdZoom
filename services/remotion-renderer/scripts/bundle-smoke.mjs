// Bundle-cleanliness smoke test (plan test #1): prove the Framevo composition
// (src/remotion/*) + the reused render math (src/lib/*) bundle under Remotion's
// webpack with NO server-only / next/* / node-only imports. Exits non-zero on any
// webpack resolve/compile error. Run: npm run bundle:smoke (from this package).
import { bundle } from "@remotion/bundler";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = process.env.REMOTION_APP_SRC || resolve(here, "../../../src");
const entryPoint = join(appSrc, "remotion", "Root.tsx");

console.log(`[bundle-smoke] bundling ${entryPoint} (alias @ → ${appSrc})`);
try {
  const serveUrl = await bundle({
    entryPoint,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        alias: { ...(config.resolve?.alias ?? {}), "@": appSrc },
      },
    }),
  });
  console.log(`[bundle-smoke] OK — composition bundled cleanly. serveUrl=${serveUrl}`);
} catch (err) {
  console.error("[bundle-smoke] FAILED — composition does not bundle:", err);
  process.exit(1);
}
