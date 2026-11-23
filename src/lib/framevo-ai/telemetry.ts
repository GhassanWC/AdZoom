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

/**
 * Editing-assistant request telemetry — the request → applied edit → undo path.
 * Enums and counts only; the user's message never leaves the device here.
 */
export function trackAssistantRequest(meta: {
  source: "local" | "model" | "none";
  outcome: "applied" | "rejected" | "question" | "duplicate" | "fallback" | "failed" | "reply";
  ops?: readonly string[];
  errorCodes?: readonly string[];
  changes?: number;
  latencyMs?: number;
}, projectId?: string): void {
  try {
    void trackEvent(
      EVENTS.ASSISTANT_REQUEST,
      {
        source: meta.source,
        outcome: meta.outcome,
        ops: [...new Set(meta.ops ?? [])].join(",") || "none",
        errorCodes: [...new Set(meta.errorCodes ?? [])].join(",") || "none",
        changes: meta.changes ?? 0,
        latencyMs: Math.round(meta.latencyMs ?? 0),
      },
      projectId ? { projectId } : undefined
    );
  } catch {
    // Telemetry must never break a turn.
  }
}

export function trackAssistantAction(kind: "undo" | "jump", projectId?: string): void {
  try {
    void trackEvent(kind === "undo" ? EVENTS.ASSISTANT_UNDO : EVENTS.ASSISTANT_JUMP, {}, projectId ? { projectId } : undefined);
  } catch {
    // Deliberately swallowed.
  }
}
