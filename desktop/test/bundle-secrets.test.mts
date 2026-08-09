/**
 * What actually ended up in the shipped JavaScript.
 *
 * The rules being enforced are absolute, so they are checked against the real
 * build output rather than against the code that produces it:
 *
 *   • `GOOGLE_DESKTOP_OAUTH_CLIENT_SECRET` must appear in NO artifact — not
 *     main, not preload, not the renderer. It is the one credential that would
 *     let a copy of the app redeem authorization codes by itself, and the whole
 *     server-exchange design exists to keep it out.
 *   • A build must contain exactly ONE environment's identifiers. Finding both
 *     project numbers in one bundle means the environments leaked into each
 *     other, which is what caused auth/invalid-credential.
 *
 * Skipped (not failed) when the bundles haven't been built yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { resolveDesktopConfig, resolveEnvironment } from "../../config/desktop-env.mjs";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VITE_DIR = join(DESKTOP_ROOT, ".vite");
const RENDERER_OUT = join(DESKTOP_ROOT, "renderer", "out");

/** Every text artifact a user's machine would receive. */
function shippedFiles(): string[] {
  const files: string[] = [];
  for (const name of ["main.js", "preload.js", "render-cli.mjs"]) {
    const path = join(VITE_DIR, name);
    if (existsSync(path)) files.push(path);
  }
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|mjs|html|txt|json)$/.test(entry)) files.push(path);
    }
  };
  walk(RENDERER_OUT);
  return files;
}

/** The secret for whichever environment the current build is for. */
function currentSecret(): string | null {
  const environment = resolveEnvironment();
  const files = [
    join(DESKTOP_ROOT, "..", ".env"),
    join(DESKTOP_ROOT, "..", `.env.${environment}`),
    join(DESKTOP_ROOT, "..", `.env.${environment}.local`),
  ];
  let secret: string | null = null;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const match = /^\s*GOOGLE_DESKTOP_OAUTH_CLIENT_SECRET\s*=\s*(.+)$/m.exec(
      readFileSync(file, "utf8")
    );
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (value) secret = value;
  }
  return secret;
}

const built = existsSync(join(VITE_DIR, "main.js"));

test("the OAuth client secret is in no shipped file", { skip: !built }, () => {
  const secret = currentSecret();
  const files = shippedFiles();
  assert.ok(files.length > 0, "no build artifacts found");

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // The variable NAME must not appear either: its presence would mean some
    // code path expects to read it on the client.
    assert.ok(
      !source.includes("GOOGLE_DESKTOP_OAUTH_CLIENT_SECRET"),
      `${file} references the client secret variable`
    );
    if (secret) {
      // Never interpolate the secret into the failure message.
      assert.ok(!source.includes(secret), `${file} CONTAINS THE CLIENT SECRET`);
    }
  }
});

test("no shipped file asks Google to redeem a code", { skip: !built }, () => {
  // `client_secret` / the token endpoint belong to the server route alone. If
  // either appears here, the exchange has drifted back into the app.
  for (const file of shippedFiles()) {
    const source = readFileSync(file, "utf8");
    assert.ok(!source.includes("client_secret"), `${file} builds a client_secret request`);
    assert.ok(
      !source.includes("oauth2.googleapis.com/token"),
      `${file} calls Google's token endpoint directly`
    );
  }
});

/**
 * Both environments' identifiers, so a test can ask which one the ARTIFACT
 * carries rather than which one the test process happens to be running as.
 *
 * That distinction is the whole point: `npm test` runs as development, but the
 * bundle on disk is whatever the last build was for. Comparing the two was a
 * test that failed the moment someone packaged a production build — reporting a
 * problem with the environment split when the split was working perfectly.
 */
const ENVIRONMENT_IDENTITIES = ["development", "production"].map((environment) => ({
  environment,
  ...resolveDesktopConfig({ environment }),
}));

/** Which environments' identifiers appear in `source`. Should always be one. */
function environmentsPresent(source: string, field: "firebaseProjectId" | "googleClientId") {
  const distinct = new Map<string, string>();
  for (const identity of ENVIRONMENT_IDENTITIES) {
    const value = identity[field];
    if (value) distinct.set(value, identity.environment);
  }
  // Environments that share a value (not configured separately) can't be told
  // apart and aren't evidence of a leak either way.
  if (distinct.size < 2) return null;
  return [...distinct.entries()]
    .filter(([value]) => source.includes(value))
    .map(([, environment]) => environment);
}

test("the main bundle carries ONE environment's identity", { skip: !built }, () => {
  const main = readFileSync(join(VITE_DIR, "main.js"), "utf8");

  for (const field of ["googleClientId", "firebaseProjectId"] as const) {
    const present = environmentsPresent(main, field);
    if (!present) continue;
    assert.deepEqual(
      present.length,
      1,
      present.length === 0
        ? `main.js contains NO environment's ${field} — it was built without config`
        : `main.js contains ${present.join(" AND ")} ${field}s — the environments leaked`
    );
  }
});

test(
  "the renderer carries ONE Firebase project",
  { skip: !built || !existsSync(RENDERER_OUT) },
  () => {
    const rendererFiles = shippedFiles().filter((f) => f.startsWith(RENDERER_OUT));
    const seen = new Set<string>();
    for (const file of rendererFiles) {
      const present = environmentsPresent(readFileSync(file, "utf8"), "firebaseProjectId");
      if (!present) return; // the two environments aren't distinguishable here
      for (const environment of present) seen.add(environment);
      assert.ok(
        present.length <= 1,
        `${file} contains ${present.join(" AND ")} Firebase project ids`
      );
    }
    assert.ok(
      seen.size <= 1,
      `the renderer mixes ${[...seen].join(" AND ")} builds across its chunks`
    );
  }
);
