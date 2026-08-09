import ProcessingPage from "@/app/dashboard/processing/page";
import { DesktopActiveRenders } from "@/components/desktop/DesktopActiveRenders";

/**
 * `/dashboard/processing` — everything currently running.
 *
 * The website's page covers AI analysis jobs (Firestore, real progress from the
 * worker). The desktop adds the half that has no cloud job behind it: renders
 * happening in this app's own child process right now.
 */
export default function DesktopProcessingPage() {
  return (
    <div className="space-y-6">
      <DesktopActiveRenders />
      <ProcessingPage />
    </div>
  );
}
