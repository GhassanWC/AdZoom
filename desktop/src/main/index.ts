/**
 * Framevo Desktop — main process entry.
 *
 * Responsibilities, in order: harden the runtime, open the database, install
 * the `framevo://` protocol, create the window, register IPC, and shut down
 * cleanly (which is also what makes crash recovery meaningful — an unclean exit
 * leaves the session flags set).
 *
 * Security posture, all enforced here:
 *   • contextIsolation ON, sandbox ON, nodeIntegration OFF, webSecurity ON.
 *   • The renderer can only reach the preload's fixed API surface (see ipc.ts).
 *   • Navigation is pinned to the app origin; every other link opens in the
 *     user's real browser instead of an uncontrolled Electron window.
 *   • No remote content, no <webview>, no window.open.
 */
import { app, BrowserWindow, desktopCapturer, session, shell } from "electron";
import { join, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { AppInfo } from "@/lib/platform/types";
import { IPC } from "@/lib/platform/desktop/ipc";
import { openDatabase, type DbHandle } from "./db/client";
import { fileResolver, runMigrations } from "./db/migrate";
import { createLibrary, type Library } from "./library";
import { createSyncStore, reclaimStale, type SyncStore } from "./sync-store";
import { newOpId } from "@/lib/sync/revision";
// The SAME grammar the website builds links with — one module authors and
// validates them, so the two halves cannot drift into an exploitable gap.
import { resolveDeepLinkRoute } from "@/lib/desktop/deep-link";
import { createMediaStore, type MediaStore } from "./media";
import { createMediaUploadsStore } from "./media-uploads";
import { createMediaDownloadsStore } from "./media-downloads";
import { createDownloadRunner } from "./download-runner";
import { digestFile } from "./checksum";
import { createExportsStore, type ExportsStore } from "./exports-store";
import { createStorageService, type StorageService } from "./storage-usage";
import { registerIpc, markProjectsClosed, RecoverySnapshot } from "./ipc";
import { initCrashReporting, initLogging, logger, reportError } from "./logger";
import {
  describeBuildMismatch,
  oauthProjectNumber,
  parseRendererStamp,
  type RendererBuildStamp,
} from "./build-identity";
import { FFMPEG_MISSING_MESSAGE, resolveFfmpegPaths } from "./ffmpeg-paths";
import { ExportService } from "./export/service";
import {
  APP_ORIGIN,
  APP_SCHEME,
  buildCsp,
  installProtocolHandler,
  registerAppScheme,
} from "./protocol";
import { initAutoUpdate } from "./updater";

const isDev = !app.isPackaged;
/**
 * Dev renderer (see scripts/dev.mjs). Production serves the static export.
 *
 * Set EXPLICITLY means "use this, not whatever is on disk". Without that
 * distinction a leftover renderer/out — built weeks ago, quite possibly for the
 * other environment — silently wins over the dev server that was just started
 * for this run, and the app shows a stale screen with no hint that it did.
 */
// Empty counts as unset: `desktop:dev` clears it to say "serve the build".
const DEV_SERVER_URL_EXPLICIT = process.env.FRAMEVO_DESKTOP_DEV_URL || null;
const DEV_SERVER_URL = DEV_SERVER_URL_EXPLICIT ?? "http://localhost:3010";

/**
 * The Google DESKTOP OAuth client id, baked in at build time.
 *
 * A client id is public information — it appears in the authorization URL the
 * user's browser loads. The matching SECRET is not here and never will be: the
 * authorization-code exchange happens on Framevo's server (see
 * src/app/api/auth/desktop/exchange). Nothing in this bundle can redeem a code
 * on its own, which is the entire point of the PKCE + server-exchange design.
 */
const GOOGLE_DESKTOP_CLIENT_ID = process.env.FRAMEVO_GOOGLE_DESKTOP_CLIENT_ID ?? "";

/** Which environment this bundle was built for, substituted at build time. */
const BUILD_ENVIRONMENT = process.env.FRAMEVO_ENV ?? "development";
/** The Firebase project the renderer will initialize. Non-secret. */
const BUILD_FIREBASE_PROJECT_ID = process.env.FRAMEVO_FIREBASE_PROJECT_ID ?? "";

/**
 * The environment stamp of the renderer being served, once it is known.
 *
 * Null while the app is still starting, and null for a dev server (which is
 * built by the same command that launched this process, so it cannot disagree).
 */
let rendererStamp: RendererBuildStamp | null = null;

/** The renderer's own account of which project it signs in to. */
function readRendererStamp(staticRoot: string): RendererBuildStamp | null {
  const file = join(staticRoot, "framevo-build.json");
  if (!existsSync(file)) return null;
  try {
    return parseRendererStamp(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    logger.warn("renderer build stamp unreadable", { message: String(err) });
    return null;
  }
}

/** Non-null when this bundle and the renderer it serves are from different projects. */
function buildMismatch(): string | null {
  return describeBuildMismatch(
    {
      environment: BUILD_ENVIRONMENT,
      googleClientId: GOOGLE_DESKTOP_CLIENT_ID,
      apiBaseUrl: process.env.NEXT_PUBLIC_CLOUD_API_BASE ?? "",
    },
    rendererStamp
  );
}

/** The route a deep link opens when it names nothing more specific. */
const DEEP_LINK_DEFAULT = "/dashboard";

// MUST be called before `whenReady` — privileges are locked in at scheme
// registration time.
registerAppScheme();

/**
 * Who this process IS, as far as the Windows shell is concerned.
 *
 * The AppUserModelID is what the taskbar groups windows by, what a pinned
 * shortcut is matched against, and what a toast notification is attributed to.
 * Left unset, Electron reports a per-executable default — so in development the
 * window docks under "Electron" with Electron's icon, and after an update a
 * pinned Framevo tile can come unstuck from the running app.
 *
 * The value matches `appBundleId` in forge.config.ts and the shortcut Squirrel
 * writes; they have to agree or the pin and the window are two different apps.
 */
if (process.platform === "win32") app.setAppUserModelId("com.framevo.desktop");

let db: DbHandle | null = null;
let library: Library | null = null;
let syncStore: SyncStore | null = null;
/**
 * The signed-in account, as reported by the renderer.
 *
 * Null until sign-in lands (and again after sign-out). While null nothing is
 * queued for sync and nothing already queued is drained — but nothing is
 * discarded either, so a user who signs back in finds their pending work intact.
 */
let currentOwnerUid: string | null = null;
let mediaStore: MediaStore | null = null;
let exportsStore: ExportsStore | null = null;
let storageService: StorageService | null = null;
let mainWindow: BrowserWindow | null = null;
const exportService = new ExportService();

/**
 * Runtime resources (the render CLI, the migration SQL).
 *
 * Packaged: `resources/…` next to the executable — they cannot live inside
 * app.asar because one is executed as a child process and the other is read
 * with `fs`. In development they are wherever esbuild wrote them (.vite/).
 */
function resourcePath(...segments: string[]): string {
  return app.isPackaged
    ? join(process.resourcesPath, ...segments)
    : join(app.getAppPath(), ".vite", ...segments);
}

/**
 * Say — once, at startup — exactly which project this build talks to.
 *
 * Every value here is a public identifier: a Firebase project id, a Google
 * Cloud project number, an OAuth client id and an API origin. No key, no
 * secret, no token. It exists because the failure it guards against
 * (`auth/invalid-credential`) names neither of the two things that disagree,
 * so a log line naming both is the difference between a five-minute fix and an
 * afternoon.
 */
function reportAuthConfiguration(): void {
  const clientProject = oauthProjectNumber(GOOGLE_DESKTOP_CLIENT_ID);
  logger.info("auth configuration", {
    environment: BUILD_ENVIRONMENT,
    firebaseProject: BUILD_FIREBASE_PROJECT_ID || "(none)",
    oauthClientId: GOOGLE_DESKTOP_CLIENT_ID || "(none)",
    oauthProjectNumber: clientProject ?? "(none)",
    apiBase: process.env.NEXT_PUBLIC_CLOUD_API_BASE || "(none)",
    rendererEnvironment: rendererStamp?.environment ?? "(dev server)",
    rendererProjectNumber: rendererStamp?.messagingSenderId ?? "(dev server)",
  });

  // The one failure this whole block exists to prevent, now caught before the
  // user presses anything.
  const mismatch = buildMismatch();
  if (mismatch) logger.error("build environment mismatch", { detail: mismatch });

  if (!GOOGLE_DESKTOP_CLIENT_ID) {
    logger.warn(
      "no FRAMEVO_GOOGLE_DESKTOP_CLIENT_ID — Google sign-in will be unavailable in this build"
    );
    return;
  }
  if (!clientProject) {
    logger.error(
      "the Google desktop OAuth client id is malformed — Google sign-in will fail",
      { oauthClientId: GOOGLE_DESKTOP_CLIENT_ID }
    );
  }
}

function buildAppInfo(): AppInfo {
  return {
    version: app.getVersion(),
    platform: process.platform as AppInfo["platform"],
    apiBaseUrl: process.env.NEXT_PUBLIC_CLOUD_API_BASE ?? "",
    updateFeedConfigured: Boolean(process.env.FRAMEVO_UPDATE_FEED_URL),
    // The sign-in screen reads this to explain WHY the Google button is
    // disabled, instead of failing silently when the user presses it.
    googleSignInConfigured: Boolean(
      GOOGLE_DESKTOP_CLIENT_ID && process.env.NEXT_PUBLIC_CLOUD_API_BASE
    ),
    // Sign-in CANNOT succeed while this is set — Firebase rejects the token —
    // so the screen says which halves disagree instead of offering a button
    // whose only outcome is auth/invalid-credential.
    buildMismatch: buildMismatch(),
  };
}

/**
 * The app icon, as a file the window can load.
 *
 * PACKAGED WINDOWS DOES NOT NEED THIS — the taskbar reads the icon compiled into
 * `Framevo.exe` by the packager. Every other case does: in DEVELOPMENT the
 * executable is `electron.exe`, so without this the window and the taskbar show
 * Electron's own atom, and on Linux the window icon is only ever this value.
 *
 * `resourcePath` resolves to `.vite/` in development and `resources/` when
 * packaged; esbuild and stage-resources.mjs put the file in both.
 */
function appIconPath(): string {
  return resourcePath(process.platform === "win32" ? "icon.ico" : "icon.png");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: "#0B0B10",
    title: "Framevo",
    icon: appIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      // The editor decodes video into canvases constantly; a backgrounded
      // window must not have its timers throttled mid-export/preview.
      backgroundThrottling: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // Links to anything that isn't the app open in the user's browser. Nothing
  // ever opens a new Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Internal routes (framevo://app/dashboard/…) navigate in place — that is
  // what makes reload, back/forward and deep links work like a real app.
  // Everything else leaves for the user's browser; nothing external is ever
  // rendered inside the Electron window.
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = url.startsWith(APP_ORIGIN) || (isDev && url.startsWith(DEV_SERVER_URL));
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      logger.warn("blocked in-app navigation", { to: new URL(url).origin });
    }
  });

  // A crashed renderer must be visible in the logs, not a silently blank window.
  window.webContents.on("render-process-gone", (_event, details) => {
    reportError(new Error(`renderer gone: ${details.reason}`), { exitCode: details.exitCode });
  });

  // A blank window is the hardest desktop bug to diagnose after the fact, so
  // load failures and renderer errors are always logged (redacted).
  window.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL) => {
    logger.error("renderer failed to load", { errorCode, errorDescription, url: validatedURL });
  });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") {
      logger.warn("renderer error", { message: details.message, line: details.lineNumber });
    }
  });

  // A COLD-START deep link arrives in argv, not through `second-instance` —
  // that event only fires when the app was already running. Clicking "Open
  // Framevo" on the website with the app closed is the common case, so the
  // opening route has to come from argv when one is there, or the link silently
  // degrades to "just opens the dashboard".
  const pending = deepLinkFromArgv(process.argv);
  const route = pending ? `${resolveDeepLinkRoute(pending)}?src=deeplink` : DEEP_LINK_DEFAULT;
  if (pending) logger.info("cold-start deep link", { route });
  void window.loadURL(`${APP_ORIGIN}${route}`);
  return window;
}

