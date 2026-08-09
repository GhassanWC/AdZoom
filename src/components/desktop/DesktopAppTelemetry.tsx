"use client";

/**
 * The desktop app's own funnel events, reported from the renderer.
 *
 * The renderer runs the same code as the website, so it already has the
 * analytics pipeline — no second SDK in the main process, and nothing to keep
 * in sync. Three questions this answers that the website alone cannot:
 *
 *   • did an install actually turn into a launch? (`desktop_app_installed`)
 *   • how often is the app opened? (`desktop_app_opened`, once per session)
 *   • did an "Open Framevo" link on the website land? (`desktop_deep_link_opened`
 *     — main appends `?src=deeplink` when it resolves one)
 *
 * "First run" is decided from a version marker in localStorage rather than
 * anything machine-identifying: the app is local-first and we have no business
 * fingerprinting the device it runs on.
 */

import * as React from "react";
import { usePlatform } from "@/lib/platform";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import { EVENTS } from "@/lib/analytics/events";

/** Last version this machine has launched — the only thing we persist. */
const VERSION_KEY = "framevo:desktop:lastVersion";
/** Set for the lifetime of the window so a client-side route change can't double-count. */
const SESSION_KEY = "framevo:desktop:openReported";

export function DesktopAppTelemetry() {
  const platform = usePlatform();
  const version = platform.app?.version ?? null;

  React.useEffect(() => {
    if (platform.kind !== "desktop") return;
    if (typeof window === "undefined") return;

    let previous: string | null = null;
    let alreadyReported = false;
    try {
      previous = window.localStorage.getItem(VERSION_KEY);
      alreadyReported = window.sessionStorage.getItem(SESSION_KEY) === "1";
    } catch {
      // Private mode or a locked-down profile — reporting is best-effort, and a
      // storage failure must never stop the app from opening.
    }

    if (!alreadyReported) {
      logFramevoEvent(EVENTS.DESKTOP_APP_OPENED, { version, platform: platform.app?.platform });
      // A machine we've never seen a version marker on is a fresh install; a
      // DIFFERENT marker is an upgrade, which is worth telling apart because
      // the two say very different things about a release.
      if (!previous) {
        logFramevoEvent(EVENTS.DESKTOP_APP_INSTALLED, {
          version,
          platform: platform.app?.platform,
          kind: "fresh",
        });
      } else if (version && previous !== version) {
        logFramevoEvent(EVENTS.DESKTOP_APP_INSTALLED, {
          version,
          previousVersion: previous,
          platform: platform.app?.platform,
          kind: "upgrade",
        });
      }
      try {
        window.sessionStorage.setItem(SESSION_KEY, "1");
        if (version) window.localStorage.setItem(VERSION_KEY, version);
      } catch {
        /* best-effort */
      }
    }

    // Main appends this when it resolves a framevo:// link from the website, so
    // the "Open Framevo" handoff can be measured end to end rather than only at
    // the point the browser fired it.
    if (new URLSearchParams(window.location.search).get("src") === "deeplink") {
      logFramevoEvent(EVENTS.DESKTOP_DEEP_LINK_OPENED, {
        version,
        route: window.location.pathname,
      });
    }
  }, [platform.kind, platform.app?.platform, version]);

  return null;
}
