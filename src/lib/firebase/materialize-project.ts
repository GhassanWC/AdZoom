/**
 * Firestore snapshot data → `ProjectDoc`. PURE (no SDK, no I/O) so it's testable.
 *
 * This mapper is a WHITELIST, and that is exactly how Smart Clips broke: `clips`
 * was added to `ProjectDoc`, written to Firestore successfully… and never listed
 * here. Every reader got `clips: undefined` forever, so the editor rendered zero
 * cards while its own run state insisted three clips existed. The data was in the
 * document the whole time.
 *
 * The `Complete<ProjectDoc>` return type is the guard against a repeat: it makes
 * every key of ProjectDoc — including the OPTIONAL ones — required in the object
 * literal below. Add a field to ProjectDoc and forget it here, and this file
 * stops compiling instead of silently dropping the field at runtime.
 */

import type { ProjectDoc, ProjectStatus, SourceCrop } from "./schema";
import { DEFAULT_EFFECTS_SETTINGS } from "./schema";
import { normalizeContentProfile } from "../editorial/context";

/**
 * Every key of T, required — but still allowed to hold `undefined`. Omitting a
 * key is a compile error; explicitly mapping it to `undefined` is fine.
 */
type Complete<T> = { [K in keyof Required<T>]: T[K] };

export function materializeProject(
  id: string,
  data: Record<string, unknown>
): Complete<ProjectDoc> {
  return {
    id,
    userId: data.userId as string,
    title: (data.title as string) ?? "Untitled",
    originalVideoUrl: (data.originalVideoUrl as string) ?? "",
    storagePath: (data.storagePath as string) ?? "",
    duration: tsNum(data.duration),
    width: tsNum(data.width),
    height: tsNum(data.height),
    fileSize: tsNum(data.fileSize),
    mimeType: (data.mimeType as string) ?? undefined,
    status: ((data.status as ProjectStatus) ?? "uploaded") as ProjectStatus,
    selectedVideoType: (data.selectedVideoType as ProjectDoc["selectedVideoType"]) ?? undefined,
    // Editorial Engine Phase 1 — the fields whose omission would reproduce the
    // Smart Clips bug (written fine, read back `undefined` forever).
    contentProfile: normalizeContentProfile(data.contentProfile),
    editingTemplateId: (data.editingTemplateId as string) ?? undefined,
    analysis: (data.analysis as ProjectDoc["analysis"]) ?? undefined,
    visualAnalysis: (data.visualAnalysis as ProjectDoc["visualAnalysis"]) ?? undefined,
    // Merged onto the defaults, not substituted for them: a doc written before a
    // field existed (e.g. `zoomPreset`) must still read back the current default
    // rather than `undefined`, or every renderer silently falls back on its own.
    effectsSettings: {
      ...DEFAULT_EFFECTS_SETTINGS,
      ...((data.effectsSettings as Partial<ProjectDoc["effectsSettings"]>) ?? {}),
    },
    selectedPresetId: (data.selectedPresetId as string) ?? undefined,
    exportUrl: (data.exportUrl as string) ?? undefined,
    interactionScope: (data.interactionScope as ProjectDoc["interactionScope"]) ?? undefined,
    interactionsPath: (data.interactionsPath as string) ?? undefined,
    captureDimensions: (data.captureDimensions as ProjectDoc["captureDimensions"]) ?? undefined,
    sourceCrop: materializeSourceCrop(data),
    normalizedSourcePath: (data.normalizedSourcePath as string) ?? undefined,
    normalizedSourceKey: (data.normalizedSourceKey as string) ?? undefined,
    normalizedAudioDropped: (data.normalizedAudioDropped as boolean) ?? undefined,
    // Clips are rendered through `toRenderableClips` (clip-render.ts) — this
    // only has to get them out of the document intact.
    clips: Array.isArray(data.clips) ? (data.clips as ProjectDoc["clips"]) : undefined,
    // AI Director state (prompt + plan + revision history). This is the field
    // whose omission would reproduce the Smart Clips bug exactly: the Director
    // would write a plan, the write would succeed, and every reader would get
    // `director: undefined` — so the panel would show "no run yet" while the
    // timeline was full of Director edits, and undo/revise would have no history
    // to work from. The `Complete<ProjectDoc>` return type is what forced this
    // line to exist.
    director: (data.director as ProjectDoc["director"]) ?? undefined,
    directorBrief: (data.directorBrief as ProjectDoc["directorBrief"]) ?? undefined,
    // Per-layer visibility (Zooms & focus / Cuts / Captions / …). Absent = every
    // layer visible, which is what every project written before this field had.
    timelineLayers:
      (data.timelineLayers as ProjectDoc["timelineLayers"]) ?? undefined,
    // Sync bookkeeping. These MUST be carried through: the desktop's
    // compare-and-set push reads `rev` off the materialized document, so
    // dropping it here would make every push look like it was composed against
    // revision 0 and turn every concurrent edit into a false conflict.
    rev: typeof data.rev === "number" ? data.rev : undefined,
    lastWriterDeviceId: (data.lastWriterDeviceId as string) ?? undefined,
    lastOpId: (data.lastOpId as string) ?? undefined,
    createdAt: tsMs(data.createdAt) ?? Date.now(),
    updatedAt: tsMs(data.updatedAt) ?? Date.now(),
  };
}

/**
 * Read the global `sourceCrop`, with a back-compat shim for projects saved under
 * the earlier bottom-only `recordingCleanup` model: synthesize an equivalent
 * bottom-only crop rect so they keep removing the sharing bar.
 */
export function materializeSourceCrop(data: Record<string, unknown>): SourceCrop | undefined {
  const direct = data.sourceCrop as SourceCrop | undefined;
  if (direct) return direct;
  const legacy = data.recordingCleanup as
    | {
        removeBottomCaptureBar?: boolean;
        bottomCropPx?: number;
        sourceHeight?: number;
        confidence?: number;
      }
    | undefined;
  if (
    legacy &&
    legacy.removeBottomCaptureBar &&
    (legacy.bottomCropPx ?? 0) > 0 &&
    (legacy.sourceHeight ?? 0) > 0
  ) {
    const height = Math.max(
      0,
      Math.min(1, (legacy.sourceHeight! - legacy.bottomCropPx!) / legacy.sourceHeight!)
    );
    return {
      enabled: true,
      x: 0,
      y: 0,
      width: 1,
      height,
      reason: "browser-bar-cleanup",
      confidence: legacy.confidence,
    };
  }
  return undefined;
}

function tsNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function tsMs(v: unknown): number | undefined {
  if (v && typeof v === "object" && "toMillis" in v) {
    return (v as { toMillis(): number }).toMillis();
  }
  if (typeof v === "number") return v;
  return undefined;
}