/** The first `framevo://` argument in a launch command line, if any. */
function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${APP_SCHEME}://`)) ?? null;
}

/**
 * Screen + camera + microphone capture, for the Record screen.
 *
 * A browser hands `getDisplayMedia()` to Chrome's own picker; Electron has no
 * picker unless the app provides one, so without this the Record screen would
 * reject every take with "Permission denied" — the single most common way a
 * working web recorder dies when it is put in an Electron window.
 *
 * The policy is deliberately narrow: only the app's own origin may ask, and
 * only for the three capture permissions the recorder actually uses.
 */
const CAPTURE_PERMISSIONS = new Set(["media", "audioCapture", "videoCapture", "display-capture"]);

function installMediaPermissions(): void {
  const ses = session.defaultSession;

  const isAppOrigin = (url: string): boolean =>
    url.startsWith(APP_ORIGIN) || (isDev && url.startsWith(DEV_SERVER_URL));

  ses.setPermissionRequestHandler((contents, permission, callback) => {
    const url = contents?.getURL() ?? "";
    const granted = isAppOrigin(url) && CAPTURE_PERMISSIONS.has(permission);
    if (!granted) {
      logger.warn("permission request denied", { permission });
    }
    callback(granted);
  });

  // The synchronous sibling — Chromium consults this one for some checks, and
  // a permission that passes the async handler but fails here still fails.
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    CAPTURE_PERMISSIONS.has(permission) && isAppOrigin(requestingOrigin)
  );

  // `getDisplayMedia()` — hand Chromium the picker Electron doesn't ship.
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      void desktopCapturer
        .getSources({
          types: ["screen", "window"],
          // A thumbnail is what makes Electron's own source chooser usable;
          // Chromium renders it in the picker it shows the user.
          thumbnailSize: { width: 320, height: 180 },
          fetchWindowIcons: true,
        })
        .then((sources) => {
          const primary = sources[0];
          if (!primary) {
            // Nothing capturable (a locked session, a headless CI box): refuse
            // cleanly so the recorder surfaces its own error instead of hanging.
            callback({});
            return;
          }
          callback({
            video: primary,
            // Loopback system audio, where the platform supports it. The
            // recorder already treats a missing audio track as "screen audio
            // unavailable", so this degrades rather than fails.
            audio: process.platform === "win32" ? "loopback" : undefined,
          });
        })
        .catch((err) => {
          reportError(err, { phase: "display-media" });
          callback({});
        });
    },
    // Let Chromium show its own picker UI so the USER chooses the surface —
    // an app that silently grabs screen 1 is a surveillance bug, not a feature.
    { useSystemPicker: true }
  );
}

