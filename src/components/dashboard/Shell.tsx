"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { RecordingProvider } from "@/components/recording/RecordingProvider";
import { RecordingChrome } from "@/components/recording/RecordingChrome";

export function Shell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  useRecordHotkey();

  return (
    <RecordingProvider>
      <div className="min-h-screen bg-ink">
        <Sidebar open={open} onClose={() => setOpen(false)} />
        <div className="lg:pl-64">
          <Topbar onOpenSidebar={() => setOpen(true)} />
          <main className="px-4 py-6 lg:px-8 lg:py-8">{children}</main>
        </div>
      </div>
      <RecordingChrome />
    </RecordingProvider>
  );
}

/**
 * Global `Cmd/Ctrl + Shift + R` shortcut → jump to the Record screen from
 * anywhere in the dashboard. Skipped if focus is in a text field (so the
 * browser's hard-refresh chord still works while typing) and if we're already
 * on `/dashboard/record` (so we don't redirect onto ourselves).
 */
function useRecordHotkey() {
  const router = useRouter();
  const pathname = usePathname();
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "r") return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      if (pathname === "/dashboard/record") return;
      e.preventDefault();
      router.push("/dashboard/record");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, pathname]);
}
