/**
 * Environment isolation, and the check that catches the pairing Firebase can't.
 *
 * The bug this file exists for: a desktop OAuth client from `adzoom-prod` was
 * loaded next to the `adzoomdev` Firebase project, and every sign-in died with
 *
 *   auth/invalid-credential — "Google ID token audience is not authorized"
 *
 * — a message that names NEITHER project. It was possible because `.env.local`
 * carries no environment in its name, so whatever was last written there
 * reached both dev and prod builds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  envFilesFor,
  projectNumberFromClientId,
  readEnvironmentFiles,
  resolveDesktopConfig,
  resolveEnvironment,
  validateDesktopConfig,
  describeConfig,
} from "../../config/desktop-env.mjs";

const DEV_PROJECT = "574329747163";
const PROD_PROJECT = "461465030931";
const DEV_CLIENT = `${DEV_PROJECT}-devhash.apps.googleusercontent.com`;
const PROD_CLIENT = `${PROD_PROJECT}-prodhash.apps.googleusercontent.com`;

/** A throwaway repo root with the four env files a real checkout can have. */
function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "framevo-env-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, name), body);
  }
  return root;
}

const DEV_FILE = [
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID=adzoomdev",
  `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=${DEV_PROJECT}`,
  "NEXT_PUBLIC_CLOUD_API_BASE=http://localhost:3000",
  `GOOGLE_DESKTOP_OAUTH_CLIENT_ID=${DEV_CLIENT}`,
  "GOOGLE_DESKTOP_OAUTH_CLIENT_SECRET=dev-secret-value",
].join("\n");

const PROD_FILE = [
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID=adzoom-prod",
  `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=${PROD_PROJECT}`,
  "NEXT_PUBLIC_CLOUD_API_BASE=https://framevo.app",
  `GOOGLE_DESKTOP_OAUTH_CLIENT_ID=${PROD_CLIENT}`,
  "GOOGLE_DESKTOP_OAUTH_CLIENT_SECRET=prod-secret-value",
].join("\n");

/** `.env.local` holding PRODUCTION values — the shape that caused the bug. */
const POISONED_LOCAL = [
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID=adzoom-prod",
  `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=${PROD_PROJECT}`,
  `GOOGLE_DESKTOP_OAUTH_CLIENT_ID=${PROD_CLIENT}`,
].join("\n");

// ── Environment selection ──────────────────────────────────────────────────

test("FRAMEVO_ENV decides the environment, ahead of NODE_ENV", () => {
  assert.equal(resolveEnvironment({ FRAMEVO_ENV: "production" }), "production");
  assert.equal(resolveEnvironment({ FRAMEVO_ENV: "prod" }), "production");
  // `next build` sets NODE_ENV=production in children; an explicit
  // FRAMEVO_ENV must still win, or a dev run would package prod credentials.
  assert.equal(
    resolveEnvironment({ FRAMEVO_ENV: "development", NODE_ENV: "production" }),
    "development"
  );
  assert.equal(resolveEnvironment({ NODE_ENV: "production" }), "production");
  assert.equal(resolveEnvironment({}), "development");
});

test("a general .env.local is NEVER consulted", () => {
  for (const environment of ["development", "production"] as const) {
    const files = envFilesFor(environment, "/repo");
    assert.ok(
      !files.some((f) => f.endsWith(".env.local")),
      `${environment} must not read .env.local`
    );
    assert.ok(files.some((f) => f.endsWith(`.env.${environment}.local`)));
  }
});

test("later files win, matching Next's precedence", () => {
  // Compared by base name: `join` yields backslashes on Windows.
  const order = envFilesFor("development", "/repo").map((f) => f.split(/[\\/]/).pop());
  assert.deepEqual(order, [".env", ".env.development", ".env.development.local"]);
});

// ── The two environments stay apart ────────────────────────────────────────

test("development resolves ONLY adzoom-dev, even with production in .env.local", () => {
  const root = fixtureRoot({
    ".env.local": POISONED_LOCAL,
    ".env.development.local": DEV_FILE,
    ".env.production.local": PROD_FILE,
  });
  const config = resolveDesktopConfig({
    environment: "development",
    root,
    processEnv: {},
  });

  assert.equal(config.firebaseProjectId, "adzoomdev");
  assert.equal(config.messagingSenderId, DEV_PROJECT);
  assert.equal(config.googleClientId, DEV_CLIENT);
  assert.equal(config.apiBaseUrl, "http://localhost:3000");
  assert.equal(config.ok, true);

  // Nothing production-shaped survived anywhere in the resolved object.
  const serialized = JSON.stringify(config);
  assert.ok(!serialized.includes(PROD_PROJECT), "a production project number leaked into dev");
  assert.ok(!serialized.includes("adzoom-prod"), "the production project id leaked into dev");
  assert.ok(!serialized.includes("framevo.app"), "the production API base leaked into dev");
});

test("production resolves ONLY adzoom-prod, even with development in .env.local", () => {
  const root = fixtureRoot({
    ".env.local": DEV_FILE,
    ".env.development.local": DEV_FILE,
    ".env.production.local": PROD_FILE,
  });
  const config = resolveDesktopConfig({
    environment: "production",
    root,
    processEnv: {},
  });

  assert.equal(config.firebaseProjectId, "adzoom-prod");
  assert.equal(config.messagingSenderId, PROD_PROJECT);
  assert.equal(config.googleClientId, PROD_CLIENT);
  assert.equal(config.apiBaseUrl, "https://framevo.app");
  assert.equal(config.ok, true);

  const serialized = JSON.stringify(config);
  assert.ok(!serialized.includes(DEV_PROJECT), "a development project number leaked into prod");
  assert.ok(!serialized.includes("adzoomdev"), "the development project id leaked into prod");
  assert.ok(!serialized.includes("localhost"), "a localhost API base leaked into prod");
});

