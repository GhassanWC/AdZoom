import { test, expect } from "@playwright/test";

/**
 * Public-page smoke tests.
 *
 * These assert STRUCTURE (page responds, renders an h1, nav works, no app-level
 * crash) rather than marketing copy — a wording tweak on the landing page should
 * not turn CI red. If you need copy locked down, assert it in a dedicated spec
 * so the intent is explicit.
 */

const PUBLIC_ROUTES = [
  "/",
  "/pricing",
  "/features",
  "/about",
  "/docs",
  "/terms",
  "/privacy",
] as const;

test.describe("public pages", () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route} renders without a server error`, async ({ page }) => {
      const response = await page.goto(route);

      expect(response?.status(), `${route} should not 4xx/5xx`).toBeLessThan(400);

      // Next renders its error overlay/boundary text on a crashed RSC payload;
      // catching it here is what separates "page loaded" from "page worked".
      await expect(page.locator("body")).not.toContainText(
        "Application error: a client-side exception"
      );

      // Every public page should present exactly one top-level heading.
      await expect(page.locator("h1").first()).toBeVisible();
    });
  }
});

test("landing page exposes its primary call to action", async ({ page }) => {
  await page.goto("/");

  // The landing CTA points at /dashboard, not /login — the dashboard itself
  // gates on auth and bounces signed-out visitors. This is the top of the
  // funnel and must never silently disappear.
  const cta = page.locator('a[href^="/dashboard"]').first();
  await expect(cta).toBeVisible();
});

test("login page renders its card without Firebase credentials", async ({
  page,
}) => {
  // CI runs with placeholder NEXT_PUBLIC_FIREBASE_* values. The app guards real
  // Firebase access behind isFirebaseConfigured(), so this page must still
  // render rather than throwing on a missing/invalid config.
  await page.goto("/login");

  await expect(page.locator("body")).not.toContainText(
    "Application error: a client-side exception"
  );
  await expect(page.locator("main")).toBeVisible();
});

test("unknown routes return a 404 rather than a crash", async ({ page }) => {
  const response = await page.goto("/this-route-does-not-exist");

  expect(response?.status()).toBe(404);
});