/**
 * Deep links (`framevo://open/dashboard/…`) arriving from outside the app.
 *
 * The website's "Open Framevo" button issues these so someone who already has
 * the app lands in it instead of being sold it again. They carry NO credential:
 * sign-in's authorization code goes to the loopback listener, never through a
 * URL the OS might log.
 *
 * ── Why the route is validated, not just used ──────────────────────────────
 * A custom scheme is an OS-wide entry point — ANY web page in ANY browser can
 * navigate to `framevo://…` and the OS hands the string here. Loading its path
 * directly would let an arbitrary page choose which screen of a signed-in app
 * opens, with whatever query string it fancied. `resolveDeepLinkRoute` accepts
 * only routes from a closed allowlist and falls back to the dashboard, so the
 * worst an attacker-authored link can do is open the app.
 */
function handleDeepLink(rawUrl: string): void {
  if (!rawUrl.startsWith(`${APP_SCHEME}://`)) return;
  const target = resolveDeepLinkRoute(rawUrl);
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
  logger.info("deep link opened", { route: target });
  // `src=deeplink` lets the renderer report that the website's "Open Framevo"
  // handoff actually landed (DesktopAppTelemetry). It carries nothing else —
  // the route itself is already validated above.
  void window.loadURL(`${APP_ORIGIN}${target}?src=deeplink`);
}

