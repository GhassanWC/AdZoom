/**
 * Serves the PRODUCTION standalone build — the same artifact Firebase App
 * Hosting runs (`output: "standalone"` in next.config.ts).
 *
 * `next start` does NOT support standalone output (Next prints a warning and
 * takes a different code path), so Playwright would otherwise be exercising a
 * server that prod never runs. This starts the real one.
 *
 * Next intentionally does not copy static assets into the standalone folder —
 * that is documented as the deployer's job — so we do it here before booting.
 *
 * Usage: node scripts/serve-standalone.mjs [--port 3100]
 */
import { spawn } from "node:child_process";
import { cp, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");

const portArg = process.argv.indexOf("--port");
const PORT = portArg !== -1 ? process.argv[portArg + 1] : process.env.PORT || "3100";

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const server = path.join(STANDALONE, "server.js");
if (!(await exists(server))) {
  console.error(
    `[serve-standalone] ${path.relative(ROOT, server)} not found — run \`npm run build\` first.`
  );
  process.exit(1);
}

// .next/static and public/ are NOT emitted into standalone/ by the build.
// Without them the pages render but every asset 404s.
await cp(path.join(ROOT, ".next", "static"), path.join(STANDALONE, ".next", "static"), {
  recursive: true,
});
if (await exists(path.join(ROOT, "public"))) {
  await cp(path.join(ROOT, "public"), path.join(STANDALONE, "public"), {
    recursive: true,
  });
}

console.log(`[serve-standalone] starting production server on port ${PORT}`);

const child = spawn(process.execPath, [server], {
  cwd: STANDALONE,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: String(PORT),
    // Bind explicitly: the standalone server defaults to localhost, which can
    // resolve to ::1 and miss Playwright's 127.0.0.1 baseURL.
    HOSTNAME: process.env.HOSTNAME || "127.0.0.1",
  },
});

const forward = (signal) => () => child.kill(signal);
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
