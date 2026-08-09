/**
 * Shared setup for the desktop integration tests.
 *
 * Two things every spec needs:
 *   • a REAL video file (generated once with the bundled FFmpeg, so the test
 *     exercises the same decode path a user's recording does), and
 *   • an Electron app launched against a THROWAWAY user-data directory, so a
 *     test run can never touch the developer's own library or leave state
 *     behind that would trigger the crash-recovery prompt on their next launch.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

// Playwright transpiles specs to CommonJS (this package is `type: commonjs`,
// as Electron's main process requires), so `__dirname` — not import.meta — is
// the portable way to locate the app root here.
export const DESKTOP_ROOT = resolve(__dirname, "..");

/** The bundled FFmpeg — the same binary the app ships. */
export function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("ffmpeg-static") as string;
}

/**
 * A test clip with real frames and real AAC audio — nothing in the pipeline is
 * stubbed. Default: 4 seconds at 640×360, which renders in a few seconds.
 *
 * `seconds`/`size` exist for the cancellation test, which needs a render long
 * enough that "cancel" lands mid-flight rather than after the file is already
 * finished (a race that would make the test meaningless).
 */
export function makeFixtureVideo(
  dir: string,
  name = "fixture.mp4",
  { seconds = 4, size = "640x360" }: { seconds?: number; size?: string } = {}
): string {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, name);
  if (existsSync(out)) return out;
  execFileSync(
    ffmpegPath(),
    [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=size=${size}:rate=30:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k",
      "-shortest", "-y", out,
    ],
    { timeout: 300_000 }
  );
  return out;
}

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  close(): Promise<void>;
}

/** Launch the app with an isolated profile. */
export async function launchApp(
  options: {
    userDataDir?: string;
    offline?: boolean;
    /** Extra environment for the app process. Never used to add test hooks. */
    env?: Record<string, string>;
  } = {}
): Promise<LaunchedApp> {
  const userDataDir =
    options.userDataDir ?? mkdtempSync(join(tmpdir(), "framevo-e2e-profile-"));
  const app = await electron.launch({
    // Playwright resolves `electron` from ITS install location (the repo root),
    // where it deliberately isn't a dependency — the desktop package owns it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    executablePath: require("electron") as unknown as string,
    args: [DESKTOP_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: DESKTOP_ROOT,
    env: {
      ...process.env,
      // Keep the test run offline and quiet: no update checks, no crash
      // reporting, no cloud API.
      FRAMEVO_UPDATE_FEED_URL: "",
      FRAMEVO_SENTRY_DSN: "",
      NEXT_PUBLIC_CLOUD_API_BASE: "",
      ...options.env,
    },
  });
  // Surface the main process's own log lines in the test output — when an
  // export or a migration fails, that log is the only place the reason exists.
  app.process().stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[main] ${chunk.toString()}`);
  });
  app.process().stderr?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[main:err] ${chunk.toString()}`);
  });

  if (options.offline !== false) await goOffline(app);

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  return {
    app,
    window,
    userDataDir,
    async close() {
      await app.close().catch(() => undefined);
    },
  };
}

/**
 * Point Electron's file dialogs at fixed paths for the rest of the session.
 *
 * The OS dialog cannot be automated, so it is replaced IN THE TEST (never in
 * app code — the app has no test hooks). Everything downstream of the dialog —
 * validation, ffprobe, the media row, the project — runs for real.
 */
export async function stubDialogs(
  app: ElectronApplication,
  paths: { open?: string; save?: string }
): Promise<void> {
  await app.evaluate(async ({ dialog }, stub) => {
    if (stub.open) {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [stub.open!],
      })) as typeof dialog.showOpenDialog;
    }
    if (stub.save) {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: stub.save!,
      })) as typeof dialog.showSaveDialog;
    }
  }, paths);
}

