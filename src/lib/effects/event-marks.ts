/**
 * Event targeting — "when the first goal goes in", "the second goal".
 *
 * Pure helpers shared by the route (which watches the footage and persists
 * marks), the model loop (which resolves a request to ONE verified instant or
 * a set of timestamped candidates) and the client (which renders candidates
 * and sends the user's pick back). A resolved instant is kept on the project
 * as an EventMark so revisions and reuse ("use it on the second goal") land on
 * the same frame instead of re-watching and drifting.
 */

import type { EventCandidate, EventMark } from "@/lib/firebase/schema";

const ORDINALS: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1 };

/** "the second goal" → { query: "goal", ordinal: 2 }; "a goal is scored" → { query: "goal is scored" }. */
export function parseEventQuery(raw: string): { query: string; ordinal?: number } {
  let q = raw.trim().toLowerCase();
  let ordinal: number | undefined;
  q = q.replace(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/g, (w) => {
    ordinal = ORDINALS[w];
    return "";
  });
  q = q
    .replace(/\b(the|a|an|when|moment|time|of|that|this|goes in|happens|again|same|once more|one more time)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ordinal ? { query: q, ordinal } : { query: q };
}

export const clock = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
};

/** Candidate label the user sees: "0:27.2 — the ball crosses the line". */
export function candidateLabel(c: { time: number; description?: string }): string {
  return `${clock(c.time)}${c.description ? ` — ${c.description}` : ""}`;
}

export function markId(query: string, time: number): string {
  return `ev_${query.replace(/[^a-z0-9]+/g, "-").slice(0, 24)}_${Math.round(time * 10)}`;
}

/**
 * Resolve a query against stored marks. A USER pick always wins; a verified
 * mark is reused so a revision or "the same goal again" cannot drift.
 */
export function resolveFromMarks(marks: readonly EventMark[], query: string, ordinal: number | undefined, assetId: string): EventMark | null {
  const same = marks.filter((m) => m.assetId === assetId && m.query === query);
  if (!same.length) return null;
  if (ordinal != null) {
    const byOrdinal = same.filter((m) => m.ordinal === ordinal);
    return byOrdinal.find((m) => m.source === "user") ?? byOrdinal[0] ?? null;
  }
  const user = same.filter((m) => m.source === "user").sort((a, b) => b.at - a.at);
  if (user.length) return user[0];
  return same.length === 1 ? same[0] : null;
}

/** Newest wins per (query, ordinal) and per (query, ~time); a user mark is never replaced by a verified one. */
export function mergeMarks(existing: readonly EventMark[] | undefined, add: readonly EventMark[]): EventMark[] {
  const out = [...(existing ?? [])];
  for (const m of add) {
    const i = out.findIndex((x) => x.assetId === m.assetId && x.query === m.query && ((m.ordinal != null && x.ordinal === m.ordinal) || Math.abs(x.time - m.time) <= 1));
    if (i < 0) out.push(m);
    else if (out[i].source === "user" && m.source !== "user") continue;
    else out[i] = { ...out[i], ...m, ordinal: m.ordinal ?? out[i].ordinal };
  }
  return out.slice(-40);
}

export function candidateFromMark(m: EventMark): EventCandidate {
  return { id: m.id, time: m.time, x: m.x, y: m.y, label: m.label || clock(m.time), query: m.query, assetId: m.assetId, confidence: 1, ...(m.ordinal != null ? { ordinal: m.ordinal } : {}) };
}
