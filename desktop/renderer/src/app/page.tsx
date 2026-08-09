import { DesktopEntry } from "@/components/desktop/DesktopEntry";

/**
 * `/` — the app's cold-start landing spot.
 *
 * It resolves to nothing visible: the moment auth state is known it replaces
 * itself with /dashboard or /login. Every other route is reachable directly, so
 * this exists only for the very first frame after `loadURL("framevo://app/")`
 * and for anything that navigates to the origin root.
 */
export default function DesktopIndexPage() {
  return <DesktopEntry />;
}