/** Make the user cancel the next save dialog. */
export async function stubSaveCancel(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ dialog }) => {
    dialog.showSaveDialog = (async () => ({
      canceled: true,
      filePath: undefined,
    })) as typeof dialog.showSaveDialog;
  });
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * A signed-in session, established the way a restarted app gets one.
 *
 * The desktop app gates every dashboard route on Firebase auth, and the real
 * sign-in flow deliberately runs in the user's system browser — which a test
 * cannot drive, and should not: the point of that design is that Framevo never
 * handles the password.
 *
 * So the test does what a second launch does: it puts a session in the place
 * Firebase persists one (`browserLocalPersistence` → localStorage on the app
 * origin) and lets the app restore it. Everything after that is the real code
 * path — `onAuthStateChanged` fires, the gate opens, the shell mounts.
 *
 * The token is expired on purpose. Offline (which is how these tests run), the
 * refresh fails with `auth/network-request-failed`, and AuthProvider keeps the
 * session rather than signing the user out — the exact behaviour a user on a
 * plane depends on, asserted here for free.
 */
export const TEST_UID = "e2e-test-uid";
export const TEST_EMAIL = "e2e@framevo.test";

/**
 * The Firebase API key the renderer was BUILT with.
 *
 * Firebase namespaces its persisted session by this key, so the test has to use
 * the same one. It comes from the same place the build did: the process env, or
 * the repo-root `.env` files. Returns null when the bundle has no Firebase
 * config at all, which is the signal for the auth specs to skip rather than
 * fail for the wrong reason.
 */
/** The API key configured for one environment, or null. */
function apiKeyForEnvironment(environment: "development" | "production"): string | null {
  const repoRoot = resolve(DESKTOP_ROOT, "..");
  let found: string | null = null;
  // The SAME files, in the SAME order, as the build (config/desktop-env.mjs):
  // environment-specific only, later wins. `.env.local` is deliberately absent
  // — reading it would seed a session for a different Firebase project than the
  // bundle was built against, and the app would then report "no session" for a
  // reason nothing in the app could explain.
  for (const name of [".env", `.env.${environment}`, `.env.${environment}.local`]) {
    const file = join(repoRoot, name);
    if (!existsSync(file)) continue;
    const match = /^\s*NEXT_PUBLIC_FIREBASE_API_KEY\s*=\s*(.+)$/m.exec(
      readFileSync(file, "utf8")
    );
    const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (value) found = value;
  }
  return found;
}

/** Every JS file of the renderer that's on disk — the static export, packaged or not. */
function rendererFiles(): string[] {
  const roots = [
    join(DESKTOP_ROOT, "renderer", "out"),
    join(DESKTOP_ROOT, "out", `Framevo-win32-${process.arch}`, "resources", "app"),
  ].filter(existsSync);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".js")) files.push(path);
    }
  };
  for (const root of roots) walk(root);
  return files;
}

/**
 * The Firebase API key the renderer was BUILT with.
 *
 * Firebase namespaces its persisted session by this key, so the test has to use
 * the same one — seed the wrong key and the app restores nothing, shows the
 * sign-in screen, and every downstream assertion fails for a reason that has
 * nothing to do with what it was testing.
 *
 * Which environment that is comes from the ARTIFACT, not from the test process.
 * Those are different things: `npm run test:e2e` runs as development while the
 * package on disk may well be a production build, and assuming they matched is
 * what made the whole suite fail the first time a production package was tested.
 * So: find the candidate keys, then ask the built bundle which one it carries.
 */
export function firebaseApiKey(): string | null {
  if (process.env.NEXT_PUBLIC_FIREBASE_API_KEY) {
    return process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  }

  const candidates = (["production", "development"] as const)
    .map((environment) => ({ environment, key: apiKeyForEnvironment(environment) }))
    .filter((c): c is { environment: "production" | "development"; key: string } => !!c.key);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].key;

  const files = rendererFiles();
  for (const candidate of candidates) {
    for (const file of files) {
      if (readFileSync(file, "utf8").includes(candidate.key)) return candidate.key;
    }
  }

  // Nothing built yet (the auth specs skip in that case) — fall back to the
  // environment the test process is running as.
  const fallback = (process.env.FRAMEVO_ENV ?? "development") === "production"
    ? "production"
    : "development";
  return candidates.find((c) => c.environment === fallback)?.key ?? candidates[0].key;
}

