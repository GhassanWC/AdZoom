"use client";

/**
 * The interactive half of /download: what this visitor should click.
 *
 * Three states, and the page must be honest in all of them rather than always
 * showing a confident button:
 *
 *   1. An installer exists for this OS → a primary button naming it, with the
 *      exact size and version, and the other platform kept one click away
 *      (people download for a machine they're not sitting at all the time).
 *   2. This is a phone or tablet → say plainly that editing needs a computer.
 *      Offering a .exe to an iPhone is the failure mode we were asked to avoid.
 *   3. No installer has been published yet → say so, with the reason, instead
 *      of a button that 503s.
 */

import * as React from "react";
import Link from "next/link";
import {
  AppWindow,
  Apple,
  ArrowRight,
  Check,
  Copy,
  Laptop,
  Loader2,
  Monitor,
  Smartphone,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import { EVENTS } from "@/lib/analytics/events";
import { CURRENT_RELEASE } from "@/lib/desktop/current-release";
import {
  archLabel,
  assetsFor,
  formatBytes,
  PLATFORM_LABEL,
  type ReleaseAsset,
  type ReleasePlatform,
} from "@/lib/desktop/release";
import {
  launchDesktopApp,
  useDesktopAvailability,
  useDetectedPlatform,
} from "@/lib/desktop/useDesktop";

const PLATFORM_ICON: Record<ReleasePlatform, React.ReactNode> = {
  windows: <Monitor size={18} />,
  macos: <Apple size={18} />,
};

function downloadHref(asset: ReleaseAsset): string {
  return `/api/desktop/download?platform=${asset.platform}&arch=${asset.arch}`;
}

function trackDownload(asset: ReleaseAsset, placement: string): void {
  logFramevoEvent(EVENTS.DESKTOP_DOWNLOAD_CLICKED, {
    platform: asset.platform,
    arch: asset.arch,
    version: CURRENT_RELEASE.version,
    placement,
  });
}

export function DownloadPanel({ reason }: { reason?: string }) {
  const platform = useDetectedPlatform();
  const { available, asset, version } = useDesktopAvailability(platform);
  // Only the server-rendered HTML is undetected. `resolved` says so explicitly
  // rather than inferring it from `os === "unknown"`, which is also what a real
  // unsupported OS looks like — that conflation would have left a Linux user
  // staring at a spinner forever.
  const detecting = !platform.resolved;

  const otherPlatform: ReleasePlatform | null =
    platform.downloadPlatform === "windows"
      ? "macos"
      : platform.downloadPlatform === "macos"
        ? "windows"
        : null;

  return (
    <div className="mx-auto w-full max-w-3xl">
      {!available ? (
        <UnreleasedNotice reason={reason} />
      ) : platform.isMobile ? (
        <MobileNotice />
      ) : (
        <>
          <PrimaryDownload
            asset={asset}
            detecting={detecting}
            platformLabel={platform.label}
            version={version}
          />
          <OtherPlatforms primary={platform.downloadPlatform} other={otherPlatform} />
        </>
      )}

      <AlreadyInstalled />
    </div>
  );
}

function PrimaryDownload({
  asset,
  detecting,
  platformLabel,
  version,
}: {
  asset: ReleaseAsset | null;
  detecting: boolean;
  platformLabel: string;
  version: string;
}) {
  if (detecting) {
    return (
      <div className="flex h-[92px] items-center justify-center gap-2 text-sm text-fog">
        <Loader2 size={14} className="animate-spin" />
        Checking your system…
      </div>
    );
  }

  if (!asset) {
    // A desktop OS we don't ship for (Linux, ChromeOS) — name it rather than
    // silently offering the Windows build.
    return (
      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 text-center">
        <Laptop size={22} className="mx-auto text-fog" />
        <h2 className="mt-3 text-[15px] font-semibold text-white">
          No installer for {platformLabel} yet
        </h2>
        <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-fog">
          Framevo Desktop ships for Windows and macOS today. You can keep using
          the web app for your account, billing, project history and downloading
          finished exports.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <PlatformLink platform="windows" placement="unsupported-os" />
          <PlatformLink platform="macos" placement="unsupported-os" />
        </div>
      </div>
    );
  }

  return (
    <div className="text-center">
      <Button
        href={downloadHref(asset)}
        size="lg"
        leftIcon={PLATFORM_ICON[asset.platform]}
        onClick={() => trackDownload(asset, "primary")}
      >
        Download for {PLATFORM_LABEL[asset.platform]}
      </Button>
      <p className="mt-3 text-[12.5px] text-fog">
        Version {version} · {formatBytes(asset.sizeBytes)} · {asset.minimumOs}
      </p>
      <Checksum sha256={asset.sha256} filename={asset.filename} />
    </div>
  );
}

function OtherPlatforms({
  primary,
  other,
}: {
  primary: ReleasePlatform | null;
  other: ReleasePlatform | null;
}) {
  if (!other && !primary) return null;
  const extras = [
    // Every build for the OTHER platform, plus any additional architecture for
    // this one (an ARM build alongside x64, say).
    ...(other ? assetsFor(CURRENT_RELEASE, other) : []),
    ...(primary ? assetsFor(CURRENT_RELEASE, primary).slice(1) : []),
  ];
  if (extras.length === 0) return null;

  return (
    <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
      <span className="text-[12px] text-fog/70">Other downloads:</span>
      {extras.map((asset) => (
        <a
          key={`${asset.platform}-${asset.arch}`}
          href={downloadHref(asset)}
          onClick={() => trackDownload(asset, "secondary")}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[12px] font-medium text-white/85 transition-colors duration-150 hover:border-white/20 hover:bg-white/[0.05] hover:text-white"
        >
          {PLATFORM_ICON[asset.platform]}
          {PLATFORM_LABEL[asset.platform]}
          <span className="text-fog/70">
            {archLabel(asset.arch)} · {formatBytes(asset.sizeBytes)}
          </span>
        </a>
      ))}
    </div>
  );
}

/**
 * The SHA-256, copyable. Anyone verifying a download needs the digest from a
 * source other than the file's own host, and this page is that source.
 */
function Checksum({ sha256, filename }: { sha256: string; filename: string }) {
  const [copied, setCopied] = React.useState(false);
  if (!sha256) return null;

  const copy = () => {
    void navigator.clipboard?.writeText(sha256).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="mx-auto mt-4 max-w-lg">
      <button
        type="button"
        onClick={copy}
        title={`SHA-256 of ${filename}`}
        className="group inline-flex max-w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[11px] font-mono text-fog/80 transition-colors duration-150 hover:border-white/15 hover:text-white/90"
      >
        <span className="shrink-0 font-sans text-[10px] uppercase tracking-[0.14em] text-fog/60">
          SHA-256
        </span>
        <span className="truncate">{sha256}</span>
        {copied ? (
          <Check size={11} className="shrink-0 text-emerald-300" />
        ) : (
          <Copy size={11} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </button>
    </div>
  );
}

function PlatformLink({
  platform,
  placement,
}: {
  platform: ReleasePlatform;
  placement: string;
}) {
  const asset = assetsFor(CURRENT_RELEASE, platform)[0];
  if (!asset) return null;
  return (
    <a
      href={downloadHref(asset)}
      onClick={() => trackDownload(asset, placement)}
      className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.02] px-3.5 py-2 text-[12.5px] font-medium text-white/90 transition-colors duration-150 hover:border-white/20 hover:bg-white/[0.05]"
    >
      {PLATFORM_ICON[platform]}
      {PLATFORM_LABEL[platform]}
    </a>
  );
}

/** Phones and tablets: no installer exists, so say what to do instead. */
function MobileNotice() {
  React.useEffect(() => {
    logFramevoEvent(EVENTS.DESKTOP_MOBILE_NOTICE_SHOWN, {
      version: CURRENT_RELEASE.version,
    });
  }, []);

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 text-center">
      <Smartphone size={22} className="mx-auto text-violet-300" />
      <h2 className="mt-3 text-[15px] font-semibold text-white">
        Editing needs a computer
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-fog">
        Framevo edits and renders video on your own machine, so the app runs on
        Windows and macOS. Open this page on your computer to download it.
      </p>
      <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-fog/80">
        On your phone you can still sign in, manage your plan, browse past
        projects and download finished videos.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button href="/dashboard/projects" variant="ghost" size="sm">
          View my projects
        </Button>
        <Button href="/dashboard/billing" variant="subtle" size="sm">
          Manage plan
        </Button>
      </div>
    </div>
  );
}

/**
 * No published installer. Says which state we're in rather than rendering a
 * button that would 503 — and keeps the rest of the product one click away.
 */
function UnreleasedNotice({ reason }: { reason?: string }) {
  return (
    <div className="rounded-2xl border border-amber-400/20 bg-amber-500/[0.06] p-6 text-center">
      <AppWindow size={22} className="mx-auto text-amber-200" />
      <h2 className="mt-3 text-[15px] font-semibold text-white">
        The desktop app isn&apos;t available to download yet
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-fog">
        {reason === "unreleased"
          ? "That download link is live, but this build hasn't been published yet."
          : "We're finishing end-to-end testing on the installer. It'll appear here the moment it passes."}{" "}
        Everything on the web app keeps working in the meantime.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button href="/dashboard" size="sm">
          Open the web app
        </Button>
        <Button href="/changelog" variant="ghost" size="sm" rightIcon={<ArrowRight size={13} />}>
          Release notes
        </Button>
      </div>
    </div>
  );
}

/** For people who already installed it — one click back into the app. */
function AlreadyInstalled() {
  const [state, setState] = React.useState<"idle" | "opening" | "missed">("idle");

  const open = async () => {
    setState("opening");
    const opened = await launchDesktopApp({ kind: "home" });
    setState(opened ? "idle" : "missed");
  };

  return (
    <div className="mt-8 border-t border-white/[0.06] pt-6 text-center">
      <p className="text-[12.5px] text-fog">
        Already installed?{" "}
        <button
          type="button"
          onClick={() => void open()}
          className={cn(
            "font-medium text-violet-300 underline-offset-4 transition-colors duration-150 hover:text-violet-200 hover:underline",
            state === "opening" && "opacity-60"
          )}
        >
          {state === "opening" ? "Opening Framevo…" : "Open Framevo"}
        </button>
      </p>
      {state === "missed" && (
        <p className="mt-2 text-[12px] text-fog/75">
          Nothing opened — either it isn&apos;t installed on this machine, or your
          browser blocked the link. Download it above, then try again.{" "}
          <Link href="#troubleshooting" className="text-violet-300 hover:underline">
            Troubleshooting
          </Link>
        </p>
      )}
    </div>
  );
}
