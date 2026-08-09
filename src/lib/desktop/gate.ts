/**
 * The desktop-first policy: which parts of the website still work in a browser,
 * and when.
 *
 * Framevo edits and renders on your machine, so the *editing* surfaces move to
 * the app. Everything a person needs in a browser — signing in, paying, seeing
 * what they've made, downloading a finished video — deliberately stays on the
 * web. Someone on a borrowed laptop must still be able to grab last week's
 * export, and someone on a phone must still be able to cancel their plan.
 *
 * ── When the gate is live ──────────────────────────────────────────────────
 * Only when an installer has actually been published. A gate that pushes people
 * toward a download that doesn't exist yet strands every user on the website
 * with no way forward, so `status: "draft"` in the release manifest keeps the
 * website behaving exactly as it does today. Publishing turns both on at once.
 *
 * Pure functions, no React — the rules are the kind of thing that should be
 * readable and testable without mounting anything.
 */

import { CURRENT_RELEASE } from "./current-release";
import { isPublished } from "./release";

/**
 * Routes that CREATE or CHANGE a video. These are what the app is for.
 *
 * Matched by prefix against the pathname, so `/dashboard/projects/abc` (the
 * editor) is gated while `/dashboard/projects` (the list) is not — the list is
 * project history, which stays available by design.
 */
const GATED_EXACT = new Set(["/dashboard/upload", "/dashboard/record"]);

/** Prefixes where anything BELOW the prefix is an editing surface. */
const GATED_PREFIXES = ["/dashboard/projects/", "/dashboard/processing"];

/**
 * Explicitly open, even though they sit under a gated prefix. Kept as a list
 * rather than an exception in the matcher so adding one is a visible decision.
 */
const ALWAYS_OPEN = new Set([
  "/dashboard",
  "/dashboard/projects",
  "/dashboard/exports",
  "/dashboard/billing",
  "/dashboard/settings",
  "/dashboard/diagnostics",
  "/dashboard/presets",
]);

/** What the user was trying to do — drives the dialog's first line. */
export type GatedAction = "upload" | "record" | "edit" | "create";

export function actionForRoute(pathname: string): GatedAction {
  if (pathname.startsWith("/dashboard/upload")) return "upload";
  if (pathname.startsWith("/dashboard/record")) return "record";
  return "edit";
}

/** True when this route is an editing surface the desktop app owns. */
export function isGatedRoute(pathname: string): boolean {
  if (!pathname) return false;
  // Normalise a trailing slash so "/dashboard/upload/" matches.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (ALWAYS_OPEN.has(path)) return false;
  if (GATED_EXACT.has(path)) return true;
  return GATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export interface GateContext {
  /** Running inside Framevo Desktop — the gate never applies to itself. */
  isDesktopApp: boolean;
  /** Phone or tablet: there is no installer, so blocking would be a dead end. */
  isMobile: boolean;
  /**
   * Escape hatch, opt-in per environment. Set
   * `NEXT_PUBLIC_DESKTOP_GATE=off` to keep browser editing available (useful
   * while support is walking someone through a problem, and for our own E2E
   * runs against the web build).
   */
  disabled?: boolean;
  /** Defaults to the real release state; injectable for tests. */
  released?: boolean;
}

export type GateDecision =
  | { kind: "allow" }
  /** Block with the download dialog — an installer exists for this machine. */
  | { kind: "block"; action: GatedAction }
  /** Phone/tablet: explain that editing needs a computer, don't offer a file. */
  | { kind: "mobile"; action: GatedAction };

/**
 * Should this navigation be interrupted?
 *
 * Note the mobile branch is a DIFFERENT outcome, not a softer block: the user
 * is told plainly that editing needs a computer, and pointed at the things they
 * can do on a phone. What we must never do is show them a "Download for
 * Windows" button they cannot use.
 */
export function evaluateGate(pathname: string, ctx: GateContext): GateDecision {
  const released = ctx.released ?? isPublished(CURRENT_RELEASE);
  if (!released) return { kind: "allow" };
  if (ctx.disabled) return { kind: "allow" };
  if (ctx.isDesktopApp) return { kind: "allow" };
  if (!isGatedRoute(pathname)) return { kind: "allow" };

  const action = actionForRoute(pathname);
  return ctx.isMobile ? { kind: "mobile", action } : { kind: "block", action };
}

/** Reads the build-time escape hatch. */
export function gateDisabledByEnv(): boolean {
  return process.env.NEXT_PUBLIC_DESKTOP_GATE === "off";
}
