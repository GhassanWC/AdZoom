/**
 * The assistant request log — idempotency + persistent "what changed" history.
 * Pure helpers over `ProjectDoc.assistantLog`. See the field's doc in schema.ts.
 */

import type { AssistantLogEntry } from "@/lib/firebase/schema";
import type { EditChange } from "./types";

/** Entries kept on the document. Old ones fall off; ids that old are never retried. */
export const ASSISTANT_LOG_LIMIT = 40;

export function wasApplied(log: readonly AssistantLogEntry[] | undefined, requestId: string): AssistantLogEntry | null {
  return log?.find((e) => e.requestId === requestId) ?? null;
}

export function appendLog(
  log: readonly AssistantLogEntry[] | undefined,
  entry: AssistantLogEntry
): AssistantLogEntry[] {
  return [...(log ?? []).filter((e) => e.requestId !== entry.requestId), entry].slice(-ASSISTANT_LOG_LIMIT);
}

export function entryFor(
  requestId: string,
  message: string,
  source: AssistantLogEntry["source"],
  changes: readonly EditChange[],
  now: number
): AssistantLogEntry {
  const changedIds = [...new Set(changes.filter((c) => c.kind !== "removed").map((c) => c.elementId))];
  return {
    requestId,
    message: message.trim().slice(0, 500),
    source,
    lines: changes.map((c) => c.summary),
    changedIds,
    jumpTo: changes.length ? Math.round(changes[0].at * 1000) / 1000 : null,
    at: now,
  };
}

/** Element ids the most recent requests touched, newest first — feeds "it"/"that title". */
export function recentElementIds(log: readonly AssistantLogEntry[] | undefined, depth = 3): string[] {
  const out: string[] = [];
  for (const e of [...(log ?? [])].reverse().slice(0, depth)) out.push(...e.changedIds);
  return out;
}

/** A fresh request id. Retries of the SAME request must reuse it. */
export function newRequestId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2, 12);
  return `req_${Date.now().toString(36)}_${rand}`;
}
