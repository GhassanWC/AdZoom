/**
 * Desktop development.
 *
 *   1. start the Framevo WEB app on the port NEXT_PUBLIC_CLOUD_API_BASE names,
 *      unless something is already serving it,
 *   2. produce the renderer the window will load,
 *   3. bundle main/preload/render-cli with esbuild,
 *   4. launch Electron.
 *
 * The renderer is the SAME component tree the website builds.
 *
 * Step 1 is not a convenience. Desktop sign-in finishes by POSTing the
 * authorization code to the web app's /api/auth/desktop/exchange (the client
 * secret lives there and nowhere else), and in development that address is this
 * repo's own server. Starting only the renderer meant sign-in failed at the very
 * last step, after a full trip through Google, on a developer machine where
 * everything looked running.
 *
 * ── Step 2 serves a BUILT renderer, not `next dev` ─────────────────────────
 * Hot reload would be nicer, and it is what this script used to do. It does not
 * work: the app runs on its own `framevo://app` origin, and Next's dev client
 * cannot live there. Its hot-reload socket resolves to `wss://app/…` (a host
 * that does not exist), `next dev` answers 403 to any `/_next` request whose
 * origin it cannot attribute — a custom scheme sends neither Origin nor Referer
 * — and dynamic `import()` of a `framevo://` URL is refused outright by
 * Chromium. The window loaded every chunk and then sat on the server-rendered
 * splash forever, hydrating nothing, with no error in any console.
 *
 * So development runs the SAME path production does: a static export served by
 * the protocol handler. Same origin, same CSP, same media URLs — which also
 * means a bug seen here is a bug that ships. The cost is a rebuild to see a
 * change: `npm run build:renderer`.
 *
 * FRAMEVO_DESKTOP_HMR=1 restores the old `next dev` behaviour for anyone who
 * wants to work on that path. Expect the frozen splash described above.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { assertDesktopConfig, resolveDesktopConfig } from "./read-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const rendererRoot = resolve(desktopRoot, "renderer");
const rendererOut = resolve(rendererRoot, "out");
const repoRoot = resolve(desktopRoot, "..");
const PORT = Number(process.env.FRAMEVO_DESKTOP_DEV_PORT ?? 3010);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

/**
 * `desktop:dev` is DEVELOPMENT, stated outright rather than inferred.
 *
 * Everything below inherits it, so the renderer dev server, the main bundle and
 * Electron itself all resolve the same environment — and a production Firebase
 * project or OAuth client cannot reach a development run.
 */
const config = assertDesktopConfig(
  resolveDesktopConfig({ environment: "development" }),
  "desktop:dev"
);

/** Opt back into `next dev` + hot reload. See the header for what breaks. */
const useHmr = process.env.FRAMEVO_DESKTOP_HMR === "1";

/**
 * Env for every child: the resolved development configuration, explicitly.
 *
 * FRAMEVO_DESKTOP_DEV_URL is what tells the main process to proxy the window to
 * a dev server instead of serving the built export, so it is set ONLY in the
 * HMR path — and cleared otherwise, in case the shell exported one.
 */
const childEnv = {
  ...process.env,
  ...config.publicEnv,
  FRAMEVO_ENV: "development",
  NEXT_PUBLIC_CLOUD_API_BASE: config.apiBaseUrl,
  FRAMEVO_GOOGLE_DESKTOP_CLIENT_ID: config.googleClientId,
  FRAMEVO_DESKTOP_DEV_URL: useHmr ? `http://localhost:${PORT}` : "",
};

const children = [];
function shutdown(code = 0) {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/** Resolve once the dev server accepts connections. */
function waitForPort(port, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`dev server never came up on :${port}`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

/** Is something already accepting connections here? */
function portOpen(port, timeoutMs = 1_000) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const settle = (open) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/** The port of a cloud API that lives on this machine, or null if it's remote. */
function loopbackApiPort(apiBaseUrl) {
  try {
    const url = new URL(apiBaseUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    return Number(url.port || (url.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
}

// A production-style run points at framevo.app and needs nothing started here;
// FRAMEVO_DESKTOP_SKIP_WEB=1 opts out when the web app runs under a debugger or
// on a different port than the config names.
const apiPort = loopbackApiPort(config.apiBaseUrl);
if (apiPort && process.env.FRAMEVO_DESKTOP_SKIP_WEB !== "1") {
  if (await portOpen(apiPort)) {
    console.log(`[desktop:dev] using the Framevo web app already on :${apiPort}`);
  } else {
    console.log(`[desktop:dev] starting the Framevo web app on :${apiPort} (sign-in + cloud API)`);
    children.push(
      spawn(npx, ["next", "dev", "--port", String(apiPort)], {
        cwd: repoRoot,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: childEnv,
      })
    );
  }
}

/**
 * The renderer this run will show.
 *
 * A built export is reused when it is already a DEVELOPMENT one — the stamp
 * written by build-renderer.mjs says which. Rebuilding otherwise is the point:
 * a production export left on disk would put a production sign-in screen in
 * front of a development build, which Firebase rejects with a message naming
 * neither half (see src/main/build-identity.ts).
 */
function rendererNeedsBuild() {
  if (!existsSync(join(rendererOut, "index.html"))) return "no build on disk";
  try {
    const stamp = JSON.parse(readFileSync(join(rendererOut, "framevo-build.json"), "utf8"));
    if (stamp.environment !== "development") return `built for ${stamp.environment}`;
    if (stamp.firebaseProjectId !== config.firebaseProjectId) {
      return `built for ${stamp.firebaseProjectId || "no project"}`;
    }
    return null;
  } catch {
    return "no build stamp (older build)";
  }
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, options);
    children.push(child);
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`))
    );
  });
}

if (useHmr) {
  console.log(`[desktop:dev] HMR mode: starting renderer dev server on :${PORT}`);
  console.log("[desktop:dev] NOTE: the window may never hydrate — see scripts/dev.mjs");
  children.push(
    spawn(npx, ["next", "dev", "--port", String(PORT)], {
      cwd: rendererRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: childEnv,
    })
  );
} else {
  const reason = rendererNeedsBuild();
  if (reason) {
    console.log(`[desktop:dev] building the renderer (${reason})`);
    try {
      await run(process.execPath, [resolve(here, "build-renderer.mjs")], {
        cwd: desktopRoot,
        stdio: "inherit",
        env: childEnv,
      });
    } catch (err) {
      console.error(`[desktop:dev] ${err.message}`);
      shutdown(1);
    }
  } else {
    console.log("[desktop:dev] using the development renderer already in renderer/out");
    console.log("[desktop:dev] run `npm run build:renderer` after editing UI code");
  }
}

console.log("[desktop:dev] bundling main + preload + render CLI");
const bundle = spawn(process.execPath, [resolve(desktopRoot, "esbuild.mjs")], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: childEnv,
});
bundle.on("close", async (code) => {
  if (code !== 0) {
    console.error("[desktop:dev] bundle failed");
    shutdown(code ?? 1);
    return;
  }
  if (useHmr) {
    try {
      await waitForPort(PORT);
    } catch (err) {
      console.error(`[desktop:dev] ${err.message}`);
      shutdown(1);
      return;
    }
  }
  console.log("[desktop:dev] launching Electron");
  const electron = spawn(npx, ["electron", "."], {
    cwd: desktopRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: childEnv,
  });
  children.push(electron);
  electron.on("close", (electronCode) => shutdown(electronCode ?? 0));
});
