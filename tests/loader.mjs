/**
 * node:test resolver hook — AUGMENT-ONLY. Lets tests (and the src modules they
 * load) resolve the `@/…` path alias and EXTENSIONLESS relative/src imports, the
 * same way Turbopack/tsc (`moduleResolution: "bundler"`) do. Existing imports
 * that already resolve (e.g. `../src/lib/x.ts` with an extension) are untouched —
 * the hook only kicks in when the default resolution fails. This is what lets a
 * test-loaded module (e.g. render/overlay-draw.ts) VALUE-import a shared module
 * (render/text-shaping.ts) without duplicating logic per renderer.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SRC = path.resolve(process.cwd(), "src");
const EXTS = [".ts", ".tsx", ".mjs", ".js", ".json"];

/** Given a file:// URL with no extension, find the real file (ext or /index.ext). */
function withExtension(fileUrl) {
  const p = fileURLToPath(fileUrl);
  for (const ext of EXTS) if (existsSync(p + ext)) return pathToFileURL(p + ext).href;
  for (const ext of EXTS) {
    const idx = path.join(p, "index" + ext);
    if (existsSync(idx)) return pathToFileURL(idx).href;
  }
  return null;
}

/** Next-only packages that have no runtime behaviour outside the Next toolchain. */
const STUBS = {
  // Guards CLIENT bundles; not installed for `node --test`. See stubs/server-only.mjs.
  "server-only": pathToFileURL(path.resolve(process.cwd(), "tests/stubs/server-only.mjs"))
    .href,
};

export async function resolve(specifier, context, nextResolve) {
  let spec = specifier;
  if (Object.hasOwn(STUBS, spec)) {
    return { url: STUBS[spec], shortCircuit: true };
  }
  // `@/x` → src/x
  if (spec.startsWith("@/")) {
    spec = pathToFileURL(path.join(SRC, spec.slice(2))).href;
  }
  try {
    return await nextResolve(spec, context);
  } catch (err) {
    // Default resolution failed — try adding a known extension (bundler-style).
    let baseUrl;
    if (spec.startsWith("file://")) baseUrl = spec;
    else if (spec.startsWith(".")) baseUrl = new URL(spec, context.parentURL).href;
    else throw err;
    const resolved = withExtension(baseUrl);
    if (resolved) return { url: resolved, shortCircuit: true };
    throw err;
  }
}
