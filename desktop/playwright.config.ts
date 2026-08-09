import { defineConfig } from "@playwright/test";

/**
 * Desktop integration tests.
 *
 * These drive the REAL packaged-shape app: Electron's main process, the
 * `framevo://` protocol, the SQLite library and the render subprocess. No web
 * server and no browser project — Playwright's `_electron` fixture launches the
 * app itself, so `desktop/e2e` is deliberately separate from the website's
 * `e2e/` suite (which runs against the standalone Next server).
 *
 * Run: npm run test:e2e --prefix desktop  (after `npm run build --prefix desktop`)
 */
export default defineConfig({
  testDir: "./e2e",
  // Rendering a video is minutes of real work in the worst case; the individual
  // assertions are fast but the fixtures are genuinely encoded.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // One Electron app at a time — they would share the same user-data lock.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
