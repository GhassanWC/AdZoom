/**
 * The Content-Security-Policy the renderer is ACTUALLY served.
 *
 * A cloud project's video is a Firebase Storage URL played by a `<video>`
 * element, which `media-src` governs. When that directive was
 * `'self' blob: data:`, every locally-imported project played and every cloud
 * project showed "Couldn't load the video preview" — the real reason visible
 * only as a console CSP violation.
 *
 * `buildCsp` is unit-tested, but a string is not a policy: this asserts what
 * Chromium enforces on the real document, by asking the browser itself.
 * `securitypolicyviolation` fires BEFORE any network request, so this needs
 * neither a signed-in session nor connectivity.
 */
import { expect, test } from "@playwright/test";
import { cleanupDir, launchApp, type LaunchedApp } from "./fixtures";

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
});

test.afterAll(async () => {
  await launched?.close();
  if (launched?.userDataDir) cleanupDir(launched.userDataDir);
});

/**
 * Ask the page whether loading `url` as media trips the policy.
 * Resolves "blocked" on a violation, "allowed" if the policy permits it.
 */
async function mediaAllowed(url: string): Promise<"allowed" | "blocked"> {
  return launched.window.evaluate(async (src) => {
    return new Promise<"allowed" | "blocked">((resolve) => {
      const onViolation = (event: SecurityPolicyViolationEvent) => {
        if (event.violatedDirective.startsWith("media-src")) {
          cleanup();
          resolve("blocked");
        }
      };
      const video = document.createElement("video");
      const cleanup = () => {
        document.removeEventListener("securitypolicyviolation", onViolation);
        video.remove();
      };
      document.addEventListener("securitypolicyviolation", onViolation);
      video.src = src;
      video.preload = "metadata";
      document.body.appendChild(video);
      // No violation within a tick ⇒ the policy let it through (the request
      // may then fail offline, which is not what is being tested).
      setTimeout(() => {
        cleanup();
        resolve("allowed");
      }, 1200);
    });
  }, url);
}

test("a Firebase Storage video is permitted by media-src", async () => {
  // The exact shape of a cloud project's `originalVideoUrl`.
  const verdict = await mediaAllowed(
    "https://firebasestorage.googleapis.com/v0/b/adzoomdev.firebasestorage.app/o/" +
      "users%2Fu%2Fprojects%2Fp%2Foriginal%2Fclip.mp4?alt=media&token=00000000-0000-0000-0000-000000000000"
  );
  expect(verdict, "cloud project videos must not be blocked by CSP").toBe("allowed");
});

test("a local project's media protocol URL is still permitted", async () => {
  expect(await mediaAllowed("framevo://app/__media/abcdef123456")).toBe("allowed");
});

test("an unrelated origin is still refused", async () => {
  // The policy enumerates origins rather than allowing every https host, so a
  // widened media-src has not become an open door.
  expect(await mediaAllowed("https://example.com/video.mp4")).toBe("blocked");
});
