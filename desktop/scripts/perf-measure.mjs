/**
 * Run the editor perf measurement against ONE build mode.
 *
 *   node desktop/scripts/perf-measure.mjs prod    ← the static production bundle
 *   node desktop/scripts/perf-measure.mjs dev     ← the `next dev` renderer
 *
 * The app itself decides which renderer to serve by looking for
 * `renderer/out/index.html` (main/index.ts): present ⇒ the static production
 * bundle, absent ⇒ the dev server. So "measure the dev build" is done by moving
 * that one file aside for the duration of the run and putting it back
 * afterwards — no test-only branch in the app, and no second Electron entry
 * point that could drift from the real one.
 *
 * Results land in desktop/perf-results/<mode>.json, and the spec prints a line
 * per scenario as it goes.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDesktopConfig, resolveDesktopConfig } from "./read-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const rendererRoot = join(desktopRoot, "renderer");
const indexHtml = join(rendererRoot, "out", "index.html");
const hiddenHtml = `${indexHtml}.perf-hidden`;

const mode = (process.argv[2] ?? "prod").toLowerCase();
if (mode !== "dev" && mode !== "prod") {
  console.error(`usage: perf-measure.mjs [dev|prod]  (got "${mode}")`);
  process.exit(2);
}

const PORT = Number(process.env.FRAMEVO_DESKTOP_DEV_PORT ?? 3010);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function waitForPort(port, timeoutMs = 240_000) {
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
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

/** Put the production bundle back no matter how this process ends. */
function restoreIndex() {
  if (existsSync(hiddenHtml) && !existsSync(indexHtml)) {
    renameSync(hiddenHtml, indexHtml);
    console.log("[perf] restored renderer/out/index.html");
  }
}
process.on("exit", restoreIndex);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restoreIndex();
    stopDevServer();
    process.exit(1);
  });
}

/** Is something already listening on `port`? */
function portInUse(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

let devServer = null;

/**
 * Kill the dev server AND its children.
 *
 * `child.kill()` alone is not enough on Windows: `next dev` is started through
 * `npx.cmd`, so the signal reaches the shim and the real Next process keeps the
 * port. The next run then finds :3010 already listening, silently attaches to
 * that STALE server — which is running the previous run's environment — and
 * fails somewhere much later with no hint that it measured the wrong thing.
 */
function stopDevServer() {
  if (!devServer?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(devServer.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    devServer.kill();
  }
  devServer = null;
}

/**
 * Force `next dev` to compile the routes the run walks through, before Electron
 * asks for them. Each GET blocks until that route is built, so the time shows up
 * here as a log line instead of as an unexplained hang on the splash screen.
 */
async function warmRoutes(port) {
  const routes = [
    "/",
    "/login",
    "/dashboard",
    "/dashboard/projects",
    "/dashboard/upload",
    // The editor itself — by far the most expensive compile in the app, and the
    // one the measurement actually runs inside. It MUST be the placeholder id
    // (`generateStaticParams` in renderer/src/app/dashboard/projects/[id]) —
    // under `output: "export"` next dev rejects any other id outright, which is
    // a 500 rather than a compile.
    "/dashboard/projects/__project__",
  ];
  for (const route of routes) {
    const startedAt = Date.now();
    try {
      await fetch(`http://127.0.0.1:${port}${route}`, {
        signal: AbortSignal.timeout(600_000),
      });
      console.log(`[perf] compiled ${route} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    } catch (err) {
      // A route that won't pre-compile is not fatal — it just compiles later, on
      // demand, the slow way. Say so rather than failing the whole run.
      console.warn(`[perf] warm-up of ${route} failed: ${err.message}`);
    }
  }
}

async function main() {
  const env = { ...process.env, FRAMEVO_PERF_MODE: mode };

  if (mode === "dev") {
    if (!existsSync(indexHtml) && !existsSync(hiddenHtml)) {
      console.error("[perf] renderer/out/index.html is missing — run `npm run build --prefix desktop` first");
      process.exit(1);
    }
    // Refuse to attach to someone else's server. Attaching silently would
    // measure a renderer built from a different environment than this run set
    // up, and the numbers would look perfectly plausible.
    if (await portInUse(PORT)) {
      console.error(
        `[perf] :${PORT} is already in use — stop that process (or set ` +
          `FRAMEVO_DESKTOP_DEV_PORT) so this run owns its dev server`
      );
      process.exit(1);
    }
    console.log(`[perf] starting next dev on :${PORT}`);
    // The SAME public config `next build` bakes into the static renderer (see
    // build-renderer.mjs). Next reads `.env*` relative to desktop/renderer, where
    // those files do not live, so without this the dev renderer comes up with no
    // NEXT_PUBLIC_FIREBASE_* at all and every screen behind an account is dead —
    // the run then dies on "Framevo can't reach your account" rather than
    // measuring anything. Dev and prod must be the same app to be comparable.
    const config = assertDesktopConfig(resolveDesktopConfig(), "desktop:perf");
    Object.assign(env, config.publicEnv, {
      NEXT_PUBLIC_CLOUD_API_BASE: config.apiBaseUrl,
      NEXT_PUBLIC_EDITFRAME_EXPORT_ENABLED: "false",
      NEXT_PUBLIC_CLOUD_EXPORT_ENABLED: "false",
    });
    devServer = spawn(npx, ["next", "dev", "--port", String(PORT)], {
      cwd: rendererRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      env,
    });
    await waitForPort(PORT);
    // The port opens long before any ROUTE exists. `next dev` compiles per route,
    // on first request, and the editor route is the biggest in the app — cold, it
    // takes far longer than any action timeout in the spec, so the run dies on the
    // splash screen with the app looking hung. Compile them here instead, where
    // waiting is expected and reported.
    //
    // This is warm-up, not cheating: what we then measure is steady-state
    // interaction inside an already-compiled dev renderer, which is exactly the
    // state a developer works in. Leaving it out measures the compiler.
    await warmRoutes(PORT);
    // Only NOW hide the static bundle — a failed dev server must not leave the
    // app with no renderer at all.
    if (existsSync(indexHtml)) renameSync(indexHtml, hiddenHtml);
    env.FRAMEVO_DESKTOP_DEV_URL = `http://localhost:${PORT}`;
    console.log("[perf] app will load the dev renderer");
  } else {
    if (!existsSync(indexHtml)) {
      console.error("[perf] renderer/out/index.html is missing — run `npm run build --prefix desktop` first");
      process.exit(1);
    }
    console.log("[perf] app will load the static production renderer");
  }

  const result = spawnSync(
    npx,
    ["playwright", "test", "e2e/editor-perf.spec.ts", "--reporter=list"],
    { cwd: desktopRoot, stdio: "inherit", shell: process.platform === "win32", env }
  );

  restoreIndex();
  stopDevServer();
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error(`[perf] ${err.message}`);
  restoreIndex();
  stopDevServer();
  process.exit(1);
});
