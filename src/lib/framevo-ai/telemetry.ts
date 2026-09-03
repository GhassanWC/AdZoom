/**
 * Framevo AI — client telemetry helpers (Phase 2H). Counts + enums only.
 */
import { EVENTS } from "@/lib/analytics/events";
import { trackEvent } from "@/lib/analytics/trackEvent";
import { parseRevisionCommand } from "@/lib/director/revision";
import { computeOutcomesFromSnapshot } from "@/lib/editorial/telemetry";
import type { ProjectDoc } from "@/lib/firebase/schema";

/**
 * `edits_outcome` — the export-time acceptance diff: what happened to each
 * AI-generated edit between the run and the export the user shipped. This is
 * the event that answers "Talking Head / Clean Professional keeps 82% of AI
 * zooms." Fired once per export click; safe no-op on projects analyzed before
 * the snapshot existed. Never throws.
 */
export function trackEditsOutcome(
  project: Pick<ProjectDoc, "id" | "analysis" | "editingTemplateId">
): void {
  try {
    const snapshot = project.analysis?.editsGeneratedSnapshot;
    if (!snapshot?.length) return;
    const final = project.analysis?.detectedMoments ?? [];
    const outcomes = computeOutcomesFromSnapshot(snapshot, final);
    const digest = project.analysis?.editorialPolicy;
    void trackEvent(
      EVENTS.EDITS_OUTCOME,
      {
        templateId: digest?.templateId ?? project.editingTemplateId ?? "none",
        policyMode: digest?.mode ?? "unknown",
        totals: outcomes.totals,
        byType: outcomes.byType,
        byConfidence: outcomes.byConfidence,
        userAdded: outcomes.userAdded,
      },
      { projectId: project.id }
    );
  } catch {
    // Telemetry must never break an export.
  }
}

/**
 * Director-pushback: a "fewer X" / "no X" message is the strongest cheap
 * negative signal about a generated edit type. Fired after a successful chat
 * turn; never throws (telemetry must never break a turn).
 */
export function trackDirectorPushback(
  command: string,
  templateId: string | undefined
): void {
  try {
    const parsed = parseRevisionCommand(command);
    for (const intent of parsed.intents) {
      if (intent.kind !== "adjust-edit-count") continue;
      if (intent.direction !== "fewer" && intent.direction !== "none") continue;
      void trackEvent(EVENTS.DIRECTOR_PUSHBACK, {
        editType: intent.editType,
        direction: intent.direction,
        templateId: templateId ?? "none",
      });
    }
  } catch {
    // Deliberately swallowed.
  }
}
