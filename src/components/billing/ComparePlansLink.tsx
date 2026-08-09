"use client";

import * as React from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { usePlatform } from "@/lib/platform";

interface Props {
  label?: string;
  variant?: "ghost" | "subtle" | "primary";
  size?: "sm" | "md";
  className?: string;
}

/**
 * Link to the public pricing page.
 *
 * `/pricing` is a WEBSITE route — the desktop renderer bundles only the
 * dashboard, so a plain `<Link href="/pricing">` in Electron navigates to a
 * blank screen. Same rule the Topbar uses for `/admin`: the shell that lacks
 * the route sends the user to their browser, and if we don't know the web
 * origin we render nothing rather than a link that goes nowhere.
 */
export function ComparePlansLink({
  label = "Compare plans",
  variant = "ghost",
  size = "md",
  className,
}: Props) {
  const platform = usePlatform();

  if (platform.kind === "desktop") {
    const origin = platform.webAppOrigin;
    if (!origin) return null;
    return (
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => platform.openExternal(`${origin}/pricing`)}
        rightIcon={<ArrowUpRight size={14} className="opacity-70" />}
      >
        {label}
      </Button>
    );
  }

  return (
    <Button variant={variant} size={size} className={className} href="/pricing">
      {label}
    </Button>
  );
}
