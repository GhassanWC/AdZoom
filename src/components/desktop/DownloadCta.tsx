"use client";

/**
 * The "Download Framevo" call to action, OS-aware.
 *
 * Renders nothing inside the desktop app (you have it) and nothing on a phone
 * (there is no installer, and offering one is the broken flow we were asked to
 * avoid — /download carries the honest explanation for those visitors instead).
 *
 * When a release is published this links straight at the resolving endpoint, so
 * one click gets the right file. Before that it points at /download, which says
 * where things stand rather than starting a download that would 503.
 */

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import { EVENTS } from "@/lib/analytics/events";
import { PLATFORM_LABEL } from "@/lib/desktop/release";
import { useDesktopAvailability, useDetectedPlatform } from "@/lib/desktop/useDesktop";

export function DownloadCta({
  placement,
  size = "sm",
  variant = "primary",
  className,
  onNavigate,
}: {
  /** Where on the site this button lives — the analytics dimension. */
  placement: string;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "ghost" | "glass";
  className?: string;
  /** e.g. closing the mobile menu. */
  onNavigate?: () => void;
}) {
  const platform = useDetectedPlatform();
  const { available, asset, version, downloadHref } = useDesktopAvailability(platform);

  if (platform.isDesktopApp) return null;
  // Mobile and unsupported desktop OSes get no button here. /download handles
  // them with prose; a dead "Download for Linux" in the nav helps nobody.
  if (platform.isMobile || !platform.downloadPlatform) return null;

  const label = asset
    ? `Download for ${PLATFORM_LABEL[asset.platform]}`
    : "Download Framevo";

  return (
    <Button
      href={available ? downloadHref : "/download"}
      variant={variant}
      size={size}
      className={className}
      leftIcon={<Download size={14} />}
      onClick={() => {
        onNavigate?.();
        logFramevoEvent(EVENTS.DESKTOP_DOWNLOAD_CLICKED, {
          platform: platform.downloadPlatform,
          arch: platform.arch,
          version,
          placement,
          released: available,
        });
      }}
    >
      {label}
    </Button>
  );
}