export async function seedSignedInSession(
  window: Page,
  options: { uid?: string; email?: string; displayName?: string; apiKey?: string } = {}
): Promise<void> {
  const uid = options.uid ?? TEST_UID;
  const email = options.email ?? TEST_EMAIL;
  const displayName = options.displayName ?? "E2E Tester";
  const apiKey = options.apiKey ?? firebaseApiKey();
  if (!apiKey) throw new Error("no NEXT_PUBLIC_FIREBASE_API_KEY — cannot seed a session");

  // The app may still be resolving a redirect; writing storage mid-navigation
  // throws "execution context was destroyed".
  await settle(window);

  await window.evaluate(
    ({ uid: u, email: e, displayName: n, apiKey: key }) => {
      const apiKey = key;
      const stored = {
        uid: u,
        email: e,
        displayName: n,
        emailVerified: true,
        isAnonymous: false,
        providerData: [
          { providerId: "google.com", uid: u, email: e, displayName: n },
        ],
        apiKey,
        appName: "[DEFAULT]",
        stsTokenManager: {
          refreshToken: "e2e-refresh-token",
          accessToken: "e2e-access-token",
          // Already expired: the app must restore the session anyway when it
          // cannot reach the network to refresh it.
          expirationTime: Date.now() - 60_000,
        },
        createdAt: String(Date.now() - 86_400_000),
        lastLoginAt: String(Date.now()),
      };
      localStorage.setItem(
        `firebase:authUser:${apiKey}:[DEFAULT]`,
        JSON.stringify(stored)
      );
    },
    { uid, email, displayName, apiKey }
  );

  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await settle(window);
}

/**
 * Cut the app off from the internet, precisely.
 *
 * Only http(s) is blocked; `framevo://` is served by the app's own protocol
 * handler and is untouched, so the bundle, the media stream and SQLite all keep
 * working. That is exactly the state these tests need for two reasons:
 *
 *   • It is the honest environment for a local-first app's test suite — no
 *     Firestore reads, no Google calls, no dependence on a live project.
 *   • It is the ONLY way a seeded session can survive: online, Firebase would
 *     (correctly) reject the fake refresh token and sign the user out. That
 *     rejection is a feature — it is how a revoked account gets kicked — so the
 *     test works with it rather than around it.
 */
export async function goOffline(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ session }) => {
    // LOOPBACK IS NOT "THE NETWORK". In a dev-mode run the renderer is not a
    // static bundle at all — `framevo://` proxies to `next dev` on
    // http://localhost, and Next's HMR client opens a ws:// back to it. A blanket
    // cancel takes those down with the cloud, so the window loads NOTHING and the
    // whole run dies at the first reload with ERR_UNEXPECTED. (That is precisely
    // why the dev half of the perf comparison had never produced a number.)
    // Blocking the cloud is the goal; blocking ourselves is collateral.
    const isLoopback = (raw: string): boolean => {
      try {
        const { hostname } = new URL(raw);
        return (
          hostname === "localhost" ||
          hostname === "127.0.0.1" ||
          hostname === "[::1]" ||
          hostname === "::1"
        );
      } catch {
        return false;
      }
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (details, callback) => callback({ cancel: !isLoopback(details.url) })
    );
  });
}

/** Drop the persisted session — what a fresh installation looks like. */
export async function clearSession(window: Page): Promise<void> {
  await settle(window);
  await window.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("firebase:authUser:")) localStorage.removeItem(key);
    }
  });
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
  await settle(window);
}

/** The app's current route, without the `framevo://app` origin. */
export async function currentPath(window: Page): Promise<string> {
  return window.evaluate(() => window.location.pathname);
}

/**
 * Navigate the way a deep link or a restart does: a real load of the URL.
 *
 * It settles afterwards because the app frequently answers a load with a
 * CLIENT-side redirect (the auth gate sending you to /login, /login sending you
 * back to `next`). Returning while one of those is in flight means the next
 * `evaluate` runs into a destroyed execution context.
 */
export async function openRoute(window: Page, path: string): Promise<void> {
  await window.evaluate((p) => {
    window.location.href = `framevo://app${p}`;
  }, path);
  await window.waitForLoadState("domcontentloaded");
  await settle(window);
}

/** Wait until the route stops moving under us. */
export async function settle(window: Page, quietMs = 400): Promise<void> {
  let last = "";
  for (let i = 0; i < 20; i += 1) {
    const now = await window
      .evaluate(() => location.pathname + location.search)
      .catch(() => null);
    if (now !== null && now === last) return;
    last = now ?? "";
    await window.waitForTimeout(quietMs / 2);
  }
}
