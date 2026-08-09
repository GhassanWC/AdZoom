import { DesktopProjectEditor } from "@/components/desktop/DesktopProjectEditor";
import { PROJECT_ROUTE_PLACEHOLDER } from "@/components/desktop/project-route";

/**
 * `/dashboard/projects/[id]` — the editor, as a REAL dynamic route.
 *
 * A static export must know every path at build time, and a project library
 * grows at runtime, so exactly one artifact is emitted here under a reserved
 * placeholder id. The Electron protocol handler folds every real project id
 * onto that artifact (`rewriteAppPath` in desktop/src/main/protocol-rules.ts)
 * WITHOUT touching the URL — which is why a packaged deep link, a reload and a
 * restart all land on the right project, and why back/forward between two
 * projects works.
 *
 * The consequence, and the only one: the id in `params` is the placeholder, so
 * the page reads the real one from `location.pathname`. That is what
 * `DesktopProjectEditor` does.
 */
export function generateStaticParams() {
  return [{ id: PROJECT_ROUTE_PLACEHOLDER }];
}

export default function DesktopProjectEditorPage() {
  return <DesktopProjectEditor />;
}
