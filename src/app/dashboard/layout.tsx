import type { Metadata } from "next";
import { Shell } from "@/components/dashboard/Shell";
import { AuthGuard } from "@/components/dashboard/AuthGuard";
import { BRAND, PAGE_TITLE } from "@/lib/branding";

export const metadata: Metadata = {
  title: PAGE_TITLE.dashboard,
  description: `${BRAND.name} AI editor workspace`,
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
