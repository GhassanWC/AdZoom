import { RecordingPage } from "@/components/recording/RecordingPage";
import { PAGE_TITLE } from "@/lib/branding";

export const metadata = {
  title: PAGE_TITLE.record,
  description: "Capture a screen recording and let the AI draft the cut.",
};

export default function Page() {
  return <RecordingPage />;
}
