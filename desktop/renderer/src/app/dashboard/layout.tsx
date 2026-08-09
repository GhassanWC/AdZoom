import { DesktopAuthGate } from "@/components/desktop/DesktopAuthGate";
import { DesktopShell } from "@/components/desktop/DesktopShell";
import { SyncProvider } from "@/components/desktop/SyncProvider";

/**
 * Every `/dashboard/*` route in the desktop app, gated.
 *
 * The gate is OUTSIDE the shell on purpose: a signed-out user should not see a
 * sidebar, a topbar or a storage meter belonging to nobody. It mirrors the
 * website's `AuthGuard`, with a full-window splash instead of an in-content
 * spinner, because on the desktop there is no page around it to keep showing.
 *
 * `SyncProvider` sits INSIDE the gate: the engine needs a uid to claim anything,
 * and mounting it earlier would start a Firestore listener for nobody. Pending
 * work is not at risk either way — it lives in SQLite and is only ever drained,
 * never discarded, by the engine's absence.
 */
export default function DesktopDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DesktopAuthGate>
      <SyncProvider>
        <DesktopShell>{children}</DesktopShell>
      </SyncProvider>
    </DesktopAuthGate>
  );
}
