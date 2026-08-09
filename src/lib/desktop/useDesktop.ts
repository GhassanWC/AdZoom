"use client";

/**
 * Client-side desktop plumbing: what machine is this, is there an installer for
 * it, and can we hand this user off to an app they already have?
 *
 * The release manifest is a compile-time import, not a fetch — the download
 * button must be correct on first paint, and a spinner where a version number
 * belongs is exactly the kind of detail that makes a download page feel
 * provisional.
 */

import * as React from "react";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import { EVENTS } from "@/lib/analytics/events";
// `window.framevo` is touched in exactly ONE file by design (see
// platform/types.ts) — ask the bridge rather than sniffing the global here.
import { isDesktopRuntime } from "@/lib/platform/desktop/bridge";
import { CURRENT_RELEASE } from "./current-release";
import { assetFor, isPublished, type ReleaseAsset } from "./release";
import {
  browserSignals,
  detectPlatform,
  type DetectedPlatform,
} from "./platform-detect";
import { buildDeepLink, type DeepLinkTarget } from "./deep-link";

/** What SSR renders: no navigator, so nothing is claimed about the machine. */
const SSR_PLATFORM: DetectedPlatform = {
  resolved: false,
  os: "unknown",
  arch: "unknown",
  isMobile: false,
  isDesktopApp: false,
  downloadPlatform: null,
  label: "your device",
};

/**
 * The machine never changes while the page is open, so detection runs once and
 * the result is cached at module scope. `useSyncExternalStore` requires a
 * snapshot with a STABLE identity — recomputing per call would loop forever.
 */
let cachedPlatform: DetectedPlatform | null = null;

function clientSnapshot(): DetectedPlatform {
  if (!cachedPlatform) {
    cachedPlatform = detectPlatform({
      ...browserSignals(),
      isDesktopApp: isDesktopRuntime(),
    });
  }
  return cachedPlatform;
}

/** Nothing to subscribe to — the OS does not change mid-session. */
const subscribeToNothing = () => () => {};

/**
 * The visitor's platform.
 *
 * `useSyncExternalStore` rather than state-plus-effect: the server has no
 * `navigator`, so SSR renders the neutral snapshot and the client renders the
 * real one, with React reconciling the difference instead of us triggering a
 * second render by hand. Detecting during render would either claim the wrong
 * OS on the server or hydrate into a mismatch.
 */
export function useDetectedPlatform(): DetectedPlatform {
  return React.useSyncExternalStore(
    subscribeToNothing,
    clientSnapshot,
    () => SSR_PLATFORM
  );
}

export interface DesktopAvailability {
  /** True once an installer has been published and verified. */
  available: boolean;
  version: string;
  /** The best asset for THIS visitor, or null (mobile, Linux, unpublished). */
  asset: ReleaseAsset | null;
  /** Stable download URL to link to — resolves the platform server-side too. */
  downloadHref: string;
}

export function useDesktopAvailability(
  platform: DetectedPlatform
): DesktopAvailability {
  return React.useMemo(() => {
    const available = isPublished(CURRENT_RELEASE);
    const asset = available
      ? assetFor(CURRENT_RELEASE, platform.downloadPlatform, platform.arch)
      : null;
    const query = platform.downloadPlatform
      ? `?platform=${platform.downloadPlatform}`
      : "";
    return {
      available,
      version: CURRENT_RELEASE.version,
      asset,
      downloadHref: `/api/desktop/download${query}`,
    };
  }, [platform.downloadPlatform, platform.arch]);
}

/**
 * Ask the OS to open Framevo Desktop at `target`.
 *
 * There is no browser API for "is this scheme registered", so this uses the
 * standard heuristic: navigate to the custom scheme, then check whether the
 * page lost focus. A registered handler pulls focus to the app; an unregistered
 * one leaves the page exactly as it was. It is a heuristic — a user who
 * alt-tabs during the window will read as success — so it decides only whether
 * to OFFER the download, never whether to block anything.
 *
 * Resolves true when we believe the app took the link.
 */
export function launchDesktopApp(
  target: DeepLinkTarget,
  timeoutMs = 1500
): Promise<boolean> {
  const href = buildDeepLink(target);
  if (!href || typeof window === "undefined") return Promise.resolve(false);

  logFramevoEvent(EVENTS.DESKTOP_DEEP_LINK_ATTEMPTED, {
    target: target.kind,
    version: CURRENT_RELEASE.version,
  });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHide);
      clearTimeout(timer);
      if (!opened) {
        logFramevoEvent(EVENTS.DESKTOP_DEEP_LINK_FAILED, {
          target: target.kind,
          version: CURRENT_RELEASE.version,
        });
      }
      resolve(opened);
    };
    const onBlur = () => finish(true);
    const onHide = () => {
      if (document.visibilityState === "hidden") finish(true);
    };

    window.addEventListener("blur", onBlur, { once: true });
    document.addEventListener("visibilitychange", onHide);
    const timer = setTimeout(() => finish(false), timeoutMs);

    try {
      // Assigning `location.href` is the one navigation browsers still allow to
      // an external scheme without a user-gesture-scoped popup blocker fight.
      // An unregistered scheme is a silent no-op in Chromium, which is why the
      // focus heuristic above exists.
      window.location.href = href;
    } catch {
      finish(false);
    }
  });
}
