/**
 * Minimal `.env.local` loader for LOCAL DEV. The worker is a separate Node
 * process, so (unlike Next.js) it doesn't auto-read the repo-root `.env.local`
 * where the Firebase project id + service-account creds live. This populates
 * `process.env` from that file so the worker shares the app's config without a
 * second copy. No-op in production — Cloud Run sets env directly and
 * `.env.local` won't exist. Never overrides an already-set variable.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function loadDotEnvLocal(): void {
  const here = dirname(fileURLToPath(import.meta.url)); // services/export-worker/src
  const candidates = [
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), "../../.env.local"),
    resolve(here, "../../../.env.local"), // repo root from src/
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return;

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }

  let loaded = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!key || key in process.env) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
    loaded++;
  }
  console.info(`[worker] loaded ${loaded} env vars from ${file}`);
}
