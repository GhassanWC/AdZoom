/**
 * The desktop release manifest — what the website knows about the installers.
 *
 * ONE typed record, imported by the download page, the download endpoints, the
 * desktop gate and the release tooling. `scripts/desktop-release.mjs` rewrites
 * `current-release.ts` from the artifacts it just built, so the sizes and
 * checksums on the website are never hand-copied numbers that drift from the
 * file a user actually receives.
 *
 * ── The `status` gate ──────────────────────────────────────────────────────
 * A release is `draft` until its packaged app has passed end-to-end testing.
 * While it is draft:
 *
 *   • `/api/desktop/download` refuses to redirect (503 + a plain explanation),
 *   • the download page shows a "not yet available" state instead of a button,
 *   • and the desktop gate does NOT block web editing.
 *
 * That last one is the important coupling: a gate that pushes people to an
 * installer that does not exist yet would strand every user on the website with
 * no way forward. Publishing is therefore a single edit — `status: "published"`
 * — that turns the download on and the gate on together, and reverting it rolls
 * both back.
 */

export type ReleaseStatus = "draft" | "published";
export type ReleaseChannel = "stable" | "beta";

/** The platforms we ship an installer for. */
export type ReleasePlatform = "windows" | "macos";

/**
 * `universal` is the recommended macOS shape: browsers cannot reliably report
 * Apple Silicon vs Intel (Chrome and Safari both say "Intel" for Rosetta
 * compatibility), so a single binary removes a guess we would otherwise get
 * wrong for a slice of users.
 */
export type ReleaseArch = "x64" | "arm64" | "universal";

export interface ReleaseAsset {
  platform: ReleasePlatform;
  arch: ReleaseArch;
  /** Absolute https URL of the installer. */
  url: string;
  /** File name as downloaded — shown on the page and used for the redirect. */
  filename: string;
  /** Exact size in bytes, from the built artifact. */
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the artifact, for users who verify downloads. */
  sha256: string;
  /** Human-readable floor, e.g. "Windows 10 (64-bit) or later". */
  minimumOs: string;
}

export interface DesktopRelease {
  version: string;
  channel: ReleaseChannel;
  status: ReleaseStatus;
  /** ISO-8601 date the build was cut. */
  releasedAt: string;
  /** Release notes, one bullet per line, newest release only. */
  notes: string[];
  assets: ReleaseAsset[];
  /**
   * Squirrel feed base the packaged app checks for updates. Windows takes a
   * directory URL; macOS takes the same base and appends `/darwin/<arch>/…`.
   */
  updateFeedUrl?: string;
}

export const SUPPORTED_PLATFORMS: ReleasePlatform[] = ["windows", "macos"];

export const PLATFORM_LABEL: Record<ReleasePlatform, string> = {
  windows: "Windows",
  macos: "macOS",
};

/**
 * True when this release may be handed to the public.
 *
 * Three conditions, not one. `status` is the human decision, but a release that
 * says "published" while carrying no assets — or assets whose URLs are still
 * the generator's placeholders — would serve a 404 to every visitor. Checking
 * the data as well as the flag means a half-finished release fails closed.
 */
export function isPublished(release: DesktopRelease): boolean {
  if (release.status !== "published") return false;
  if (release.assets.length === 0) return false;
  return release.assets.every((a) => a.url.startsWith("https://") && a.sha256.length === 64);
}

/**
 * Pick the installer for a detected OS + architecture.
 *
 * Fallbacks are deliberate, not incidental:
 *   • an exact arch match always wins;
 *   • `universal` satisfies any arch on the same platform;
 *   • Windows on ARM falls back to the x64 build, which Windows 11 runs under
 *     emulation — a working download beats a correct-looking dead end;
 *   • an unknown arch takes the platform's default (x64 on Windows, universal
 *     or arm64 on macOS), because "unknown" is overwhelmingly a stock machine.
 *
 * Returns null when the platform has no asset at all (Linux, mobile, or a
 * release that only shipped one side).
 */
export function assetFor(
  release: DesktopRelease,
  platform: ReleasePlatform | null | undefined,
  arch?: ReleaseArch | "unknown" | null
): ReleaseAsset | null {
  if (!platform) return null;
  const candidates = release.assets.filter((a) => a.platform === platform);
  if (candidates.length === 0) return null;

  const exact = arch && arch !== "unknown" ? candidates.find((a) => a.arch === arch) : undefined;
  if (exact) return exact;

  const universal = candidates.find((a) => a.arch === "universal");
  if (universal) return universal;

  if (platform === "windows") {
    // Includes the ARM-on-Windows fallback: no arm64 asset ⇒ hand over x64.
    return candidates.find((a) => a.arch === "x64") ?? candidates[0];
  }
  // macOS: Apple Silicon is the common case when we cannot tell.
  return candidates.find((a) => a.arch === "arm64") ?? candidates[0];
}

/** Every asset for a platform, newest-arch-first, for the "other options" list. */
export function assetsFor(
  release: DesktopRelease,
  platform: ReleasePlatform
): ReleaseAsset[] {
  const order: ReleaseArch[] = ["universal", "arm64", "x64"];
  return release.assets
    .filter((a) => a.platform === platform)
    .sort((a, b) => order.indexOf(a.arch) - order.indexOf(b.arch));
}

/** "148.3 MB" — sizes on a download page should read like a file manager's. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / 1_000_000;
  if (mb >= 1000) return `${(mb / 1000).toFixed(2)} GB`;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}

/** `x64` → "Intel / AMD 64-bit", for the secondary download list. */
export function archLabel(arch: ReleaseArch): string {
  switch (arch) {
    case "arm64":
      return "Apple Silicon / ARM64";
    case "universal":
      return "Universal (Apple Silicon + Intel)";
    case "x64":
    default:
      return "Intel / AMD 64-bit";
  }
}

/**
 * A semver-ish comparison good enough for release ordering (`1.2.10` > `1.2.9`).
 * Pre-release suffixes sort BELOW the same release without one, so `1.0.0-beta.1`
 * never looks newer than `1.0.0`.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return {
      parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: pre ?? "",
    };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i++) {
    const d = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1; // a release beats its own pre-release
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}
