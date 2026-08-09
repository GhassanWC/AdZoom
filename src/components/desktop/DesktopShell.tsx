"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { WifiOff } from "lucide-react";
import {
  SIDEBAR_CONTENT_PAD,
  Sidebar,
  type SidebarItem,
} from "@/components/dashboard/Sidebar";
import { NavShellProvider, type NavShellValue } from "@/components/dashboard/nav-shell";
import { Topbar } from "@/components/dashboard/Topbar";
import { RecordingProvider } from "@/components/recording/RecordingProvider";
import { RecordingChrome } from "@/components/recording/RecordingChrome";
import { ExportProvider } from "@/components/export/ExportProvider";
import { EditframeExportProvider } from "@/components/export/EditframeExportProvider";
import { DesktopExportProvider } from "@/components/export/DesktopExportProvider";
import { ExportPill } from "@/components/export/ExportPill";
import { NotificationProvider } from "@/lib/notifications/store";
import { ThemeDock } from "@/components/ui/ThemeDock";
import { isEditorRoute } from "@/components/dashboard/real-editor/editor-shell-behavior";
import { useOnline } from "@/lib/useOnline";
import { DesktopRecoveryPrompt } from "./DesktopRecoveryPrompt";

/**
 * The desktop workspace chrome.
 *
 * It is the website's `Shell` with four deliberate differences, and no fifth:
 *
 *   1. `DesktopExportProvider` is mounted, because this shell has a local
 *      render engine the browser does not.
 *   2. The nav carries a Storage entry (a desktop-only screen) and drops
 *      Diagnostics; the logo points at the dashboard, since there is no
 *      marketing site inside the app.
 *   3. Crash recovery and an offline banner live here — both are conditions
 *      only a locally-installed, offline-capable app can be in.
 *   4. The sidebar is the 72px icon RAIL, not the website's 256px labelled
 *      column. An installed app is a place people live in: the nav is learned
 *      within a session or two, after which 184px of permanent text costs more
 *      than it explains. Routes, order and active-state rule are identical —
 *      only the presentation differs (see Sidebar's `SidebarVariant`).
 *
 * Everything else — topbar, notifications, the theme dock, recording chrome,
 * export pill, the fullscreen-editor exception — is the same component tree the
 * website renders.
 */
export const DESKTOP_NAV: SidebarItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" },
  { label: "Projects", href: "/dashboard/projects", icon: "Folder" },
  { label: "Upload", href: "/dashboard/upload", icon: "Upload" },
  { label: "Record", href: "/dashboard/record", icon: "Video" },
  { label: "Processing", href: "/dashboard/processing", icon: "Cpu" },
  { label: "Exports", href: "/dashboard/exports", icon: "Download" },
  { label: "Billing", href: "/dashboard/billing", icon: "CreditCard" },
  { label: "Settings", href: "/dashboard/settings", icon: "Settings" },
  { label: "Storage", href: "/dashboard/storage", icon: "HardDrive" },
];

export function DesktopShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();

  // The project editor brings its own chrome (EditorTopBar, tool rail), so its
  // CONTENT renders full-bleed — exactly as on the web. The nav rail stays: it
  // is the same 72px column every other screen shows, and an editor you can
  // only leave through a hidden menu is not the app people learned.
  const fullBleed = isEditorRoute(pathname);

  const nav = React.useMemo<NavShellValue>(
    () => ({ homeHref: "/dashboard", openNav: () => setOpen(true) }),
    []
  );

  return (
    <NotificationProvider>
      <RecordingProvider>
        <ExportProvider>
          <EditframeExportProvider>
            <DesktopExportProvider>
              <NavShellProvider value={nav}>
                <div className="min-h-screen bg-ink">
                  <Sidebar
                    open={open}
                    onClose={() => setOpen(false)}
                    items={DESKTOP_NAV}
                    homeHref="/dashboard"
                    variant="rail"
                  />
                  {/* Padded by exactly the rail's width, from the same module
                      that sets it, so the two can never disagree. */}
                  <div className={SIDEBAR_CONTENT_PAD.rail}>
                    {fullBleed ? (
                      children
                    ) : (
                      <>
                        <Topbar onOpenSidebar={() => setOpen(true)} />
                        <OfflineBanner />
                        <main className="px-4 py-6 lg:px-8 lg:py-8">{children}</main>
                      </>
                    )}
                  </div>
                  {/* Same control, same corner, same offset as the website —
                      the two shells are meant to be pixel-comparable. */}
                  {!fullBleed && <ThemeDock />}
                </div>
              </NavShellProvider>
              <RecordingChrome />
              <ExportPill />
              <DesktopRecoveryPrompt />
            </DesktopExportProvider>
          </EditframeExportProvider>
        </ExportProvider>
      </RecordingProvider>
    </NotificationProvider>
  );
}

/**
 * Offline is a NORMAL state for this app, not an error: local projects open,
 * play and export with no network at all. The banner exists so the things that
 * genuinely cannot work — AI analysis, billing, cloud projects — are explained
 * before the user presses them rather than after.
 */
function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      className="mx-4 mt-4 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-500/[0.07] px-4 py-2.5 text-[12.5px] text-amber-100 lg:mx-8"
    >
      <WifiOff size={14} className="mt-0.5 shrink-0 text-amber-300" />
      <span>
        <strong className="font-semibold text-amber-200">You&apos;re offline.</strong> Projects on
        this computer keep working — editing, preview and export are all local. Anything that needs
        your account (cloud projects, AI analysis, billing) will resume when you reconnect.
      </span>
    </div>
  );
}
