/**
 * Desktop distribution — the rules that decide what a visitor is offered.
 *
 * Every one of these is a pure function on purpose. "Which installer does this
 * browser get", "is this route the app's job", and "is this framevo:// link
 * safe to follow" are all decisions that must be identical on the server, in
 * the browser and inside the Electron main process — so they live in modules
 * that can be asserted on directly rather than in three components that agree
 * by coincidence.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectPlatform,
  headerSignals,
  type PlatformSignals,
} from "../src/lib/desktop/platform-detect.ts";
import {
  assetFor,
  assetsFor,
  compareVersions,
  formatBytes,
  gateReady,
  isPublished,
  SUPPORTED_PLATFORMS,
  type DesktopRelease,
  type ReleaseAsset,
} from "../src/lib/desktop/release.ts";
import {
  buildDeepLink,
  parseDeepLink,
  resolveDeepLinkRoute,
  DEEP_LINK_FALLBACK_ROUTE,
} from "../src/lib/desktop/deep-link.ts";
import { evaluateGate, isGatedRoute } from "../src/lib/desktop/gate.ts";
import { CURRENT_RELEASE } from "../src/lib/desktop/current-release.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

const UA = {
  win10Chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  winArm:
    "Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  // Since iPadOS 13 an iPad is indistinguishable from a Mac by UA alone.
  ipad:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  chromeos:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

function asset(over: Partial<ReleaseAsset> = {}): ReleaseAsset {
  return {
    platform: "windows",
    arch: "x64",
    url: "https://cdn.example.com/desktop/releases/1.0.0/Framevo-Setup.exe",
    filename: "Framevo-Setup.exe",
    sizeBytes: 148_300_000,
    sha256: "a".repeat(64),
    minimumOs: "Windows 10 (64-bit) or later",
    ...over,
  };
}

function release(over: Partial<DesktopRelease> = {}): DesktopRelease {
  return {
    version: "1.0.0",
    channel: "stable",
    status: "published",
    releasedAt: "2026-07-30",
    notes: ["First release."],
    assets: [asset()],
    ...over,
  };
}

// ── 1. Which machine is this? ──────────────────────────────────────────────

test("a Windows browser is offered the Windows installer", () => {
  const p = detectPlatform({ userAgent: UA.win10Chrome });
  assert.equal(p.os, "windows");
  assert.equal(p.arch, "x64");
  assert.equal(p.isMobile, false);
  assert.equal(p.downloadPlatform, "windows");
});

test("a Mac browser is offered the macOS installer", () => {
  const p = detectPlatform({ userAgent: UA.macSafari });
  assert.equal(p.os, "macos");
  assert.equal(p.downloadPlatform, "macos");
  // Safari claims "Intel" on Apple Silicon, so the honest answer is unknown —
  // which is what makes the universal build the right thing to ship.
  assert.equal(p.arch, "unknown");
});

test("an iPad is a tablet, not a Mac — the touch digitiser is the only tell", () => {
  const asMac = detectPlatform({ userAgent: UA.ipad, maxTouchPoints: 0 });
  assert.equal(asMac.os, "macos", "a real Mac reports no touch points");

  const asTablet = detectPlatform({ userAgent: UA.ipad, maxTouchPoints: 5 });
  assert.equal(asTablet.os, "ios");
  assert.equal(asTablet.isMobile, true);
  assert.equal(asTablet.downloadPlatform, null, "never offer a tablet a .dmg");
});

test("phones get no installer at all", () => {
  for (const ua of [UA.iphone, UA.android]) {
    const p = detectPlatform({ userAgent: ua });
    assert.equal(p.isMobile, true);
    assert.equal(p.downloadPlatform, null);
  }
});

test("Linux and ChromeOS are desktops we don't ship for — named, not guessed at", () => {
  assert.equal(detectPlatform({ userAgent: UA.linux }).os, "linux");
  assert.equal(detectPlatform({ userAgent: UA.chromeos }).os, "chromeos");
  for (const ua of [UA.linux, UA.chromeos]) {
    const p = detectPlatform({ userAgent: ua });
    assert.equal(p.isMobile, false);
    assert.equal(p.downloadPlatform, null, "no installer, and none implied");
  }
});

test("client hints win over the user agent, because they don't lie for compatibility", () => {
  // A UA claiming Windows with hints saying macOS: trust the hints.
  const p = detectPlatform({
    userAgent: UA.win10Chrome,
    uaPlatform: '"macOS"',
    uaArch: '"arm"',
  });
  assert.equal(p.os, "macos");
  assert.equal(p.arch, "arm64");
});

test("32-bit x86 reports unknown rather than claiming a 64-bit machine", () => {
  const p = detectPlatform({
    userAgent: UA.win10Chrome,
    uaArch: '"x86"',
    uaBitness: '"32"',
  });
  assert.equal(p.arch, "unknown");
});

test("Windows on ARM is detected, and still gets a working download", () => {
  const p = detectPlatform({ userAgent: UA.winArm });
  assert.equal(p.os, "windows");
  assert.equal(p.arch, "arm64");
  // No arm64 asset ⇒ the x64 build, which Windows 11 runs under emulation. A
  // correct-looking dead end would be worse than a working download.
  const picked = assetFor(release(), p.downloadPlatform, p.arch);
  assert.equal(picked?.arch, "x64");
});

test("no signals at all is 'unknown', never a guess", () => {
  const p = detectPlatform({});
  assert.equal(p.os, "unknown");
  assert.equal(p.downloadPlatform, null);
});

test("header and browser signals describe the same machine", () => {
  const headers = new Map([
    ["user-agent", UA.win10Chrome],
    ["sec-ch-ua-platform", '"Windows"'],
    ["sec-ch-ua-mobile", "?0"],
    ["sec-ch-ua-arch", '"x86"'],
    ["sec-ch-ua-bitness", '"64"'],
  ]);
  const signals: PlatformSignals = headerSignals({
    get: (n) => headers.get(n) ?? null,
  });
  const fromHeaders = detectPlatform(signals);
  const fromBrowser = detectPlatform({ userAgent: UA.win10Chrome, maxTouchPoints: 0 });
  assert.equal(fromHeaders.os, fromBrowser.os);
  assert.equal(fromHeaders.downloadPlatform, fromBrowser.downloadPlatform);
});

// ── 2. Which file do they get? ─────────────────────────────────────────────

test("an exact architecture match always wins", () => {
  const r = release({
    assets: [asset({ arch: "x64" }), asset({ arch: "arm64", filename: "Framevo-Setup-arm64.exe" })],
  });
  assert.equal(assetFor(r, "windows", "arm64")?.filename, "Framevo-Setup-arm64.exe");
  assert.equal(assetFor(r, "windows", "x64")?.filename, "Framevo-Setup.exe");
});

test("a universal macOS build satisfies any Mac", () => {
  const r = release({
    assets: [asset({ platform: "macos", arch: "universal", filename: "Framevo.dmg" })],
  });
  for (const arch of ["arm64", "x64", "unknown"] as const) {
    assert.equal(assetFor(r, "macos", arch)?.filename, "Framevo.dmg");
  }
});

test("no asset for the platform returns null instead of the wrong file", () => {
  const winOnly = release();
  assert.equal(assetFor(winOnly, "macos", "arm64"), null);
  assert.equal(assetFor(winOnly, null, "x64"), null, "a phone has no platform");
});

test("a release fails closed unless the flag AND the data are both ready", () => {
  assert.equal(isPublished(release({ status: "draft" })), false);
  assert.equal(
    isPublished(release({ assets: [] })),
    false,
    "published with nothing to serve is not published"
  );
  assert.equal(
    isPublished(release({ assets: [asset({ url: "REPLACE_ME/1.0.0/Framevo-Setup.exe" })] })),
    false,
    "the generator's placeholder URL must not count as a real download"
  );
  assert.equal(
    isPublished(release({ assets: [asset({ url: "http://cdn.example.com/x.exe" })] })),
    false,
    "an installer served over plain http is not shippable"
  );
  assert.equal(
    isPublished(release({ assets: [asset({ sha256: "short" })] })),
    false,
    "a truncated digest means the manifest wasn't generated from real artifacts"
  );
  assert.equal(isPublished(release()), true);
});

// ── gateReady: downloads may ship one platform at a time; the GATE may not ──

test("the gate is not ready until EVERY supported platform ships", () => {
  // Windows-only release: downloads live, gate off — macOS users must keep
  // web editing rather than being blocked with nothing to install.
  assert.equal(gateReady(release()), false);
  // Draft never arms the gate, however many assets it lists.
  assert.equal(
    gateReady(
      release({
        status: "draft",
        assets: [asset(), asset({ platform: "macos", arch: "universal", filename: "Framevo.dmg" })],
      })
    ),
    false
  );
  // Both platforms shipped and published — now the gate may engage.
  assert.equal(
    gateReady(
      release({
        assets: [asset(), asset({ platform: "macos", arch: "universal", filename: "Framevo.dmg" })],
      })
    ),
    true
  );
});

test("the live manifest is coherent — and never arms the gate one-sided", () => {
  // The old form of this test pinned CURRENT_RELEASE to draft outright. The
  // Windows build has since been packaged, boot-tested and uploaded, so the
  // interlocks this asserts are the surviving ones:
  //   • if the manifest claims "published" its data must actually validate
  //     (real https URLs, full digests) — a half-generated publish fails closed;
  //   • the desktop-first gate must never arm while any supported platform has
  //     no installer, whatever the status flag says.
  if (CURRENT_RELEASE.status === "published") {
    assert.equal(
      isPublished(CURRENT_RELEASE),
      true,
      "CURRENT_RELEASE claims published but its assets don't validate — regenerate it"
    );
  }
  const platforms = new Set(CURRENT_RELEASE.assets.map((a) => a.platform));
  const allShipped = SUPPORTED_PLATFORMS.every((p) => platforms.has(p));
  assert.equal(
    gateReady(CURRENT_RELEASE),
    isPublished(CURRENT_RELEASE) && allShipped,
    "the gate must arm exactly when published AND every supported platform ships"
  );
});

test("sizes read like a file manager's", () => {
  assert.equal(formatBytes(148_300_000), "148 MB");
  assert.equal(formatBytes(9_400_000), "9.4 MB");
  assert.equal(formatBytes(2_100_000_000), "2.10 GB");
  assert.equal(formatBytes(0), "—");
});

test("versions order the way humans expect, pre-releases below their release", () => {
  assert.ok(compareVersions("1.2.10", "1.2.9") > 0, "10 > 9, not lexicographic");
  assert.ok(compareVersions("1.0.0", "1.0.0-beta.1") > 0);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  assert.ok(compareVersions("v1.1.0", "1.0.9") > 0, "a leading v is tolerated");
});

test("secondary downloads list the richest build first", () => {
  const r = release({
    assets: [
      asset({ platform: "macos", arch: "x64" }),
      asset({ platform: "macos", arch: "universal" }),
      asset({ platform: "macos", arch: "arm64" }),
    ],
  });
  assert.deepEqual(
    assetsFor(r, "macos").map((a) => a.arch),
    ["universal", "arm64", "x64"]
  );
});

// ── 3. Deep links ──────────────────────────────────────────────────────────

test("a built link round-trips through the parser", () => {
  const link = buildDeepLink({ kind: "project", projectId: "abc123_XY-z" });
  assert.equal(link, "framevo://open/dashboard/projects/abc123_XY-z");
  const parsed = parseDeepLink(link!);
  assert.deepEqual(parsed?.target, { kind: "project", projectId: "abc123_XY-z" });
  assert.equal(parsed?.route, "/dashboard/projects/abc123_XY-z");
});

test("every static destination survives the round trip", () => {
  for (const kind of ["home", "projects", "exports", "settings", "billing"] as const) {
    const link = buildDeepLink({ kind });
    assert.ok(link, `${kind} should be expressible`);
    assert.equal(parseDeepLink(link!)?.target.kind, kind);
  }
});

test("a link the app can't express is refused at build time, not emitted and rejected later", () => {
  assert.equal(buildDeepLink({ kind: "project", projectId: "../../etc/passwd" }), null);
  assert.equal(buildDeepLink({ kind: "project", projectId: "" }), null);
});

test("hostile links resolve to the dashboard rather than wherever they asked for", () => {
  const hostile = [
    "framevo://open/../../secrets",
    "framevo://open/dashboard/projects/../../admin",
    "framevo://open/admin",
    "framevo://open/dashboard/projects/abc/extra",
    "framevo://evil.example.com/dashboard",
    "https://example.com/dashboard",
    "framevo://open/dashboard/projects/" + "x".repeat(200),
    "javascript:alert(1)",
    "not a url at all",
  ];
  for (const raw of hostile) {
    assert.equal(parseDeepLink(raw), null, `${raw} should not parse`);
    assert.equal(
      resolveDeepLinkRoute(raw),
      DEEP_LINK_FALLBACK_ROUTE,
      `${raw} must fall back to the dashboard`
    );
  }
});

test("query strings and fragments are dropped — no destination here takes one", () => {
  const parsed = parseDeepLink("framevo://open/dashboard/exports?next=//evil.com#frag");
  assert.equal(parsed?.route, "/dashboard/exports");
});

test("the app's own internal origin still round-trips", () => {
  // main loads framevo://app/… itself; a link it produced must not be rejected.
  assert.equal(resolveDeepLinkRoute("framevo://app/dashboard/exports"), "/dashboard/exports");
});

test("a trailing slash is the same destination", () => {
  assert.equal(resolveDeepLinkRoute("framevo://open/dashboard/exports/"), "/dashboard/exports");
});

// ── 4. The desktop gate ────────────────────────────────────────────────────

test("editing surfaces are the app's job", () => {
  for (const route of [
    "/dashboard/upload",
    "/dashboard/record",
    "/dashboard/projects/abc123",
    "/dashboard/processing",
  ]) {
    assert.equal(isGatedRoute(route), true, `${route} should be gated`);
  }
});

test("account, billing, history and exports stay on the web — that is the promise", () => {
  for (const route of [
    "/dashboard",
    "/dashboard/projects",
    "/dashboard/exports",
    "/dashboard/billing",
    "/dashboard/settings",
    "/dashboard/diagnostics",
    "/dashboard/presets",
    "/pricing",
    "/login",
    "/download",
  ]) {
    assert.equal(isGatedRoute(route), false, `${route} must stay available`);
  }
});

test("the project LIST is open even though the EDITOR under it is not", () => {
  assert.equal(isGatedRoute("/dashboard/projects"), false);
  assert.equal(isGatedRoute("/dashboard/projects/"), false);
  assert.equal(isGatedRoute("/dashboard/projects/xyz"), true);
});

const GATE_BASE = { isDesktopApp: false, isMobile: false, released: true };

test("with no published installer the gate cannot block — nobody gets stranded", () => {
  const decision = evaluateGate("/dashboard/upload", { ...GATE_BASE, released: false });
  assert.equal(decision.kind, "allow");
});

test("the gate never fires inside the desktop app itself", () => {
  const decision = evaluateGate("/dashboard/projects/abc", { ...GATE_BASE, isDesktopApp: true });
  assert.equal(decision.kind, "allow");
});

test("a phone is told editing needs a computer, not handed an installer", () => {
  const decision = evaluateGate("/dashboard/upload", { ...GATE_BASE, isMobile: true });
  assert.equal(decision.kind, "mobile");
  assert.equal(decision.kind === "mobile" && decision.action, "upload");
});

test("a desktop browser on an editing route is blocked, and told what it was doing", () => {
  assert.equal(evaluateGate("/dashboard/upload", GATE_BASE).kind, "block");
  const record = evaluateGate("/dashboard/record", GATE_BASE);
  assert.equal(record.kind === "block" && record.action, "record");
  const edit = evaluateGate("/dashboard/projects/abc", GATE_BASE);
  assert.equal(edit.kind === "block" && edit.action, "edit");
});

test("the escape hatch opens everything back up", () => {
  const decision = evaluateGate("/dashboard/upload", { ...GATE_BASE, disabled: true });
  assert.equal(decision.kind, "allow");
});
