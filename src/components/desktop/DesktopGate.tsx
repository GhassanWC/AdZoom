"use client";

/**
 * The desktop-first gate — mounted once in the dashboard layout.
 *
 * It watches the route rather than wrapping every button, because "editing
 * happens in the app" is a property of the DESTINATION, not of the click that
 * got you there: a deep link, a bookmark, a browser Back and an in-app link all
 * have to land in the same place. One component at the layout level covers all
 * of them; a per-button check would have covered whichever ones we remembered.
 *
 * What it deliberately does NOT do:
 *   • block project history, exports, billing, settings or sign-in;
 *   • appear inside the desktop app;
 *   • appear before an installer has actually been published;
 *   • hand a phone a Windows installer.
 */

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Download,
  Loader2,
  MonitorPlay,
  Smartphone,
  Wifi,
  Zap,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import { EVENTS } from "@/lib/analytics/events";
import { PLATFORM_LABEL, formatBytes } from "@/lib/desktop/release";
import {
  evaluateGate,
  gateDisabledByEnv,
  type GatedAction,
  type GateDecision,
} from "@/lib/desktop/gate";
import {
  launchDesktopApp,
  useDesktopAvailability,
  useDetectedPlatform,
} from "@/lib/desktop/useDesktop";

const HEADLINE: Record<GatedAction, string> = {
  upload: "Uploading happens in the desktop app",
  record: "Recording happens in the desktop app",
  edit: "Editing happens in the desktop app",
  create: "New projects start in the desktop app",
};

const REASONS = [
  {
    icon: <Zap size={15} />,
    title: "Faster editing",
    body: "The timeline and preview run natively instead of in a tab.",
  },
  {
    icon: <MonitorPlay size={15} />,
    title: "Local rendering",
    body: "Exports use your own GPU — no queue, no upload first.",
  },
  {
    icon: <Wifi size={15} />,
    title: "Works offline",
    body: "Your projects and media live on disk, not behind a connection.",
  },
  {
    icon: <ShieldCheck size={15} />,
    title: "Reliable sync",
    body: "Saved locally, then reconciled with the cloud — nothing lost to a flaky network.",
  },
];

/**
 * Make a rendered dialog genuinely blocking: lock background scroll, move focus
 * into it, and keep Tab inside. Without this the page underneath is still
 * reachable by keyboard — which for a gate means "blocking" only to a mouse.
 */
function useBlockingDialog(
  ref: React.RefObject<HTMLDivElement | null>,
  active: boolean
): void {
  React.useEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;

    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";

    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);

    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      // No Escape handler on purpose: there is nothing to dismiss to. The way
      // out is a download, opening the app, or the "Back to my projects" link.
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !node.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [ref, active]);
}

export function DesktopGate() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const platform = useDetectedPlatform();
  const { available, version } = useDesktopAvailability(platform);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);

  // No "wait until detected" flag: `useDetectedPlatform` is a
  // useSyncExternalStore, so the server renders the neutral snapshot (os
  // "unknown" ⇒ not gated) and the client's very first render already knows the
  // real machine. Someone inside the desktop app therefore never sees a flash of
  // a dialog aimed at browsers.
  const decision: GateDecision = React.useMemo(
    () =>
      evaluateGate(pathname, {
        isDesktopApp: platform.isDesktopApp,
        isMobile: platform.isMobile,
        disabled: gateDisabledByEnv(),
        released: available,
      }),
    [pathname, platform.isDesktopApp, platform.isMobile, available]
  );

  React.useEffect(() => {
    if (decision.kind === "allow") return;
    logFramevoEvent(
      decision.kind === "mobile"
        ? EVENTS.DESKTOP_MOBILE_NOTICE_SHOWN
        : EVENTS.DESKTOP_GATE_SHOWN,
      { action: decision.action, route: pathname, version }
    );
  }, [decision, pathname, version]);

  useBlockingDialog(dialogRef, decision.kind !== "allow");

  if (decision.kind === "allow") return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="desktop-gate-title"
      // Covers the workspace rather than replacing it: the page behind stays
      // rendered (and readable) so the interruption feels like a step, not a
      // dead end.
      className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-ink/80 p-4 backdrop-blur-md"
    >
      <div className="w-full max-w-lg rounded-2xl border border-white/[0.08] bg-surface/95 p-6 shadow-cinematic sm:p-7">
        {decision.kind === "mobile" ? (
          <MobileBody action={decision.action} />
        ) : (
          <DownloadBody action={decision.action} />
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
          <button
            type="button"
            onClick={() => router.push("/dashboard/projects")}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-fog transition-colors duration-150 hover:text-white"
          >
            <ArrowLeft size={13} />
            Back to my projects
          </button>
          <p className="text-[11.5px] text-fog/70">
            Your account, plan and finished videos stay on the web.
          </p>
        </div>
      </div>
    </div>
  );
}

