import { RecordingPage } from "@/components/recording/RecordingPage";

/**
 * `/dashboard/record` — the website's recorder.
 *
 * The engine is unchanged; what the desktop adds is in the main process, which
 * answers `getDisplayMedia()` with a real source picker and grants the camera /
 * microphone permissions Chromium otherwise refuses inside Electron (see
 * desktop/src/main/index.ts `installMediaPermissions`). The finished take is
 * written to disk and becomes a local project rather than an upload.
 */
export default function DesktopRecordPage() {
  return <RecordingPage />;
}
