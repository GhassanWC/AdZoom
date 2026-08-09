/**
 * Which machine is this, and can it run Framevo Desktop?
 *
 * Pure functions over a normalised input bag so the SAME detection runs on the
 * server (from request headers) and in the browser (from `navigator`) — a
 * download button that disagrees with the endpoint it points at is the classic
 * way to hand a Mac user a .exe.
 *
 * Two things browsers genuinely cannot tell us, handled explicitly rather than
 * guessed at:
 *
 *   • macOS architecture. Chrome and Safari both report "Intel" on Apple
 *     Silicon for Rosetta compatibility. Only the high-entropy client hint
 *     `architecture` is truthful, and it needs an async call and a secure
 *     context. Ship a universal macOS build and the question disappears.
 *
 *   • iPadOS. Since iPadOS 13 an iPad's user agent is indistinguishable from a
 *     Mac's. `maxTouchPoints > 1` on a "Macintosh" is the standard tell, and
 *     without it we would offer a .dmg to a tablet.
 */

import type { ReleaseArch, ReleasePlatform } from "./release";

export type DetectedOS =
  | "windows"
  | "macos"
  | "linux"
  | "chromeos"
  | "ios"
  | "android"
  | "unknown";

export interface PlatformSignals {
  userAgent?: string | null;
  /** `navigator.userAgentData.platform` or the `Sec-CH-UA-Platform` header. */
  uaPlatform?: string | null;
  /** `navigator.userAgentData.mobile` or `Sec-CH-UA-Mobile: ?1`. */
  uaMobile?: boolean | null;
  /** High-entropy `architecture` hint ("x86" | "arm") or `Sec-CH-UA-Arch`. */
  uaArch?: string | null;
  /** High-entropy `bitness` hint ("64" | "32"). */
  uaBitness?: string | null;
  /** `navigator.maxTouchPoints` — the only way to tell an iPad from a Mac. */
  maxTouchPoints?: number | null;
  /** True when this code is already running inside the desktop app. */
  isDesktopApp?: boolean | null;
}

export interface DetectedPlatform {
  /**
   * False only for the server-rendered placeholder. Distinguishes "we haven't
   * looked yet" from "we looked and this is an OS we don't ship for" — the two
   * need different UI, and `os: "unknown"` alone cannot tell them apart.
   */
  resolved: boolean;
  os: DetectedOS;
  arch: ReleaseArch | "unknown";
  /** Phone or tablet — no installer exists, and none should be offered. */
  isMobile: boolean;
  /** Running inside Framevo Desktop right now. */
  isDesktopApp: boolean;
  /** The installer platform to offer, or null when there isn't one. */
  downloadPlatform: ReleasePlatform | null;
  /** "Windows", "macOS", "iPhone" — for button and dialog copy. */
  label: string;
}

const OS_LABEL: Record<DetectedOS, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  chromeos: "ChromeOS",
  ios: "iPhone or iPad",
  android: "Android",
  unknown: "your device",
};

function has(ua: string, needle: string): boolean {
  return ua.includes(needle);
}

/** Strip the quoting the `Sec-CH-UA-*` headers arrive with (`"Windows"`). */
function unquote(v: string | null | undefined): string {
  return (v ?? "").trim().replace(/^"|"$/g, "").toLowerCase();
}

