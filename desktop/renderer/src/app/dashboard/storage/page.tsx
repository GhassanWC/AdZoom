import { DesktopStoragePage } from "@/components/desktop/DesktopStoragePage";

/**
 * `/dashboard/storage` — a desktop-only screen, because it answers a
 * desktop-only question: what is Framevo using on THIS disk, and what of it can
 * safely go. The cloud half of the answer (plan quota, usage) comes from the
 * same hook the sidebar meter uses.
 */
export default function DesktopStorageRoute() {
  return <DesktopStoragePage />;
}
