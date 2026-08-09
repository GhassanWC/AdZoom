import ProjectsPage from "@/app/dashboard/projects/page";

/**
 * `/dashboard/projects` — the website's library screen.
 *
 * It lists local AND cloud projects here because the page reads
 * `useProjectLibrary()`, which merges the two on whichever platform it runs
 * (see src/lib/projects/useProjectLibrary.ts). No desktop-specific list exists.
 */
export default function DesktopProjectsPage() {
  return <ProjectsPage />;
}
