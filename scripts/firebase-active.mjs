#!/usr/bin/env node
/**
 * Prints, at a glance, every signal that controls "which Firebase
 * project will my next command hit?":
 *
 *   1. The CLI's active alias (the same thing `firebase use` shows).
 *   2. The project id baked into .env.local (used by /scripts/* and
 *      the local dev server).
 *   3. The project id baked into .env.production (used by
 *      `next build` when NODE_ENV=production).
 *   4. The expected mapping declared in this script — same as the
 *      hard-coded map in deploy-rules.mjs and in .firebaserc.
 *
 * Output is exit-code 0 if dev and prod env files BOTH match the
 * expected mapping, 1 otherwise. So this works as both a quick
 * "where am I?" check and a CI guard.
 *
 *   node scripts/firebase-active.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const EXPECTED = {
  dev: { alias: "dev", projectId: "adzoomdev", envFile: ".env.local" },
  prod: { alias: "prod", projectId: "adzoom-prod", envFile: ".env.production" },
};

console.log("\n┌─────────────────────────────────────────────────────────────┐");
console.log("│ AdZoom — Firebase project state                              │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// 1. CLI active alias.
let cliActive = "(firebase CLI not installed or no .firebaserc)";
try {
  const raw = execSync("firebase use", {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
  cliActive = raw || "(none — run `firebase use dev` or `firebase use prod`)";
} catch {
  // ignore — fall through with default message
}
console.log(`firebase CLI alias  → ${cliActive}`);

// 2 + 3. Env files.
let ok = true;
for (const [label, e] of Object.entries(EXPECTED)) {
  const filePath = path.join(root, e.envFile);
  if (!existsSync(filePath)) {
    console.log(
      `${label.padEnd(4)} (${e.envFile})  → not present  (copy .${e.envFile}.example and fill it)`
    );
    if (label === "dev") ok = false;
    continue;
  }
  const text = readFileSync(filePath, "utf-8");
  const match = /^NEXT_PUBLIC_FIREBASE_PROJECT_ID\s*=\s*(.+?)\s*$/m.exec(text);
  const found = match?.[1]?.replace(/^['"]|['"]$/g, "") ?? "(unset)";
  const status = found === e.projectId ? "✓" : "✗ mismatch";
  console.log(
    `${label.padEnd(4)} (${e.envFile}) → ${found}  ${status} (expected ${e.projectId})`
  );
  if (found !== e.projectId) ok = false;
}

console.log("\nExpected mapping (must match .firebaserc):");
for (const [label, e] of Object.entries(EXPECTED)) {
  console.log(`  ${label.padEnd(4)} → ${e.projectId}`);
}

console.log(ok ? "\n✓ State looks consistent." : "\n✗ Inconsistency detected — fix above before deploying.");
process.exit(ok ? 0 : 1);
