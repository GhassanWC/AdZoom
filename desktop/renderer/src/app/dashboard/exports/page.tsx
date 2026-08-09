import { ExportsHistory } from "@/app/dashboard/exports/page";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { DesktopExportsList } from "@/components/desktop/DesktopExportsList";

/**
 * `/dashboard/exports` — both kinds of finished video, under ONE title.
 *
 * Files this computer produced come first (they are the ones a desktop user
 * just made, and the only ones with play / reveal / retry / delete), followed by
 * the account's cloud export history exactly as the website shows it.
 *
 * The header is rendered HERE rather than by the shared history view, which
 * brings its own on the web: stacking the two components naively put the words
 * "Export history" halfway down the page, under local files it did not describe.
 * The wording covers both halves for the same reason.
 */
export default function DesktopExportsPage() {
  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow="Exports"
        title="Exports"
        subtitle="Every finished video — rendered on this computer or in the cloud — kept in one place."
      />
      <DesktopExportsList />
      <ExportsHistory />
    </div>
  );
}
