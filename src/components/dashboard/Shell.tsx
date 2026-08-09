"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { SIDEBAR_CONTENT_PAD, Sidebar } from "./Sidebar";
import { NavShellProvider, type NavShellValue } from "./nav-shell";
import { Topbar } from "./Topbar";
import { RecordingProvider } from "@/components/recording/RecordingProvider";
import { RecordingChrome } from "@/components/recording/RecordingChrome";
import { ExportProvider } from "@/components/export/ExportProvider";
import { EditframeExportProvider } from "@/components/export/EditframeExportProvider";
import { ExportPill } from "@/components/export/ExportPill";
import { NotificationProvider } from "@/lib/notifications/store";
import { ThemeDock } from "@/components/ui/ThemeDock";
import { isEditorRoute } from "@/components/dashboard/real-editor/editor-shell-behavior";

export function Shell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  useRecordHotkey();

  // The project editor brings its OWN chrome (EditorTopBar, tool rail, docked
  // inspector), so it renders full-bleed: no dashboard topbar, no content
  // padding, no theme dock. The nav rail is NOT part of that exception — it is
  // 72px of icons, the same 72px the rest of the workspace shows, and the
  // editor is the one screen people navigate away from most.
  const fullBleed = isEditorRoute(pathname);

  const nav = React.useMemo<NavShellValue>(
    () => ({ homeHref: "/", openNav: () => setOpen(true) }),
    []
  );

  return (
    <NotificationProvider>
      <RecordingProvider>
        <ExportProvider>
          <EditframeExportProvider>
          <NavShellProvider value={nav}>
            <div className="min-h-screen bg-ink">
              <Sidebar open={open} onClose={() => setOpen(false)} variant="rail" />
              {/* Same source as the sidebar's own width — see SIDEBAR_WIDTH. */}
              <div className={SIDEBAR_CONTENT_PAD.rail}>
                {fullBleed ? (
                  children
                ) : (
                  <>
                    <Topbar onOpenSidebar={() => setOpen(true)} />
                    <main className="px-4 py-6 lg:px-8 lg:py-8">{children}</main>
                  </>
                )}
              </div>
              {/* Workspace only. The editor is excluded on purpose: it has its
                  own dense chrome, and a floating control near the timeline
                  would steal clicks — the same rule the chat bubble follows. */}
              {!fullBleed && <ThemeDock />}
            </div>
          </NavShellProvider>
          <RecordingChrome />
          <ExportPill />
          </EditframeExportProvider>
        </ExportProvider>
      </RecordingProvider>
    </NotificationProvider>
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