function DownloadBody({ action }: { action: GatedAction }) {
  const platform = useDetectedPlatform();
  const { asset, version, downloadHref } = useDesktopAvailability(platform);
  const [opening, setOpening] = React.useState(false);
  const [openFailed, setOpenFailed] = React.useState(false);

  const openApp = async () => {
    setOpening(true);
    setOpenFailed(false);
    const opened = await launchDesktopApp({ kind: "home" });
    setOpening(false);
    if (!opened) setOpenFailed(true);
  };

  return (
    <>
      <div className="flex size-10 items-center justify-center rounded-xl border border-violet-400/25 bg-violet-500/15 text-violet-200">
        <MonitorPlay size={18} />
      </div>
      <h2
        id="desktop-gate-title"
        className="mt-4 font-display text-[20px] font-semibold tracking-tight text-white"
      >
        {HEADLINE[action]}
      </h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-fog">
        Framevo edits and renders video on your own machine. The app is free
        with your account, opens your existing projects, and picks up exactly
        where the website left off.
      </p>

      <ul className="mt-5 grid gap-3 sm:grid-cols-2">
        {REASONS.map((r) => (
          <li key={r.title} className="flex gap-2.5">
            <span className="mt-0.5 shrink-0 text-violet-300">{r.icon}</span>
            <span>
              <span className="block text-[13px] font-medium text-white">{r.title}</span>
              <span className="block text-[12.5px] leading-relaxed text-fog">{r.body}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex flex-wrap items-center gap-2.5">
        <Button
          href={downloadHref}
          leftIcon={<Download size={15} />}
          onClick={() =>
            logFramevoEvent(EVENTS.DESKTOP_DOWNLOAD_CLICKED, {
              platform: asset?.platform ?? platform.downloadPlatform,
              arch: asset?.arch ?? platform.arch,
              version,
              placement: "gate",
            })
          }
        >
          {asset
            ? `Download for ${PLATFORM_LABEL[asset.platform]}`
            : "Download Framevo"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => void openApp()}
          disabled={opening}
          leftIcon={opening ? <Loader2 size={14} className="animate-spin" /> : undefined}
        >
          {opening ? "Opening…" : "I already have it"}
        </Button>
      </div>

      {asset && (
        <p className="mt-2.5 text-[11.5px] text-fog/70">
          Version {version} · {formatBytes(asset.sizeBytes)} · {asset.minimumOs}
        </p>
      )}
      {openFailed && (
        <p className="mt-2 text-[12px] text-amber-200/90">
          Nothing opened — Framevo may not be installed on this machine yet.
        </p>
      )}
    </>
  );
}

function MobileBody({ action }: { action: GatedAction }) {
  return (
    <>
      <div className="flex size-10 items-center justify-center rounded-xl border border-violet-400/25 bg-violet-500/15 text-violet-200">
        <Smartphone size={18} />
      </div>
      <h2
        id="desktop-gate-title"
        className="mt-4 font-display text-[20px] font-semibold tracking-tight text-white"
      >
        {action === "upload"
          ? "Uploading needs a computer"
          : action === "record"
            ? "Recording needs a computer"
            : "Editing needs a computer"}
      </h2>
      <p className="mt-2 text-[13.5px] leading-relaxed text-fog">
        Framevo edits and renders video locally, so it runs on Windows and
        macOS. There&apos;s nothing to install here — open Framevo on your
        computer when you&apos;re back at it.
      </p>
      <p className="mt-3 text-[13px] leading-relaxed text-fog/85">
        On this device you can still browse your projects, manage your plan, and
        download videos you&apos;ve already exported.
      </p>
      <div className="mt-5 flex flex-wrap gap-2.5">
        <Button href="/dashboard/exports" size="sm">
          My exports
        </Button>
        <Button href="/dashboard/billing" variant="ghost" size="sm">
          Manage plan
        </Button>
      </div>
    </>
  );
}
