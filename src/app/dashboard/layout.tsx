import type { Metadata } from "next";
import { Shell } from "@/components/dashboard/Shell";
import { AuthGuard } from "@/components/dashboard/AuthGuard";
import { DesktopGate } from "@/components/desktop/DesktopGate";
import { DesktopAppTelemetry } from "@/components/desktop/DesktopAppTelemetry";
import { BRAND, PAGE_TITLE } from "@/lib/branding";

export const metadata: Metadata = {
  title: PAGE_TITLE.dashboard,
  description: `${BRAND.name} AI editor workspace`,
  // The whole app workspace is private — keep it out of search indexes.
  // All /dashboard/* pages (projects, processing, billing, settings, …)
  // inherit this.
  robots: { index: false, follow: false },
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Shell>
      <AuthGuard>{children}</AuthGuard>
      {/* Route-level, not per-button: a deep link, a bookmark and a Back button
          all have to land in the same place as an in-app click. Renders nothing
          inside the desktop app, on ungated routes, or before an installer has
          been published — see lib/desktop/gate.ts. */}
      <DesktopGate />
      {/* No-op in a browser; inside the app it reports launch / first-run /
          deep-link-landed so the download funnel has an end as well as a start. */}
      <DesktopAppTelemetry />
    </Shell>
  );
}
