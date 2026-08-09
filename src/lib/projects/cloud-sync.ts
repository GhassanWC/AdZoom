"use client";

/**
 * Turning a LOCAL desktop project into a cloud one.
 *
 * The desktop app can record and edit entirely offline, but AI analysis,
 * captions and reframing run on Framevo's servers against an uploaded source —
 * so a local project cannot use them. The editor said as much ("turn on cloud
 * sync for this project first") while offering no way to do it, which left the
 * headline feature unreachable for anything recorded in the app.
 *
 * This is that missing step:
 *
 *   1. read the file back through the media protocol (same origin, no path
 *      ever reaches the renderer),
 *   2. upload it with the SAME `createProjectFromFile` the website uses, so the
 *      Firestore document, the storage layout and the plan accounting are
 *      identical to a web upload,
 *   3. carry the edits already made locally onto the new document,
 *   4. record the cloud id on the local row, so the library lists ONE project.
 *
 * The local project is deliberately kept. It is the copy that still opens with
 * no network, and its source file is the user's own — deleting either would be
 * a surprise.
 */
import { createProjectFromFile } from "@/lib/firebase/projects";
import type { ProjectDoc } from "@/lib/firebase/schema";
import type { PlatformBridge } from "@/lib/platform/types";
import { localMediaId } from "@/lib/platform/desktop/ipc";
import { carriedEdits } from "./cloud-sync-rules";

export { carriedEdits, cloudSyncBlocker } from "./cloud-sync-rules";

export type CloudSyncPhase = "reading" | "uploading" | "linking" | "done";

export interface CloudSyncProgress {
  phase: CloudSyncPhase;
  /** 0..100 while uploading; undefined when the phase has no measure. */
  percent?: number;
}

export interface CloudSyncResult {
  cloudProjectId: string;
}

export interface CloudSyncInput {
  project: ProjectDoc;
  uid: string;
  platform: PlatformBridge;
  onProgress?: (progress: CloudSyncProgress) => void;
}

export async function syncProjectToCloud({
  project,
  uid,
  platform,
  onProgress,
}: CloudSyncInput): Promise<CloudSyncResult> {
  const mediaId = localMediaId(project.originalVideoUrl);
  if (!mediaId) throw new Error("This project's video isn't available on this computer.");

  onProgress?.({ phase: "reading" });

  // Confirms the file is still where it was AND gives us the real name/size —
  // the renderer never learns the path, only this metadata.
  const media = await platform.media.resolve(mediaId);
  if (!media) {
    throw new Error("The source video was moved or deleted. Re-import it, then try again.");
  }

  const response = await fetch(media.url);
  if (!response.ok) {
    throw new Error("Framevo couldn't read the video from this computer.");
  }
  const blob = await response.blob();
  const file = new File([blob], media.fileName, {
    type: blob.type || "video/mp4",
  });

  onProgress?.({ phase: "uploading", percent: 0 });

  const { projectId: cloudProjectId } = await createProjectFromFile({
    uid,
    file,
    title: project.title,
    duration: project.duration ?? media.durationSec,
    width: project.width ?? media.width,
    height: project.height ?? media.height,
    sourceCrop: project.sourceCrop,
    captureDimensions: project.captureDimensions,
    interactionScope: project.interactionScope,
    onProgress: (percent) => onProgress?.({ phase: "uploading", percent }),
  });

  onProgress?.({ phase: "linking" });

  // Edits made before syncing must survive it.
  const edits = carriedEdits(project);
  if (Object.keys(edits).length && platform.cloudProjects) {
    await platform.cloudProjects.write(cloudProjectId, edits, {
      label: "cloud-sync-carry-over",
    });
  }

  // The dedup key. Recorded LAST: if anything above failed, the local project
  // is untouched and the user can simply try again.
  await platform.projects.linkCloud?.(project.id, cloudProjectId);

  onProgress?.({ phase: "done" });
  return { cloudProjectId };
}
