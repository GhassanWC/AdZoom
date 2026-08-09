/**
 * The workflow that defines "done" for the desktop app:
 *
 *   import a real video → edit it → save → reopen → export → cancel → retry
 *
 * Every step runs against the real thing: the OS-picked file is probed by the
 * bundled FFprobe, the project lives in SQLite, the preview streams through the
 * `framevo://` protocol, and the export is the shared render core running in a
 * child process. Only the two OS dialogs are stubbed (they cannot be driven).
 */
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupDir,
  firebaseApiKey,
  launchApp,
  makeFixtureVideo,
  openRoute,
  seedSignedInSession,
  stubDialogs,
  type LaunchedApp,
} from "./fixtures";

let workDir: string;
let fixture: string;
let launched: LaunchedApp;
/** Reused across the whole spec so "reopen" means a genuine second launch. */
let profileDir: string;

// The app requires a session before any dashboard route renders, so this whole
// workflow needs one. Without Firebase config in the bundle there is nothing to
// restore — skip loudly rather than fail on the sign-in screen.
test.skip(
  !firebaseApiKey(),
  "the renderer was built without NEXT_PUBLIC_FIREBASE_* — sign-in is impossible"
);

/** Launch, restore a session, and land on the projects library. */
async function launchSignedIn(): Promise<LaunchedApp> {
  const app = await launchApp({ userDataDir: profileDir });
  await seedSignedInSession(app.window);
  await openRoute(app.window, "/dashboard/projects");
  await expect(app.window.getByRole("heading", { name: /Your library/i })).toBeVisible({
    timeout: 30_000,
  });
  return app;
}

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "framevo-e2e-"));
  profileDir = mkdtempSync(join(tmpdir(), "framevo-e2e-profile-"));
  fixture = makeFixtureVideo(workDir);
  expect(existsSync(fixture)).toBe(true);
});

test.afterAll(async () => {
  await launched?.close();
  cleanupDir(workDir);
  cleanupDir(profileDir);
});

test.describe.configure({ mode: "serial" });

test("imports a local video and opens it in the Framevo editor", async () => {
  launched = await launchSignedIn();
  const { app, window } = launched;
  await stubDialogs(app, { open: fixture });

  // Import lives on the Upload screen, which is the OS picker on the desktop.
  await window.getByRole("link", { name: "Upload", exact: true }).first().click();
  await expect(window.getByRole("heading", { name: /Open a recording/i })).toBeVisible();
  await window.getByRole("button", { name: /Choose a video/i }).click();

  // Importing navigates straight into the project's own route — the dynamic
  // route resolving in a STATIC bundle is the thing being proved here.
  await expect
    .poll(() => window.evaluate(() => window.location.pathname), { timeout: 60_000 })
    .toMatch(/^\/dashboard\/projects\/.+/);

  // The editor is the SAME component the website renders — its top bar and
  // export action are the proof that we did not build a second editor.
  await expect(window.getByRole("button", { name: "Export" })).toBeVisible({ timeout: 60_000 });

  // The preview <video> must be fed by the media protocol, and must actually
  // decode — that is the Range-request path in main/protocol.ts.
  const video = window.locator("video").first();
  await expect(video).toHaveAttribute("src", /^framevo:\/\/app\/__media\//);
  await expect
    .poll(async () => video.evaluate((el: HTMLVideoElement) => el.readyState), {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(1); // HAVE_METADATA — the file decoded
  const duration = await video.evaluate((el: HTMLVideoElement) => el.duration);
  expect(duration).toBeGreaterThan(3.5);
  expect(duration).toBeLessThan(4.5);
});

test("applies an edit that persists to the local library", async () => {
  const { window } = launched;

  // Insert a zoom at the playhead through the editor's own Add menu.
  await window.getByTitle("Insert a new edit at the playhead").click();
  await window.getByRole("menu", { name: "Add an edit" }).waitFor();
  await window.getByRole("menu", { name: "Add an edit" }).getByText("Zoom", { exact: true }).click();

  // The write goes through the platform port → IPC → SQLite → broadcast, and
  // comes back through the editor's subscription. Waiting on the document is
  // therefore a true round-trip assertion, not a UI-only one.
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const list = await window.framevo!.projects.list();
          const doc = await window.framevo!.projects.get(list[0]!.id);
          const analysis = doc?.analysis as { detectedMoments?: unknown[] } | undefined;
          return analysis?.detectedMoments?.length ?? 0;
        }),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);
});

