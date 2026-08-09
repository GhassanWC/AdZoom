/**
 * The PACKAGED app — the artifact users actually install.
 *
 * A dev run proves the code works; it does not prove the packaging is right.
 * The failures this catches are exactly the ones that only exist in a package:
 * a resource that didn't get copied, a path that resolved to node_modules, a
 * native addon that can't be loaded from inside app.asar.
 *
 * Skipped (not failed) when `out/Framevo-win32-x64` hasn't been built yet.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import {
  DESKTOP_ROOT,
  currentPath,
  firebaseApiKey,
  goOffline,
  makeFixtureVideo,
  openRoute,
  seedSignedInSession,
  stubDialogs,
} from "./fixtures";

const PACKAGED_EXE = resolve(DESKTOP_ROOT, "out", "Framevo-win32-x64", "Framevo.exe");
const available = existsSync(PACKAGED_EXE);

test.describe.configure({ mode: "serial" });
test.skip(!available, "run `npm run package:win` first");

let app: ElectronApplication;
let window: Page;
let workDir: string;
let profileDir: string;

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "framevo-packaged-"));
  profileDir = mkdtempSync(join(tmpdir(), "framevo-packaged-profile-"));
  app = await electron.launch({
    executablePath: PACKAGED_EXE,
    args: [`--user-data-dir=${profileDir}`],
    env: { ...process.env, FRAMEVO_UPDATE_FEED_URL: "", FRAMEVO_SENTRY_DSN: "" },
  });
  app.process().stdout?.on("data", (c: Buffer) => process.stdout.write(`[packaged] ${c}`));
  app.process().stderr?.on("data", (c: Buffer) => process.stdout.write(`[packaged:err] ${c}`));
  // Same isolation as the dev suite: the installed app must be provable without
  // a live Firebase project, and a seeded session only survives while the app
  // cannot ask Google to vouch for it (online, that refusal is the feature that
  // signs a revoked account out).
  await goOffline(app);
  window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  rmSync(workDir, { recursive: true, force: true });
  rmSync(profileDir, { recursive: true, force: true });
});

test("the installed app boots its own bundled renderer, on the sign-in screen", async () => {
  // Served by framevo://app from resources/app — not a dev server.
  expect(window.url()).toMatch(/^framevo:\/\/app\//);
  const api = await window.evaluate(() => typeof window.framevo);
  expect(api).toBe("object");

  // A newly installed app has no session, so this is what a user sees first.
  await expect(window.getByRole("button", { name: /Continue with Google/i })).toBeVisible({
    timeout: 30_000,
  });
  expect(await currentPath(window)).toBe("/login");
});

test("a packaged deep link into a protected route still lands on sign-in", async () => {
  await openRoute(window, "/dashboard/projects/anything");
  await expect(window.getByRole("button", { name: /Continue with Google/i })).toBeVisible({
    timeout: 30_000,
  });
  expect(await currentPath(window)).toBe("/login");
});

test("every dashboard route resolves inside app.asar, not just in dev", async () => {
  test.skip(!firebaseApiKey(), "no Firebase config baked into this build");
  await seedSignedInSession(window);

  // This is the assertion that only a PACKAGED run can make: each route has to
  // resolve to a real file inside resources/app, and the dynamic project route
  // has to fold onto its placeholder artifact. A missing export or a broken
  // rewrite shows up here and nowhere else.
  for (const path of [
    "/dashboard",
    "/dashboard/projects",
    "/dashboard/upload",
    "/dashboard/record",
    "/dashboard/processing",
    "/dashboard/exports",
    "/dashboard/billing",
    "/dashboard/settings",
    "/dashboard/storage",
  ]) {
    await openRoute(window, path);
    expect(await currentPath(window), `${path} did not resolve`).toBe(path);
    // The workspace shell rendered — not a protocol 404, not a blank document,
    // not Next's own not-found page.
    await expect(
      window.getByRole("link", { name: "Projects", exact: true }).first(),
      `${path} rendered no app shell`
    ).toBeVisible({ timeout: 20_000 });
    const body = await window.locator("body").innerText();
    expect(body.trim().length, `${path} rendered nothing`).toBeGreaterThan(20);
    expect(body, `${path} 404ed`).not.toMatch(/This page could not be found|Cannot GET/i);
  }

  // The dynamic route is the one a static export can genuinely fail to serve.
  // No such project exists, so the app's OWN "not found" is the proof: the
  // placeholder artifact was served, the page ran, and it read the real id out
  // of the URL. A broken rewrite gives a blank window or a protocol 404 here.
  await openRoute(window, "/dashboard/projects/packaged-route-check");
  expect(await currentPath(window)).toBe("/dashboard/projects/packaged-route-check");
  await expect(window.getByText(/Project not found/i)).toBeVisible({ timeout: 30_000 });
});

test("it finds its bundled FFmpeg and detects encoders", async () => {
  const encoders = await window.evaluate(() => window.framevo!.export.encoders());
  expect(Array.isArray(encoders)).toBe(true);
  // libx264 ships in every build, so it must be present AND usable — if the
  // bundled binary were missing this would be `available: false`.
  const software = encoders.find((e) => e.id === "libx264");
  expect(software?.available).toBe(true);
});

test("it imports, edits and exports a real video end to end", async () => {
  test.skip(!firebaseApiKey(), "no Firebase config baked into this build");
  const fixture = makeFixtureVideo(workDir, "packaged.mp4");
  const output = join(workDir, "packaged-export.mp4");
  await stubDialogs(app, { open: fixture, save: output });

  await openRoute(window, "/dashboard/upload");
  await window.getByRole("button", { name: /Choose a video/i }).click();
  await expect(window.getByRole("button", { name: "Export" })).toBeVisible({ timeout: 60_000 });

  // One real edit, so the export exercises the compositor rather than a copy.
  await window.getByTitle("Insert a new edit at the playhead").click();
  await window
    .getByRole("menu", { name: "Add an edit" })
    .getByText("Zoom", { exact: true })
    .click();

  await window.getByRole("button", { name: "Export" }).click();
  const sheet = window.getByRole("dialog");
  await sheet.getByRole("button", { name: /^Export$/ }).click();

  // This is the assertion that proves the packaged layout: the render CLI ran
  // from resources/, loaded @napi-rs/canvas from resources/node_modules, and
  // drove the bundled FFmpeg.
  await expect(sheet.getByText(/Show in folder/i)).toBeVisible({ timeout: 180_000 });
  expect(existsSync(output)).toBe(true);
  expect(statSync(output).size).toBeGreaterThan(10_000);
});
