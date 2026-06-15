import type { Metadata } from "next";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminGuard } from "@/components/admin/AdminGuard";

export const metadata: Metadata = {
  title: "Admin — Framevo",
  description: "Internal admin dashboard",
  // Internal tool — never index, never follow.
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminShell>
      <AdminGuard>{children}</AdminGuard>
    </AdminShell>
  );
}