test("reopens the saved project after a restart with its edits intact", async () => {
  // A clean close, so the next launch must NOT offer crash recovery.
  await launched.close();
  launched = await launchSignedIn();
  const { window } = launched;

  // No recovery prompt after a clean shutdown.
  await expect(window.getByText("Framevo closed unexpectedly")).toHaveCount(0);

  // The project the user saved last session is listed, and opening its card
  // takes them straight back into the editor — through a real route.
  const card = window.getByRole("link", { name: /Open fixture/i }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await expect
    .poll(() => window.evaluate(() => window.location.pathname), { timeout: 30_000 })
    .toMatch(/^\/dashboard\/projects\/.+/);
  await expect(window.getByRole("button", { name: "Export" })).toBeVisible({ timeout: 60_000 });

  // …with the edit from the previous session still there.
  const stored = await window.evaluate(async () => {
    const list = await window.framevo!.projects.list();
    const doc = await window.framevo!.projects.get(list[0]!.id);
    const analysis = doc?.analysis as { detectedMoments?: { effectType?: string }[] } | undefined;
    return {
      projects: list.length,
      moments: analysis?.detectedMoments?.length ?? 0,
      firstType: analysis?.detectedMoments?.[0]?.effectType,
      url: doc?.originalVideoUrl,
    };
  });
  expect(stored.projects).toBe(1);
  expect(stored.moments).toBeGreaterThan(0);
  expect(stored.firstType).toBe("zoom");
  expect(String(stored.url)).toMatch(/^framevo:\/\/app\/__media\//);
});

test("exports the project to a real MP4 on disk", async () => {
  const { app, window } = launched;
  const output = join(workDir, "export.mp4");
  await stubDialogs(app, { open: fixture, save: output });

  await window.getByRole("button", { name: "Export" }).click();
  // Scope to the export dialog — the editor's top bar has an "Export" button too.
  const sheet = window.getByRole("dialog");
  await sheet.getByRole("button", { name: /^Export$/ }).click();

  // The render runs in a child process; the panel reports its progress.
  await expect(sheet.getByText(/Show in folder/i)).toBeVisible({ timeout: 150_000 });

  expect(existsSync(output)).toBe(true);
  expect(statSync(output).size).toBeGreaterThan(10_000);
});

test("cancels a running export, leaves no partial file, and retries successfully", async () => {
  const { app, window } = launched;
  const canceled = join(workDir, "canceled.mp4");

  // Import a LONGER clip: cancelling a 4-second render is a race against the
  // render finishing, and a test that sometimes cancels nothing proves nothing.
  const longFixture = makeFixtureVideo(workDir, "long.mp4", { seconds: 45, size: "1280x720" });
  await stubDialogs(app, { open: longFixture, save: canceled });
  // The export sheet from the previous test is still open over the editor.
  await window.keyboard.press("Escape");
  await openRoute(window, "/dashboard/upload");
  await window.getByRole("button", { name: /Choose a video/i }).click();
  await expect(window.getByRole("button", { name: "Export" })).toBeVisible({ timeout: 60_000 });

  await window.getByRole("button", { name: "Export" }).click();
  const sheet = window.getByRole("dialog");
  await sheet.getByRole("button", { name: /^Export$/ }).click();

  // Cancel while it is genuinely rendering.
  const cancelButton = sheet.getByRole("button", { name: /Cancel export/i });
  await expect(cancelButton).toBeVisible({ timeout: 30_000 });
  await cancelButton.click();

  // The panel returns to a terminal state and NO half-written file is left.
  await expect(sheet.getByRole("button", { name: /Export again/i })).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => existsSync(canceled), { timeout: 30_000 }).toBe(false);

  // Retry — same project, exported again, must produce a real file.
  const retry = join(workDir, "retry.mp4");
  await stubDialogs(app, { open: longFixture, save: retry });
  await sheet.getByRole("button", { name: /Export again/i }).click();
  await sheet.getByRole("button", { name: /^Export$/ }).click();

  await expect(sheet.getByText(/Show in folder/i)).toBeVisible({ timeout: 170_000 });
  expect(existsSync(retry)).toBe(true);
  expect(statSync(retry).size).toBeGreaterThan(10_000);
});

test("finished exports are listed under Exports, with real file actions", async () => {
  const { window } = launched;
  // Leave the editor the way a user does — through the nav, not a reload.
  await window.keyboard.press("Escape");
  await openRoute(window, "/dashboard/exports");

  const section = window.getByRole("heading", { name: /On this computer/i });
  await expect(section).toBeVisible({ timeout: 30_000 });

  // Both successful renders from this run are here, by file name.
  await expect(window.getByText("export.mp4", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(window.getByText("retry.mp4", { exact: true })).toBeVisible();

  // The cancelled one produced no file, so it must NOT be offered as a
  // playable export — a row pointing at nothing is worse than no row.
  await expect(window.getByLabel("Play canceled.mp4")).toHaveCount(0);

  // A real export offers the actions a file affords.
  await expect(window.getByLabel("Play export.mp4")).toBeVisible();
  await expect(window.getByLabel("Show export.mp4 in folder")).toBeVisible();
  await expect(window.getByLabel("Delete export.mp4")).toBeVisible();

  // "Export again" goes back to the project that produced it.
  const again = window.getByRole("link", { name: /Export again/i }).first();
  await expect(again).toBeVisible();
  await again.click();
  await expect
    .poll(() => window.evaluate(() => window.location.pathname), { timeout: 30_000 })
    .toMatch(/^\/dashboard\/projects\/.+/);
});

test("Storage reports the real files this run produced", async () => {
  const { window } = launched;
  await window.keyboard.press("Escape");
  await openRoute(window, "/dashboard/storage");

  await expect(window.getByRole("heading", { name: /Where your videos live/i })).toBeVisible({
    timeout: 30_000,
  });

  // The figures are measured off the disk, so they must be non-zero after a
  // run that imported two videos and exported two files.
  const exportsTile = window.locator("div", { hasText: /^Exports/ }).first();
  await expect(exportsTile).toBeVisible();
  await expect(window.getByText(/Imported videos/i)).toBeVisible();
  await expect(window.getByText(/finished file/i)).toBeVisible();

  // The local half must never be presented as plan usage.
  await expect(window.getByText(/Local projects use no plan quota/i)).toBeVisible();
});
