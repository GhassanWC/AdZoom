/**
 * `framevo://` deep links against the PACKAGED app.
 *
 * The website's "Open Framevo" button is a bare OS handoff — the browser gives
 * the string to Windows, Windows launches the app with it in argv. Two things
 * therefore need proving on the real artifact rather than in a unit test:
 *
 *   1. A COLD START honours the link. `second-instance` only fires when the app
 *      was already running, so an app that only listens for that event opens
 *      the dashboard and silently drops wherever the user was headed — which is
 *      the common case, since people click the link precisely because the app
 *      isn't open.
 *
 *   2. A HOSTILE link cannot steer the app. Any web page in any browser can
 *      navigate to `framevo://…`; the allowlist in lib/desktop/deep-link.ts is
 *      what stops that being a way to choose a signed-in user's screen.
 *
 * Each case launches its own app instance, because argv is fixed at launch.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { DESKTOP_ROOT, currentPath, goOffline } from "./fixtures";

const PACKAGED_EXE = resolve(DESKTOP_ROOT, "out", `Framevo-win32-${process.arch}`, "Framevo.exe");

test.describe.configure({ mode: "serial" });
test.skip(!existsSync(PACKAGED_EXE), "run `npm run package:win` first");

/** Launch the packaged app as if the OS had handed it `link` on the command line. */
async function launchWithLink(link: string) {
  const profileDir = mkdtempSync(join(tmpdir(), "framevo-deeplink-profile-"));
  const app: ElectronApplication = await electron.launch({
    executablePath: PACKAGED_EXE,
    args: [`--user-data-dir=${profileDir}`, link],
    env: { ...process.env, FRAMEVO_UPDATE_FEED_URL: "", FRAMEVO_SENTRY_DSN: "" },
  });
  await goOffline(app);
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  return {
    app,
    window,
    async close() {
      await app.close().catch(() => undefined);
      // Windows keeps a handle on the profile briefly after exit; the directory
      // is in the OS temp dir either way, so a failed cleanup must not fail the
      // test that just passed.
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        /* the OS will reclaim it */
      }
    },
  };
}

test("a cold-start deep link opens the route it named", async () => {
  const launched = await launchWithLink("framevo://open/dashboard/exports");
  try {
    // Signed out, so the app lands on /login — but it must have been HEADED for
    // the deep-linked route. The redirect target is what proves argv was read.
    await expect
      .poll(() => launched.window.url(), { timeout: 30_000 })
      .toMatch(/^framevo:\/\/app\//);
    const path = await currentPath(launched.window);
    expect(
      path === "/dashboard/exports" || path === "/login",
      `expected the deep-linked route or the sign-in redirect, got ${path}`
    ).toBeTruthy();
    // `src=deeplink` is what the renderer reports the landing with, and its
    // presence is the unambiguous signal that argv was honoured rather than the
    // default dashboard route being loaded.
    const search = await launched.window.evaluate(() => window.location.search);
    expect(search).toContain("src=deeplink");
  } finally {
    await launched.close();
  }
});

test("a hostile deep link cannot steer the app anywhere it likes", async () => {
  const launched = await launchWithLink("framevo://open/../../etc/passwd");
  try {
    await expect
      .poll(() => launched.window.url(), { timeout: 30_000 })
      .toMatch(/^framevo:\/\/app\//);
    const path = await currentPath(launched.window);
    // Falls back to the dashboard (then the sign-in redirect) — never to
    // whatever the link asked for.
    expect(["/dashboard", "/login"]).toContain(path);
  } finally {
    await launched.close();
  }
});
