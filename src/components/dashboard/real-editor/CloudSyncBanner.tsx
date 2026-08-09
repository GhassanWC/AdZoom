"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CloudUpload, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { usePlatform, isLocalProject } from "@/lib/platform";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { syncProjectToCloud, type CloudSyncProgress } from "@/lib/projects/cloud-sync";
import { cloudSyncBlocker } from "@/lib/projects/cloud-sync-rules";
import { Button } from "@/components/ui/Button";
import { useOnline } from "@/lib/useOnline";

/**
 * The bridge from a local project to the AI features.
 *
 * A project recorded or imported on this computer lives only in the local
 * library, and AI analysis runs on Framevo's servers against an uploaded
 * source. The editor used to state that and stop — "turn on cloud sync for this
 * project first" — with nothing anywhere that could turn it on. This is the
 * button that was missing.
 *
 * Nothing is uploaded without the user pressing it: a local-first app must not
 * quietly copy someone's screen recording to a server.
 */
export function CloudSyncBanner({ project }: { project: ProjectDoc }) {
  const platform = usePlatform();
  const { user } = useAuth();
  const router = useRouter();
  const online = useOnline();
  const [progress, setProgress] = React.useState<CloudSyncProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Cloud projects (and the whole website) need none of this.
  if (!isLocalProject(project)) return null;

  const blocker = cloudSyncBlocker(project, platform, user?.uid ?? null);
  const busy = progress !== null && progress.phase !== "done";

  const start = async () => {
    if (busy || !user) return;
    setError(null);
    setProgress({ phase: "reading" });
    try {
      const { cloudProjectId } = await syncProjectToCloud({
        project,
        uid: user.uid,
        platform,
        onProgress: setProgress,
      });
      // Continue in the cloud copy — that is the one the AI can work on.
      router.replace(`/dashboard/projects/${cloudProjectId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload didn't finish.");
      setProgress(null);
    }
  };

  const percent = progress?.percent;

  return (
    <div className="shrink-0 border-b border-violet-400/20 bg-violet-500/[0.06]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-200 ring-1 ring-violet-400/25">
          <CloudUpload size={15} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-white">
            {busy ? syncLabel(progress!) : "This project is only on this computer"}
          </p>
          <p className="truncate text-[11.5px] text-fog">
            {busy
              ? "Keep Framevo open — you can carry on editing while this finishes."
              : "AI analysis, captions and reframing run on Framevo's servers. Upload a copy to use them; your edits come with it."}
          </p>
        </div>

        <Button
          onClick={() => void start()}
          variant="primary"
          size="sm"
          disabled={busy || !!blocker || !online}
          title={blocker ?? (!online ? "You're offline." : undefined)}
          leftIcon={
            busy ? <Loader2 size={14} className="animate-spin" /> : <CloudUpload size={14} />
          }
        >
          {busy ? "Uploading…" : "Turn on cloud sync"}
        </Button>
      </div>

      {typeof percent === "number" && (
        <div
          className="h-0.5 w-full bg-white/[0.06]"
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Upload progress"
        >
          <div
            className="h-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {(error || (blocker && !busy)) && (
        <p className="flex items-start gap-1.5 border-t border-white/[0.06] px-4 py-1.5 text-[11.5px] text-rose-200">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          {error ?? blocker}
        </p>
      )}
    </div>
  );
}

function syncLabel(progress: CloudSyncProgress): string {
  switch (progress.phase) {
    case "reading":
      return "Reading the video from this computer…";
    case "uploading":
      return typeof progress.percent === "number"
        ? `Uploading to your account — ${Math.round(progress.percent)}%`
        : "Uploading to your account…";
    case "linking":
      return "Copying your edits across…";
    default:
      return "Done";
  }
}
