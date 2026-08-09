/**
 * The gate and the map: what a fresh install shows, what it refuses to show,
 * and whether every screen behind it is actually reachable.
 *
 * These run against the real app — the real protocol handler, the real static
 * bundle, the real Firebase SDK restoring a session from the app origin's own
 * storage. The only thing standing in for a user is the session seed, because
 * the interactive half of sign-in happens in the system browser by design and
 * a test cannot (and should not) drive it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupDir,
  clearSession,
  currentPath,
  firebaseApiKey,
  launchApp,
  openRoute,
  seedSignedInSession,
  type LaunchedApp,
} from "./fixtures";

const API_KEY = firebaseApiKey();

test.describe.configure({ mode: "serial" });
test.skip(
  !API_KEY,
  "the renderer was built without NEXT_PUBLIC_FIREBASE_* — nothing to sign in to"
);

/** Every route the sidebar offers, plus the two that aren't in it. */
const ROUTES = [
  { path: "/dashboard", nav: "Dashboard", heading: /Welcome back/i },
  { path: "/dashboard/projects", nav: "Projects", heading: /Your library/i },
  { path: "/dashboard/upload", nav: "Upload", heading: /Open a recording/i },
  { path: "/dashboard/record", nav: "Record", heading: null },
  { path: "/dashboard/processing", nav: "Processing", heading: null },
  { path: "/dashboard/exports", nav: "Exports", heading: /On this computer/i },
  { path: "/dashboard/billing", nav: "Billing", heading: null },
  { path: "/dashboard/settings", nav: "Settings", heading: /Workspace settings/i },
  { path: "/dashboard/storage", nav: "Storage", heading: /Where your videos live/i },
] as const;

let launched: LaunchedApp;
let profileDir: string;

test.beforeAll(() => {
  profileDir = mkdtempSync(join(tmpdir(), "framevo-auth-profile-"));
});

test.afterAll(async () => {
  await launched?.close();
  cleanupDir(profileDir);
});

// ── 1. A fresh installation opens on sign-in ───────────────────────────────
test("a fresh installation opens the sign-in screen", async () => {
  launched = await launchApp({ userDataDir: profileDir });
  const { window } = launched;

  await expect(window.getByRole("button", { name: /Continue with Google/i })).toBeVisible();
  expect(await currentPath(window)).toBe("/login");

  // The promise the whole auth design rests on.
  await expect(
    window.getByText(/never sees your password|never shows you a Google login page/i)
  ).toBeVisible();
});

// ── 2. Protected routes cannot be opened without authentication ────────────
test("no protected route opens without a session, however it is reached", async () => {
  const { window } = launched;

  for (const route of ROUTES) {
    await openRoute(window, route.path);
    // Whichever route was asked for, the answer is the sign-in screen — and the
    // requested route is remembered so it can be resumed afterwards.
    await expect(window.getByRole("button", { name: /Continue with Google/i })).toBeVisible({
      timeout: 20_000,
    });
    expect(await currentPath(window), `${route.path} leaked past the gate`).toBe("/login");
    // No dashboard chrome may exist behind the gate, not even briefly.
    await expect(window.getByRole("link", { name: "Projects", exact: true })).toHaveCount(0);
  }

  // The editor route is protected the same way.
  await openRoute(window, "/dashboard/projects/some-project-id");
  await expect(window.getByRole("button", { name: /Continue with Google/i })).toBeVisible();
  expect(await currentPath(window)).toBe("/login");
});