test("an environment with no file of its own does not borrow the other's", () => {
  const root = fixtureRoot({ ".env.production.local": PROD_FILE });
  const config = resolveDesktopConfig({
    environment: "development",
    root,
    processEnv: {},
  });
  assert.equal(config.firebaseProjectId, "");
  assert.equal(config.googleClientId, "");
  // Missing is a WARNING (a local-only build is legal); wrong is an error.
  assert.equal(config.ok, true);
  assert.ok(config.warnings.length >= 2);
});

test("an empty assignment overrides a lower file instead of falling through", () => {
  const root = fixtureRoot({
    ".env.development": DEV_FILE,
    ".env.development.local": "GOOGLE_DESKTOP_OAUTH_CLIENT_ID=",
  });
  const config = resolveDesktopConfig({
    environment: "development",
    root,
    processEnv: {},
  });
  // Blanking a key must mean "not configured", never "use whatever was below".
  assert.equal(config.googleClientId, "");
  assert.equal(config.firebaseProjectId, "adzoomdev");
});

test("process.env still wins, so CI can override without editing files", () => {
  const root = fixtureRoot({ ".env.development.local": DEV_FILE });
  const merged = readEnvironmentFiles("development", {
    root,
    processEnv: { NEXT_PUBLIC_CLOUD_API_BASE: "https://ci.example" },
  });
  assert.equal(merged.NEXT_PUBLIC_CLOUD_API_BASE, "https://ci.example");
});

// ── The mismatch guard ─────────────────────────────────────────────────────

test("the project number is read out of the OAuth client id", () => {
  assert.equal(projectNumberFromClientId(PROD_CLIENT), PROD_PROJECT);
  assert.equal(projectNumberFromClientId(DEV_CLIENT), DEV_PROJECT);
  assert.equal(projectNumberFromClientId("not-a-client"), null);
  assert.equal(projectNumberFromClientId(""), null);
  assert.equal(projectNumberFromClientId(undefined), null);
});

test("a mixed configuration is REJECTED — this is the reported bug", () => {
  const verdict = validateDesktopConfig({
    environment: "development",
    firebaseProjectId: "adzoomdev",
    messagingSenderId: DEV_PROJECT,
    authDomain: "",
    apiBaseUrl: "http://localhost:3000",
    googleClientId: PROD_CLIENT, // a production client — the actual mistake
    publicEnv: {},
  });

  assert.equal(verdict.ok, false);
  const message = verdict.errors.join("\n");
  // The error has to name BOTH projects, which auth/invalid-credential doesn't.
  assert.match(message, /adzoomdev/);
  assert.match(message, new RegExp(DEV_PROJECT));
  assert.match(message, new RegExp(PROD_PROJECT));
  assert.match(message, /invalid-credential/);
  // …and say what to do about it.
  assert.match(message, /\.env\.development\.local/);
});

test("the reverse mix — a dev client against prod Firebase — is rejected too", () => {
  const verdict = validateDesktopConfig({
    environment: "production",
    firebaseProjectId: "adzoom-prod",
    messagingSenderId: PROD_PROJECT,
    authDomain: "",
    apiBaseUrl: "https://framevo.app",
    googleClientId: DEV_CLIENT,
    publicEnv: {},
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join("\n"), /\.env\.production\.local/);
});

test("a matching pair passes in both environments", () => {
  for (const [firebaseProjectId, number, client, environment] of [
    ["adzoomdev", DEV_PROJECT, DEV_CLIENT, "development"],
    ["adzoom-prod", PROD_PROJECT, PROD_CLIENT, "production"],
  ] as const) {
    const verdict = validateDesktopConfig({
      environment,
      firebaseProjectId,
      messagingSenderId: number,
      authDomain: "",
      apiBaseUrl: "https://example.test",
      googleClientId: client,
      publicEnv: {},
    });
    assert.equal(verdict.ok, true, `${environment} should be valid`);
    assert.deepEqual(verdict.errors, []);
  }
});

test("a malformed client id is an error, not a silent pass", () => {
  const verdict = validateDesktopConfig({
    environment: "development",
    firebaseProjectId: "adzoomdev",
    messagingSenderId: DEV_PROJECT,
    authDomain: "",
    apiBaseUrl: "",
    googleClientId: "pasted-the-secret-by-mistake",
    publicEnv: {},
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors.join("\n"), /malformed/i);
});

// ── Nothing secret is ever reported ────────────────────────────────────────

test("the startup summary prints identifiers only, never a secret", () => {
  const root = fixtureRoot({ ".env.development.local": DEV_FILE });
  const config = resolveDesktopConfig({
    environment: "development",
    root,
    processEnv: {},
  });
  const summary = describeConfig(config);

  assert.match(summary, /adzoomdev/);
  assert.match(summary, new RegExp(DEV_CLIENT));
  assert.ok(!summary.includes("dev-secret-value"), "the client secret was printed");
  assert.ok(!/SECRET/i.test(summary), "a secret-shaped field was printed");
});

test("the resolved config never carries the client secret", () => {
  const root = fixtureRoot({ ".env.development.local": DEV_FILE });
  const config = resolveDesktopConfig({
    environment: "development",
    root,
    processEnv: {},
  });
  // publicEnv feeds the RENDERER build, so a secret here would be shipped.
  assert.ok(!JSON.stringify(config).includes("dev-secret-value"));
  for (const key of Object.keys(config.publicEnv)) {
    assert.ok(key.startsWith("NEXT_PUBLIC_"), `${key} is not a public variable`);
  }
});
