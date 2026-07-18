import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/**
 * E2E smoke tests. Specs live in `e2e/` (NOT `tests/`) so they stay clear of the
 * node:test runner, whose `npm test` glob is `tests/**\/*.test.ts`.
 *
 * Scope is deliberately unauthenticated public pages: the app guards Firebase
 * behind isFirebaseConfigured(), so these run against placeholder credentials
 * and CI never needs real secrets. Covering the editor/dashboard would require
 * a Firebase emulator and seeded accounts — see the workflow docs.
 */
export default defineConfig({
  testDir: "./e2e",
  // A failing smoke test should be a real signal, not a flake to re-run away.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // `channel: "chromium"` runs the FULL Chromium build rather than the
      // stripped chrome-headless-shell that Playwright otherwise defaults to in
      // headless mode. Closer to a real browser, and it means only one binary
      // has to be downloaded (`npx playwright install chromium`).
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
    },
  ],
  // Serves the PRODUCTION standalone bundle — the exact artifact Firebase App
  // Hosting runs. (`next start` does not support output: "standalone"; see
  // scripts/serve-standalone.mjs.) A smoke failure here is therefore a real
  // prod-mode regression, not a dev-only artifact.
  //
  // Requires `npm run build` first — this serves the existing .next, it does
  // not rebuild. Stale build in, stale results out.
  webServer: {
    command: `node scripts/serve-standalone.mjs --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
