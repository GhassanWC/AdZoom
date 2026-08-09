/**
 * ONE resolved configuration for Framevo Desktop, shared by every process that
 * needs it: the Electron main bundle, the renderer build, and the server-side
 * authentication endpoint.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * Firebase will only accept a Google ID token whose `aud` (the OAuth client)
 * belongs to the SAME Google Cloud project as the Firebase app. Mix them and
 * sign-in fails with a message that names neither side:
 *
 *   auth/invalid-credential — "Google ID token audience is not authorized"
 *
 * That is trivially detectable ahead of time, because a Google OAuth client id
 * is `<GCP project number>-<hash>.apps.googleusercontent.com`, and the Firebase
 * web config's `messagingSenderId` IS that project number. So the two can be
 * compared at build time and at boot, and a mismatch reported in terms of the
 * projects involved rather than left to fail at the moment a user signs in.
 *
 * ── Why not just read `.env.local` ─────────────────────────────────────────
 * Because `.env.local` is environment-AGNOSTIC. A dev build that falls back to
 * it silently inherits whatever the last production edit left behind — which is
 * exactly how a prod OAuth client ended up in a dev desktop build. The desktop
 * reader therefore consults ONLY environment-specific files. There is no shared
 * middle ground where the two can contaminate each other.
 *
 * Plain `.mjs` (with a hand-written `.d.mts`) so the build scripts and the
 * TypeScript server route can share one implementation rather than two that
 * drift.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {readonly ["development","production"]} */
export const ENVIRONMENTS = ["development", "production"];

/**
 * Which environment a build/run is for. Explicit beats inferred: FRAMEVO_ENV
 * is checked first so a packaging script can state its intent outright.
 */
export function resolveEnvironment(env = process.env) {
  const raw = (env.FRAMEVO_ENV || env.NODE_ENV || "development").toLowerCase();
  if (raw === "production" || raw === "prod") return "production";
  return "development";
}

/**
 * The files consulted, in INCREASING precedence.
 *
 * `.env.local` is deliberately absent. It is the one file that carries no
 * environment in its name, so including it is what allows production values to
 * leak into a development build (and vice versa) with nothing in the output to
 * show it happened.
 */
export function envFilesFor(environment, root = REPO_ROOT) {
  return [
    join(root, ".env"),
    join(root, `.env.${environment}`),
    join(root, `.env.${environment}.local`),
  ];
}

function parseEnvFile(file) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    // An empty assignment is meaningful: it OVERRIDES a lower-precedence file
    // with "not configured", which then fails loudly instead of silently
    // falling through to another environment's value.
    out[match[1]] = value;
  }
  return out;
}

/** Merge the environment's files, lowest precedence first, then process.env. */
export function readEnvironmentFiles(environment, options = {}) {
  const root = options.root ?? REPO_ROOT;
  /** @type {Record<string,string>} */
  const merged = {};
  for (const file of envFilesFor(environment, root)) {
    Object.assign(merged, parseEnvFile(file));
  }
  // The real process env always wins, so CI can override anything without
  // editing a file.
  for (const [key, value] of Object.entries(options.processEnv ?? process.env)) {
    if (value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}

/** `461465030931-abc.apps.googleusercontent.com` → `461465030931`. */
export function projectNumberFromClientId(clientId) {
  if (typeof clientId !== "string") return null;
  const match = /^(\d{6,})-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.exec(clientId.trim());
  return match ? match[1] : null;
}

/** The public identifiers, safe to print. Never any secret. */
export function describeConfig(config) {
  return [
    `environment    ${config.environment}`,
    `firebase       ${config.firebaseProjectId || "(none)"}`,
    `gcp project #  ${config.messagingSenderId || "(none)"}`,
    `oauth client   ${config.googleClientId || "(none)"}`,
    `api base       ${config.apiBaseUrl || "(none)"}`,
  ].join("\n  ");
}

/**
 * Build the resolved configuration for an environment.
 *
 * `requireAuth` marks the fields sign-in needs. A build that omits them is
 * still legal (a local-only desktop build), it just cannot sign anyone in — so
 * they are reported as warnings, while a MISMATCH is always an error.
 */
export function resolveDesktopConfig(options = {}) {
  const environment = options.environment ?? resolveEnvironment(options.processEnv);
  const env = options.env ?? readEnvironmentFiles(environment, options);

  const config = {
    environment,
    firebaseProjectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
    messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
    authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
    apiBaseUrl: env.NEXT_PUBLIC_CLOUD_API_BASE ?? "",
    // FRAMEVO_* is the desktop-specific override; the server's own client id is
    // the default, so one entry per environment configures both halves.
    googleClientId:
      env.FRAMEVO_GOOGLE_DESKTOP_CLIENT_ID || env.GOOGLE_DESKTOP_OAUTH_CLIENT_ID || "",
    /** Every NEXT_PUBLIC_* value, for the renderer build. Never anything else. */
    publicEnv: Object.fromEntries(
      Object.entries(env).filter(([key]) => key.startsWith("NEXT_PUBLIC_"))
    ),
  };

  return { ...config, ...validateDesktopConfig(config) };
}

/**
 * Errors block a build or a sign-in; warnings only disable a feature.
 *
 * The mismatch check is the whole point of this module: it turns a runtime
 * `auth/invalid-credential` — which names neither project — into a build-time
 * failure that names both.
 */
export function validateDesktopConfig(config) {
  const errors = [];
  const warnings = [];

  const clientProject = projectNumberFromClientId(config.googleClientId);

  if (config.googleClientId && !clientProject) {
    errors.push(
      `The Google desktop OAuth client id is malformed: "${config.googleClientId}". ` +
        `Expected <project-number>-<hash>.apps.googleusercontent.com.`
    );
  }

  if (clientProject && config.messagingSenderId && clientProject !== config.messagingSenderId) {
    errors.push(
      `Firebase project "${config.firebaseProjectId}" is Google Cloud project ` +
        `#${config.messagingSenderId}, but the desktop OAuth client belongs to ` +
        `#${clientProject}. Firebase will reject every sign-in from this client ` +
        `with auth/invalid-credential.\n` +
        `  Fix: create an OAuth client of type "Desktop app" inside the ` +
        `"${config.firebaseProjectId}" project and set GOOGLE_DESKTOP_OAUTH_CLIENT_ID ` +
        `in .env.${config.environment}.local.`
    );
  }

  if (!config.firebaseProjectId) {
    warnings.push(
      `No NEXT_PUBLIC_FIREBASE_PROJECT_ID for "${config.environment}" — the app cannot sign anyone in.`
    );
  }
  if (!config.googleClientId) {
    warnings.push(
      `No GOOGLE_DESKTOP_OAUTH_CLIENT_ID for "${config.environment}" — Google sign-in will be unavailable.`
    );
  }
  if (!config.apiBaseUrl) {
    warnings.push(
      `No NEXT_PUBLIC_CLOUD_API_BASE for "${config.environment}" — sign-in and cloud features will be unavailable.`
    );
  }

  return { errors, warnings, ok: errors.length === 0 };
}

/** Print the resolved identifiers, then throw if anything is inconsistent. */
export function assertDesktopConfig(config, label = "desktop") {
  console.log(`[${label}] configuration\n  ${describeConfig(config)}`);
  for (const warning of config.warnings) console.warn(`[${label}] ${warning}`);
  if (config.errors.length) {
    throw new Error(
      `[${label}] configuration is inconsistent:\n\n` +
        config.errors.map((e) => `  • ${e}`).join("\n\n") +
        "\n"
    );
  }
  return config;
}
