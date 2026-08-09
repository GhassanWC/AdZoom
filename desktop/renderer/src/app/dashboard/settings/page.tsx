import WorkspaceSettings from "@/app/dashboard/settings/page";
import { DesktopAppSettings } from "@/components/desktop/DesktopAppSettings";

/**
 * `/dashboard/settings` — the website's workspace settings (defaults,
 * notifications, API keys, all on the real account) PLUS the settings that only
 * mean something on an installed app: the export encoder, the update channel,
 * and where the library lives.
 */
export default function DesktopSettingsPage() {
  return (
    <div className="space-y-6">
      <WorkspaceSettings />
      <DesktopAppSettings />
    </div>
  );
}