function detectOS(signals: PlatformSignals): DetectedOS {
  const ua = (signals.userAgent ?? "").toLowerCase();
  const hinted = unquote(signals.uaPlatform);

  // Client hints are authoritative when present — they are not spoofed by the
  // compatibility fictions baked into user-agent strings.
  if (hinted) {
    if (hinted === "windows") return "windows";
    if (hinted === "android") return "android";
    if (hinted === "chrome os" || hinted === "chromeos") return "chromeos";
    if (hinted === "macos" || hinted === "mac os x") {
      // An iPad reporting macOS through hints is still a tablet.
      return isIpad(signals, ua) ? "ios" : "macos";
    }
    if (hinted === "linux") return ua.includes("android") ? "android" : "linux";
    if (hinted === "ios") return "ios";
  }

  if (!ua) return "unknown";
  if (has(ua, "android")) return "android";
  if (has(ua, "iphone") || has(ua, "ipod") || has(ua, "ipad")) return "ios";
  if (has(ua, "cros")) return "chromeos";
  if (has(ua, "windows nt") || has(ua, "win64") || has(ua, "win32")) return "windows";
  if (has(ua, "macintosh") || has(ua, "mac os x")) {
    return isIpad(signals, ua) ? "ios" : "macos";
  }
  if (has(ua, "linux") || has(ua, "x11")) return "linux";
  return "unknown";
}

/** A "Macintosh" with a touchscreen is an iPad — Macs have no touch digitiser. */
function isIpad(signals: PlatformSignals, ua: string): boolean {
  if (has(ua, "ipad")) return true;
  const touch = signals.maxTouchPoints ?? 0;
  const looksMac = has(ua, "macintosh") || unquote(signals.uaPlatform) === "macos";
  return looksMac && touch > 1;
}

function detectArch(signals: PlatformSignals, os: DetectedOS): ReleaseArch | "unknown" {
  const hintedArch = unquote(signals.uaArch);
  if (hintedArch) {
    if (hintedArch.includes("arm")) return "arm64";
    if (hintedArch.includes("x86")) {
      // 32-bit x86 cannot run the app at all; report it as unknown rather than
      // claiming an x64 machine, so the caller can fall back on the platform
      // default and the requirements list does the talking.
      return unquote(signals.uaBitness) === "32" ? "unknown" : "x64";
    }
  }

  const ua = (signals.userAgent ?? "").toLowerCase();
  if (has(ua, "arm64") || has(ua, "aarch64")) return "arm64";
  if (os === "windows") {
    if (has(ua, "win64") || has(ua, "x64") || has(ua, "wow64")) return "x64";
    return "unknown";
  }
  // macOS: the user agent is not truthful about Apple Silicon. Deliberately
  // unknown so `assetFor` picks the universal build.
  return "unknown";
}

function detectMobile(signals: PlatformSignals, os: DetectedOS): boolean {
  if (os === "ios" || os === "android") return true;
  if (signals.uaMobile === true) return true;
  const ua = (signals.userAgent ?? "").toLowerCase();
  if (has(ua, "mobile") || has(ua, "tablet")) return true;
  return false;
}

export function detectPlatform(signals: PlatformSignals = {}): DetectedPlatform {
  const os = detectOS(signals);
  const isMobile = detectMobile(signals, os);
  const arch = detectArch(signals, os);
  const downloadPlatform: ReleasePlatform | null =
    isMobile ? null : os === "windows" ? "windows" : os === "macos" ? "macos" : null;

  return {
    resolved: true,
    os,
    arch,
    isMobile,
    isDesktopApp: signals.isDesktopApp === true,
    downloadPlatform,
    label: OS_LABEL[os],
  };
}

/** Read the signals a browser can give us synchronously. */
export function browserSignals(): PlatformSignals {
  if (typeof navigator === "undefined") return {};
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { platform?: string; mobile?: boolean };
    }
  ).userAgentData;
  return {
    userAgent: navigator.userAgent,
    uaPlatform: uaData?.platform ?? null,
    uaMobile: uaData?.mobile ?? null,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
}

/** Read the same signals from request headers (client hints when sent). */
export function headerSignals(headers: {
  get(name: string): string | null;
}): PlatformSignals {
  const mobile = headers.get("sec-ch-ua-mobile");
  return {
    userAgent: headers.get("user-agent"),
    uaPlatform: headers.get("sec-ch-ua-platform"),
    uaMobile: mobile === null ? null : mobile === "?1",
    uaArch: headers.get("sec-ch-ua-arch"),
    uaBitness: headers.get("sec-ch-ua-bitness"),
  };
}