// ── 3. Successful sign-in lands on the Dashboard ───────────────────────────
test("a restored session opens the Dashboard", async () => {
  const { window } = launched;
  // Arrive at sign-in with nothing pending, the way a fresh launch does.
  await openRoute(window, "/login");
  await seedSignedInSession(window);

  await expect(window.getByRole("heading", { name: /Welcome back/i })).toBeVisible({
    timeout: 30_000,
  });
  // The gate handed over to the shell.
  await expect(window.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
});

test("signing in resumes the route the user was sent away from", async () => {
  const { window } = launched;
  await clearSession(window);
  // A deep link into a protected route bounces to sign-in…
  await openRoute(window, "/dashboard/storage");
  await expect(window.getByRole("button", { name: /Continue with Google/i })).toBeVisible({
    timeout: 20_000,
  });
  expect(await window.evaluate(() => location.search)).toContain(
    encodeURIComponent("/dashboard/storage")
  );

  // …and signing in puts the user where they were going, not on the Dashboard.
  await seedSignedInSession(window);
  await expect(window.getByRole("heading", { name: /Where your videos live/i })).toBeVisible({
    timeout: 30_000,
  });
  expect(await currentPath(window)).toBe("/dashboard/storage");
});

// ── 6. Every listed navigation link works, with correct selected state ─────
test("every sidebar link navigates, and marks itself current", async () => {
  const { window } = launched;
  await openRoute(window, "/dashboard");
  await expect(window.getByRole("heading", { name: /Welcome back/i })).toBeVisible();

  for (const route of ROUTES) {
    const link = window.getByRole("link", { name: route.nav, exact: true }).first();
    await expect(link, `${route.nav} is missing from the sidebar`).toBeVisible();
    await link.click();

    await expect
      .poll(() => currentPath(window), { timeout: 20_000 })
      .toBe(route.path);

    if (route.heading) {
      await expect(
        window.getByRole("heading", { name: route.heading }).first(),
        `${route.nav} rendered no content`
      ).toBeVisible({ timeout: 20_000 });
    }

    // Never a blank screen: something real is on the page.
    const text = await window.locator("main").first().innerText();
    expect(text.trim().length, `${route.nav} rendered an empty page`).toBeGreaterThan(20);
  }
});

// ── 7. Direct opening of each route, and back/forward ──────────────────────
test("each route opens directly, as a deep link would", async () => {
  const { window } = launched;
  for (const route of ROUTES) {
    await openRoute(window, route.path);
    expect(await currentPath(window), `${route.path} did not open directly`).toBe(route.path);
    if (route.heading) {
      await expect(window.getByRole("heading", { name: route.heading }).first()).toBeVisible({
        timeout: 20_000,
      });
    }
  }
});

test("back and forward move through the history the user made", async () => {
  const { window } = launched;
  await openRoute(window, "/dashboard");
  await window.getByRole("link", { name: "Projects", exact: true }).first().click();
  await expect.poll(() => currentPath(window)).toBe("/dashboard/projects");
  await window.getByRole("link", { name: "Storage", exact: true }).first().click();
  await expect.poll(() => currentPath(window)).toBe("/dashboard/storage");

  await window.goBack();
  await expect.poll(() => currentPath(window), { timeout: 20_000 }).toBe("/dashboard/projects");
  await window.goBack();
  await expect.poll(() => currentPath(window), { timeout: 20_000 }).toBe("/dashboard");
  await window.goForward();
  await expect.poll(() => currentPath(window), { timeout: 20_000 }).toBe("/dashboard/projects");
  await expect(window.getByRole("heading", { name: /Your library/i })).toBeVisible();
});

// ── The dynamic route, which only a packaged/static build can get wrong ────
test("a project URL resolves in the static bundle instead of 404ing", async () => {
  const { window } = launched;
  // No such project exists, so the app must say so — the point is that the
  // ROUTE resolved at all. A broken rewrite gives a blank page or a 404 here.
  await openRoute(window, "/dashboard/projects/nosuchproject");
  expect(await currentPath(window)).toBe("/dashboard/projects/nosuchproject");
  await expect(window.getByText(/Project not found/i)).toBeVisible({ timeout: 30_000 });
  await window.getByRole("button", { name: /Back to projects/i }).click();
  await expect.poll(() => currentPath(window), { timeout: 20_000 }).toBe("/dashboard/projects");
});

// ── 4. Authentication survives restart ─────────────────────────────────────
test("the session survives a full restart, on whichever route was open", async () => {
  await openRoute(launched.window, "/dashboard/storage");
  await expect(launched.window.getByRole("heading", { name: /Where your videos live/i })).toBeVisible();

  await launched.close();
  launched = await launchApp({ userDataDir: profileDir });

  // A relaunch starts at /dashboard, still signed in — no sign-in screen.
  await expect(launched.window.getByRole("heading", { name: /Welcome back/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    launched.window.getByRole("button", { name: /Continue with Google/i })
  ).toHaveCount(0);

  // …and a deep link into a protected route goes straight there.
  await openRoute(launched.window, "/dashboard/exports");
  await expect(launched.window.getByRole("heading", { name: /On this computer/i })).toBeVisible({
    timeout: 20_000,
  });
});

// ── 8 + 5. Expired/revoked auth and sign-out both return to sign-in ────────
test("clearing the stored session returns the app to sign-in", async () => {
  const { window } = launched;
  // This is what an expired or revoked session leaves behind: nothing in
  // persistence. The next launch must not show a workspace.
  await clearSession(window);

  await expect(window.getByRole("button", { name: /Continue with Google/i })).toBeVisible({
    timeout: 30_000,
  });
  expect(await currentPath(window)).toBe("/login");

  // And it stays gone across a restart.
  await launched.close();
  launched = await launchApp({ userDataDir: profileDir });
  await expect(
    launched.window.getByRole("button", { name: /Continue with Google/i })
  ).toBeVisible({ timeout: 30_000 });
});

test("sign-out clears the session and returns to sign-in", async () => {
  const { window } = launched;
  await seedSignedInSession(window);
  await expect(window.getByRole("heading", { name: /Welcome back/i })).toBeVisible({
    timeout: 30_000,
  });

  await window.getByRole("button", { name: "Account" }).click();
  await window.getByRole("button", { name: /Sign out/i }).click();

  await expect(window.getByRole("button", { name: /Continue with Google/i })).toBeVisible({
    timeout: 30_000,
  });
  expect(await currentPath(window)).toBe("/login");

  // The local session is really gone, not just navigated away from.
  const leftover = await window.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("firebase:authUser:")).length
  );
  expect(leftover).toBe(0);
});