async function bootstrap(): Promise<void> {
  const logPath = initLogging(app.getPath("logs"), isDev ? "debug" : "info");
  initCrashReporting(
    {
      appVersion: app.getVersion(),
      platform: process.platform,
      environment: isDev ? "development" : "production",
    },
    process.env.FRAMEVO_SENTRY_DSN
  );
  logger.info("starting Framevo desktop", {
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    logPath,
  });

  // ── Database ──────────────────────────────────────────────────────────────
  const libraryDir = app.getPath("userData");
  const dbPath = join(libraryDir, "framevo-library.db");
  db = openDatabase(dbPath);
  const migrations = runMigrations(db.raw, fileResolver(resourcePath("migrations")));
  if (migrations.applied.length) logger.info("migrations applied", { applied: migrations.applied });

  // ── Sync ──────────────────────────────────────────────────────────────────
  // The queue is durable here; the network half runs in the renderer, which is
  // where the authenticated Firebase session lives. `ownerUid` starts null and
  // is set over IPC once the renderer knows who is signed in — until then
  // nothing is queued, so a write during startup can never be stamped with the
  // wrong account.
  syncStore = createSyncStore(db.db);
  const deviceId = await syncStore.deviceId();
  const reclaimed = await reclaimStale(db.db);
  if (reclaimed) logger.info("reclaimed stranded sync operations", { count: reclaimed });

  library = createLibrary(db.db, db.raw, {
    ownerUid: () => currentOwnerUid,
    deviceId: () => deviceId,
    newOpId,
    // The enqueue itself happens inside library.write's transaction; this hook
    // only supplies identity. Kept on the interface so a future non-SQLite
    // library could implement it differently.
    enqueue: () => {},
  });
  const ffmpeg = resolveFfmpegPaths({
    resourcesDir: app.isPackaged ? process.resourcesPath : undefined,
    nodeModulesDir: join(app.getAppPath(), "node_modules"),
  });
  if (ffmpeg.source === "missing") logger.error(FFMPEG_MISSING_MESSAGE);
  else logger.info("ffmpeg resolved", { source: ffmpeg.source });
  // Recordings are the only video bytes Framevo writes; they go next to the
  // library so the Storage screen can account for them as reclaimable.
  const recordingsDir = join(libraryDir, "recordings");
  mediaStore = createMediaStore(db.db, () => ffmpeg.ffprobe, recordingsDir);
  exportsStore = createExportsStore(db.db);
  // A render lives in one process, so anything still "rendering" here belongs to
  // a run that ended. Settling it at launch is what stops a finished file from
  // showing a spinner forever in Exports.
  await exportsStore.reconcileOnLaunch().catch((err: unknown) => {
    logger.warn("could not settle unfinished exports", { message: String(err) });
  });

  // ── The source video's two journeys ───────────────────────────────────────
  // The document queue above moves kilobytes and needs nobody's permission.
  // These move the recording itself, only when asked, and each has its own
  // queue so a 4 GB upload can never sit in front of a title change.
  const mediaUploads = createMediaUploadsStore(db.db, {
    // Through the LIBRARY, so the repoint and the sync operation carrying it to
    // Firestore are one transaction. See MediaUploadsStoreOptions.
    repoint: async (projectId, patch) => {
      await library!.write(projectId, patch);
    },
  });
  const mediaDownloads = createMediaDownloadsStore(db.db);
  const downloadRunner = createDownloadRunner({
    store: mediaDownloads,
    mediaStore,
    // Downloads land beside recordings: both are files Framevo owns, and the
    // Storage screen accounts for the whole folder as reclaimable.
    downloadsDir: join(libraryDir, "downloads"),
    onProgress: (event) => {
      const win = mainWindow;
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.mediaTransferChanged, {
          projectId: event.projectId,
          direction: "download",
          state: "active",
          bytesTransferred: event.bytesReceived,
          bytesTotal: event.bytesTotal,
        });
      }
    },
    onSettled: async ({ projectId, ok, error }) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      const snapshot = await mediaDownloads.stateFor(projectId);
      win.webContents.send(IPC.mediaTransferChanged, {
        projectId,
        direction: "download",
        state: ok ? "done" : (snapshot?.state ?? "failed") === "pending" ? "pending" : "failed",
        bytesTransferred: snapshot?.bytesReceived ?? 0,
        bytesTotal: snapshot?.bytesTotal ?? 0,
        lastError: ok ? undefined : error,
      });
      // The project now has a local video, so its document reads differently
      // (see the two-copy rule in library.ts) — tell the library.
      if (ok) {
        win.webContents.send(IPC.projectsChanged, {
          projectId,
          doc: await library!.get(projectId),
        });
      }
    },
  });
  storageService = createStorageService({
    db: db.db,
    raw: db.raw,
    libraryDir,
    databasePath: dbPath,
  });

  // Anything still flagged open belongs to a session that died — surface it as
  // recoverable rather than silently discarding or silently adopting it.
  //
  // This runs BEFORE the window exists, and the answer is frozen for the rest
  // of the run: once the user opens a project it is flagged open too, so asking
  // the database again later (on a reload, say) would report a crash that never
  // happened.
  const pending = await library.pendingRecovery();
  const recoveryAtLaunch = new RecoverySnapshot(pending);
  if (pending.length) {
    logger.warn("unclean shutdown detected", { projects: pending.length });
  }

  // ── Protocol ──────────────────────────────────────────────────────────────
  const staticRoot = app.isPackaged ? resourcePath("app") : join(app.getAppPath(), "renderer", "out");
  // An explicitly-passed dev URL is the run's intent and outranks any export
  // left on disk; without one, a built export is used when there is one.
  const useDevServer =
    isDev && (Boolean(DEV_SERVER_URL_EXPLICIT) || !existsSync(join(staticRoot, "index.html")));
  // Only a served export can disagree with this bundle — a dev server is built
  // from the same environment that launched it.
  rendererStamp = useDevServer ? null : readRendererStamp(staticRoot);
  installProtocolHandler({
    staticRoot: useDevServer ? null : staticRoot,
    devServerUrl: useDevServer ? DEV_SERVER_URL : null,
    csp: buildCsp(process.env.NEXT_PUBLIC_CLOUD_API_BASE ?? "", isDev),
    resolveMedia: async (mediaId) => {
      const check = await mediaStore!.revalidate(mediaId);
      return check?.ok ? check.row.path : null;
    },
  });
  logger.info("protocol installed", {
    mode: useDevServer ? "dev-server" : "static",
  });

  installMediaPermissions();

  // ── IPC ───────────────────────────────────────────────────────────────────
  registerIpc({
    db: db.db,
    library,
    mediaStore,
    exportService,
    exportsStore,
    storageService,
    appInfo: buildAppInfo(),
    ffmpeg,
    renderCliPath: resourcePath("render-cli.mjs"),
    libraryDir,
    recoveryAtLaunch,
    googleClientId: GOOGLE_DESKTOP_CLIENT_ID,
    mainWindow: () => mainWindow,
    currentOwnerUid: () => currentOwnerUid,
    syncStore: syncStore!,
    mediaUploads,
    mediaDownloads,
    downloadRunner,
    digestFile: (path) => digestFile(path),
    setOwnerUid: (uid) => {
      if (currentOwnerUid === uid) return;
      currentOwnerUid = uid;
      logger.info("sync owner changed", { signedIn: uid !== null });
    },
  });

  reportAuthConfiguration();

  mainWindow = createWindow();
  initAutoUpdate({ feedUrl: process.env.FRAMEVO_UPDATE_FEED_URL, version: app.getVersion() });
}

