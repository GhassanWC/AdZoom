import { Suspense } from "react";
import { DesktopLoginScreen } from "@/components/desktop/DesktopLoginScreen";
import { DesktopSplash } from "@/components/desktop/DesktopAuthGate";

/**
 * `/login` — the screen a fresh install opens on, and the one every expired or
 * revoked session comes back to.
 *
 * The Suspense boundary is required, not decorative: the screen reads `?next=`
 * with `useSearchParams`, which a static export must be able to render without
 * knowing the query string.
 */
export default function DesktopLoginPage() {
  return (
    <Suspense fallback={<DesktopSplash label="Loading sign-in…" />}>
      <DesktopLoginScreen />
    </Suspense>
  );
}
