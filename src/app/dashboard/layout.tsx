import type { Metadata } from "next";
import { Shell } from "@/components/dashboard/Shell";
import { AuthGuard } from "@/components/dashboard/AuthGuard";

export const metadata: Metadata = {
  title: "AdZoom — Editor",
  description: "AdZoom AI editor workspace",
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