// Register as the OS handler for `framevo://`, so the sign-in callback page can
// hand focus back to the app. In development Electron is launched through a
// stub executable, so the path + argv have to be spelled out for the OS.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_SCHEME, process.execPath, [
      resolvePath(process.argv[1]!),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(APP_SCHEME);
}

// Single instance: a second launch focuses the existing window instead of
// opening a second one onto the same SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows/Linux deliver a deep link as the argv of a SECOND launch, which the
  // single-instance lock funnels here.
  app.on("second-instance", (_event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const link = deepLinkFromArgv(argv);
    if (link) handleDeepLink(link);
  });

  // macOS delivers it to the running instance instead.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(bootstrap).catch((err) => {
    reportError(err, { phase: "bootstrap" });
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    // A clean quit: stop renders, clear the session flags (so the next launch
    // does NOT offer recovery), and close the database.
    exportService.cancelAll();
    // Synchronous: the database is closed on the next line, so an async write
    // here would never land (that race left every project flagged "open").
    if (library) markProjectsClosed(library);
    db?.close();
    logger.info("shutting down");
  });
}

// Any unhandled failure in main is reported and logged rather than killing the
// process silently.
process.on("uncaughtException", (err) => reportError(err, { phase: "uncaught" }));
process.on("unhandledRejection", (reason) => reportError(reason, { phase: "unhandled-rejection" }));
