/**
 * The decisions behind "turn on cloud sync", separated from the upload itself.
 *
 * PURE — no Firebase SDK, no fetch, no React — so the two rules that actually
 * matter can be tested directly:
 *
 *   • which edits survive the move to the cloud, and
 *   • when the button may be pressed at all.
 */
import type { ProjectDoc } from "@/lib/firebase/schema";
import { localMediaId } from "@/lib/platform/desktop/ipc";
import { isLocalProject } from "@/lib/platform/local";
import type { PlatformBridge } from "@/lib/platform/types";

/**
 * Fields worth carrying onto the cloud copy.
 *
 * A whitelist, for the same reason `materializeProject` is one: copying the
 * whole document would drag along `id`, `userId` and `originalVideoUrl`, each
 * of which now belongs to the cloud project and would break it. Anything
 * pointing at local storage (`interactionsPath`, `normalizedSource*`) is
 * meaningless once uploaded, and `status` belongs to the upload flow.
 */
export const CARRIED_FIELDS = [
  "analysis",
  "visualAnalysis",
  "effectsSettings",
  "selectedPresetId",
  "selectedVideoType",
  "sourceCrop",
  "clips",
  "director",
  "directorBrief",
  "timelineLayers",
  "captureDimensions",
  "interactionScope",
] as const satisfies readonly (keyof ProjectDoc)[];

/** Never carried: each of these identifies or locates the OLD project. */
export const NEVER_CARRIED = [
  "id",
  "userId",
  "originalVideoUrl",
  "storagePath",
  "status",
  "interactionsPath",
  "normalizedSourcePath",
  "normalizedSourceKey",
  "exportUrl",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof ProjectDoc)[];

export function carriedEdits(project: ProjectDoc): Partial<ProjectDoc> {
  const patch: Record<string, unknown> = {};
  for (const key of CARRIED_FIELDS) {
    const value = project[key];
    if (value !== undefined) patch[key] = value;
  }
  return patch as Partial<ProjectDoc>;
}

/** Why this project can't be synced right now, or null when it can. */
export function cloudSyncBlocker(
  project: ProjectDoc | null,
  platform: Pick<PlatformBridge, "projects">,
  uid: string | null
): string | null {
  if (!project) return "This project hasn't finished loading yet.";
  if (!isLocalProject(project)) return null; // already a cloud project
  if (!uid) return "Sign in to sync this project to your Framevo account.";
  if (!platform.projects.linkCloud) return "This build can't sync local projects.";
  if (!localMediaId(project.originalVideoUrl)) {
    return "This project's video isn't available on this computer.";
  }
  return null;
}
