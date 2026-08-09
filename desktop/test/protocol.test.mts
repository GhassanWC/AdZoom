/**
 * The `framevo://` protocol's two security-critical pure functions.
 *
 * `resolveStaticPath` is what stops a crafted URL from reading files outside
 * the app bundle, and `parseRange` is what makes video seeking work — a
 * mis-parsed range either breaks playback or hands back the wrong bytes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sep } from "node:path";

import { buildCsp, parseRange, resolveStaticPath } from "../src/main/protocol-rules.ts";

const ROOT = process.platform === "win32" ? "C:\\app\\resources\\app" : "/opt/app/resources/app";

test("static paths cannot escape the app bundle", () => {
  assert.ok(resolveStaticPath(ROOT, "/index.html")!.startsWith(ROOT));
  assert.ok(resolveStaticPath(ROOT, "/_next/static/chunk.js")!.startsWith(ROOT));

  for (const attack of [
    "/../../../etc/passwd",
    "/..%2f..%2fsecret",
    "/_next/../../outside.txt",
    "/%2e%2e%2f%2e%2e%2fWindows/win.ini",
  ]) {
    const resolved = resolveStaticPath(ROOT, attack);
    assert.ok(
      resolved === null || resolved.startsWith(ROOT + sep),
      `${attack} escaped to ${resolved}`
    );
  }
});

test("query strings and fragments never reach the filesystem", () => {
  const resolved = resolveStaticPath(ROOT, "/index.html?v=2#top");
  assert.ok(resolved!.endsWith("index.html"));
});

test("range requests are parsed the way media players send them", () => {
  const size = 1000;
  assert.deepEqual(parseRange("bytes=0-99", size), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=500-", size), { start: 500, end: 999 });
  // Suffix range — how MP4 players fetch the moov atom at the end of a file.
  assert.deepEqual(parseRange("bytes=-200", size), { start: 800, end: 999 });
  // An end past EOF is clamped rather than refused.
  assert.deepEqual(parseRange("bytes=900-5000", size), { start: 900, end: 999 });

  assert.equal(parseRange(null, size), null, "no header ⇒ full response");
  assert.equal(parseRange("bytes=1000-1100", size), null, "start past EOF is unsatisfiable");
  assert.equal(parseRange("bytes=500-100", size), null, "reversed range");
  assert.equal(parseRange("items=0-10", size), null, "non-byte units");
  assert.equal(parseRange("bytes=abc-def", size), null);
  assert.equal(parseRange("bytes=-0", size), null);
});

test("the CSP allows the app's own API and Firebase, and nothing else", () => {
  const csp = buildCsp("https://framevo.app", false);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src [^;]*https:\/\/framevo\.app/);
  assert.match(csp, /connect-src [^;]*googleapis\.com/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  // Production must NOT permit eval; development does (the dev server needs it).
  assert.equal(/script-src[^;]*'unsafe-eval'/.test(csp), false);
  assert.ok(/script-src[^;]*'unsafe-eval'/.test(buildCsp("https://framevo.app", true)));
  // A localhost dev server is never allowed in a production build.
  assert.equal(/localhost/.test(csp), false);
});

/**
 * A cloud project's video is a Firebase Storage URL, and the preview streams it
 * straight into a `<video>` — which `media-src` governs, NOT `connect-src`.
 *
 * When these two lists disagreed, every locally-imported project played and
 * every cloud project showed "Couldn't load the video preview", with the real
 * reason only visible as a CSP violation in the console. The two directives are
 * now built from one list; this test is what keeps them that way.
 */
test("the CSP lets a CLOUD project's video actually play", () => {
  const storage =
    "https://firebasestorage.googleapis.com/v0/b/adzoomdev.firebasestorage.app/o/users%2Fu%2Fprojects%2Fp%2Foriginal%2Fclip.mp4?alt=media&token=x";

  for (const dev of [false, true]) {
    const csp = buildCsp("https://framevo.app", dev);
    const mediaSrc = /media-src ([^;]*)/.exec(csp)?.[1] ?? "";
    const connectSrc = /connect-src ([^;]*)/.exec(csp)?.[1] ?? "";

    // The host the URL above lives on must be permitted for BOTH the element
    // that plays it and the ranged fetches mediabunny makes against it.
    assert.ok(
      /googleapis\.com/.test(mediaSrc),
      `media-src must allow Firebase Storage (dev=${dev}): ${mediaSrc}`
    );
    assert.ok(/googleapis\.com/.test(connectSrc));
    assert.ok(new URL(storage).host.endsWith("googleapis.com"));

    // Local projects and in-browser renders must keep working.
    assert.ok(/'self'/.test(mediaSrc));
    assert.ok(/blob:/.test(mediaSrc));

    // Still enumerated, not opened up to every https origin.
    assert.equal(/media-src[^;]*\shttps:(\s|;|$)/.test(csp), false);
  }
});

test("media-src and connect-src permit the same remote origins", () => {
  const csp = buildCsp("https://framevo.app", false);
  const media = new Set((/media-src ([^;]*)/.exec(csp)?.[1] ?? "").trim().split(/\s+/));
  const connect = (/connect-src ([^;]*)/.exec(csp)?.[1] ?? "").trim().split(/\s+/);
  // Everything reachable by fetch must also be playable — a video is both.
  // (Websockets are the one exception: nothing streams media over wss.)
  for (const origin of connect) {
    if (origin.startsWith("wss:")) continue;
    assert.ok(media.has(origin), `${origin} is fetchable but not playable`);
  }
});
