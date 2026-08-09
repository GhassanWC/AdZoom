"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { usePlatform } from "@/lib/platform";
import { Button } from "@/components/ui/Button";
import { RealEditorPage } from "@/components/dashboard/real-editor/RealEditor";
import { DesktopSplash } from "./DesktopAuthGate";
import { projectIdFromPath } from "./project-route";

/**
 * The editor route, resolved from the URL rather than from route params.
 *
 * `params.id` is the build-time placeholder here (one artifact serves every
 * project — see the route file), so the real id comes from the pathname. The
 * pathname is authoritative in every case that matters: a Link click, a reload,
 * a deep link into the packaged app, and back/forward between two projects.
 *
 * `RealEditorPage` below is the SAME component the website renders at
 * /dashboard/projects/[id]. It works unchanged because the platform layer hands
 * it local or cloud storage per project — the editor never learns which.
 */
export function DesktopProjectEditor() {
  const pathname = usePathname();
  const router = useRouter();
  const platform = usePlatform();
  const projectId = projectIdFromPath(pathname);
  // Keyed by project id rather than a bare boolean, so navigating from a
  // missing project to a real one clears itself — no synchronous reset, and no
  // frame where the new project inherits the old one's verdict.
  const [missingId, setMissingId] = React.useState<string | null>(null);
  const missing = projectId !== null && missingId === projectId;

  React.useEffect(() => {
    if (!projectId) return;
    let live = true;
    // A project may live in EITHER backend, and the pathname alone doesn't say
    // which. Ask both before concluding it's gone — a cloud project opened on
    // this machine for the first time is not in the local library.
    const lookups = [platform.projects.get(projectId)];
    if (platform.cloudProjects) lookups.push(platform.cloudProjects.get(projectId));
    void Promise.all(lookups.map((p) => p.catch(() => null))).then((docs) => {
      if (!live) return;
      setMissingId(docs.every((doc) => doc === null) ? projectId : null);
    });
    return () => {
      live = false;
    };
  }, [platform, projectId]);

  // The placeholder path itself, or a truncated URL — neither names a project.
  if (!projectId) {
    return (
      <ProjectProblem
        title="No project selected"
        detail="That link didn't include a project."
        onBack={() => router.replace("/dashboard/projects")}
      />
    );
  }

  if (missing) {
    return (
      <ProjectProblem
        title="Project not found"
        detail="It may have been deleted, or it belongs to a different account."
        onBack={() => router.replace("/dashboard/projects")}
      />
    );
  }

  if (!pathname) return <DesktopSplash label="Opening your project…" />;

  return <RealEditorPage projectId={projectId} />;
}

function ProjectProblem({
  title,
  detail,
  onBack,
}: {
  title: string;
  detail: string;
  onBack: () => void;
}) {
  return (
    <div className="grid h-dvh place-items-center bg-ink px-4">
      <div className="glass w-full max-w-md rounded-2xl p-8 text-center">
        <div className="mx-auto inline-flex size-12 items-center justify-center rounded-xl border border-rose-400/30 bg-rose-500/10 text-rose-300">
          <AlertCircle size={20} />
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold text-white">{title}</h2>
        <p className="mt-2 text-sm text-fog">{detail}</p>
        <div className="mt-5 flex justify-center">
          <Button onClick={onBack} variant="ghost" size="sm">
            Back to projects
          </Button>
        </div>
      </div>
    </div>
  );
}
