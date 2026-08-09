/**
 * Augment-only resolver for the desktop test run (mirrors tests/loader.mjs at
 * the repo root, but rooted at the DESKTOP package):
 *
 *   @/…                    → ../src/…      (the app's shared modules)
 *   extensionless relative  → .ts / .tsx / .mjs / .js / index.*
 *
 * Only kicks in when the default resolution fails, so anything that already
 * resolves is untouched.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const DESKTOP_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const APP_SRC = path.resolve(DESKTOP_ROOT, "../src");
const EXTS = [".ts", ".tsx", ".mjs", ".js", ".json"];

function withExtension(fileUrl) {
  const p = fileURLToPath(fileUrl);
  for (const ext of EXTS) if (existsSync(p + ext)) return pathToFileURL(p + ext).href;
  for (const ext of EXTS) {
    const idx = path.join(p, "index" + ext);
    if (existsSync(idx)) return pathToFileURL(idx).href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let spec = specifier;
  if (spec.startsWith("@/")) {
    spec = pathToFileURL(path.join(APP_SRC, spec.slice(2))).href;
  }
  try {
    return await nextResolve(spec, context);
  } catch (err) {
    let baseUrl;
    if (spec.startsWith("file://")) baseUrl = spec;
    else if (spec.startsWith(".")) baseUrl = new URL(spec, context.parentURL).href;
    else throw err;
    const resolved = withExtension(baseUrl);
    if (resolved) return { url: resolved, shortCircuit: true };
    throw err;
  }
}
