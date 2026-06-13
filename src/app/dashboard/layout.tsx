import type { Metadata } from "next";
import { Shell } from "@/components/dashboard/Shell";
import { AuthGuard } from "@/components/dashboard/AuthGuard";
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
    </Shell>
  );
}
