"use client";

/**
 * A link-style `Button` that fires a GA4 event on click (e.g.
 * `landing_cta_click`, `demo_clicked`). Lets marketing pages stay server
 * components while still tracking CTA clicks — only this small wrapper is
 * client-side.
 */

import * as React from "react";
import { Button } from "@/components/ui/Button";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import type { EventName } from "@/lib/analytics/events";

export function TrackedCtaButton({
  event,
  eventParams,
  href,
  children,
  variant,
  size,
  rightIcon,
  leftIcon,
  className,
}: {
  event: EventName;
  eventParams?: Record<string, unknown>;
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "ghost" | "glass" | "subtle" | "danger";
  size?: "sm" | "md" | "lg";
  rightIcon?: React.ReactNode;
  leftIcon?: React.ReactNode;
  className?: string;
}) {
  return (
    <Button
      href={href}
      variant={variant}
      size={size}
      rightIcon={rightIcon}
      leftIcon={leftIcon}
      className={className}
      onClick={() => logFramevoEvent(event, eventParams)}
    >
      {children}
    </Button>
  );
}
