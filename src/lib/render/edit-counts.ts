/**
 * Edit-count summary for export-pipeline logging — the ONE way every stage
 * (job creation → worker/CLI → Remotion render) reports what a snapshot
 * contains, so a stage that drops edits is immediately visible in logs:
 * the caption count must stay identical from `[export-create]` through
 * `[export-render]`/`[remotion-render]`. Pure and dependency-free so the
 * worker bundles it via the `@` alias and tests load it under node:test.
 */
import type { DetectedMoment } from "@/lib/firebase/schema";

export interface EditCountSummary {
  /** All moments in the snapshot (enabled or not). */
  total: number;
  /** Moments that will render (`enabled !== false` — absent = enabled). */
  enabled: number;
  disabled: number;
  /** Renderable-moment count per effect type (enabled only). */
  byType: Record<string, number>;
  /** Caption moments in the snapshot / that will render. */
  captionCount: number;
  enabledCaptionCount: number;
  captionsEnabled: boolean;
}

export function summarizeEditsForLog(
  moments: readonly DetectedMoment[] | null | undefined
): EditCountSummary {
  const list = moments ?? [];
  const byType: Record<string, number> = {};
  let enabled = 0;
  let captionCount = 0;
  let enabledCaptionCount = 0;
  for (const m of list) {
    const isEnabled = m.enabled !== false;
    const type = m.effectType ?? "unknown";
    if (type === "captions") {
      captionCount++;
      if (isEnabled) enabledCaptionCount++;
    }
    if (isEnabled) {
      enabled++;
      byType[type] = (byType[type] ?? 0) + 1;
    }
  }
  return {
    total: list.length,
    enabled,
    disabled: list.length - enabled,
    byType,
    captionCount,
    enabledCaptionCount,
    captionsEnabled: enabledCaptionCount > 0,
  };
}
