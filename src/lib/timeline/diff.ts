/**
 * Diffs between two timeline revisions — what the chat REPORTS (the committed
 * change, not what a command claimed) and what the conflict check compares
 * (which elements changed between a request's base revision and now).
 */

import type { DetectedMoment } from "@/lib/firebase/schema";
import type { EditCommand } from "@/lib/edit-commands/types";
import type { Sequence, SequenceItem } from "./sequence";
import { outputDurationOf } from "./evaluate";

export interface RevisionLike {
  moments: DetectedMoment[];
  sequence?: Sequence | null;
  sourceDuration?: number;
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
};

/** Field-level changes of one moment (ignores bookkeeping fields). */
const SKIP = new Set(["edited", "whySelected", "whyEffectType", "sourceSignals", "confidenceReason"]);
function changedFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (SKIP.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out;
}

/**
 * Element ids (moments, sequence items, audio tracks) whose content differs
 * between two revisions, with the property names that changed. An element
 * present in only one side maps to ["(added)"] / ["(removed)"].
 */
export function changedElementIds(before: RevisionLike, after: RevisionLike): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const bm = new Map(before.moments.map((m) => [m.id, m]));
  const am = new Map(after.moments.map((m) => [m.id, m]));
  for (const [id, m] of am) {
    const prev = bm.get(id);
    if (!prev) out.set(id, ["(added)"]);
    else {
      const f = changedFields(prev as unknown as Record<string, unknown>, m as unknown as Record<string, unknown>);
      if (f.length) out.set(id, f);
    }
  }
  for (const id of bm.keys()) if (!am.has(id)) out.set(id, ["(removed)"]);
  const bi = new Map((before.sequence?.items ?? []).map((i) => [i.id, i]));
  const ai = new Map((after.sequence?.items ?? []).map((i) => [i.id, i]));
  for (const [id, it] of ai) {
    const prev = bi.get(id);
    if (!prev) out.set(id, ["(added)"]);
    else {
      const f = changedFields(prev as unknown as Record<string, unknown>, it as unknown as Record<string, unknown>);
      if (f.length) out.set(id, f);
    }
  }
  for (const id of bi.keys()) if (!ai.has(id)) out.set(id, ["(removed)"]);
  const bt = new Map((before.sequence?.audioTracks ?? []).map((t) => [t.id, t]));
  const at = new Map((after.sequence?.audioTracks ?? []).map((t) => [t.id, t]));
  for (const [id, t] of at) {
    const prev = bt.get(id);
    if (!prev) out.set(id, ["(added)"]);
    else {
      const f = changedFields(prev as unknown as Record<string, unknown>, t as unknown as Record<string, unknown>);
      if (f.length) out.set(id, f);
    }
  }
  for (const id of bt.keys()) if (!at.has(id)) out.set(id, ["(removed)"]);
  // Order changes count as a change of every moved item.
  const bo = (before.sequence?.items ?? []).map((i) => i.id);
  const ao = (after.sequence?.items ?? []).map((i) => i.id);
  const common = ao.filter((id) => bo.includes(id));
  const boc = bo.filter((id) => ao.includes(id));
  common.forEach((id, i) => {
    if (boc[i] !== id) out.set(id, [...(out.get(id) ?? []), "position"]);
  });
  return out;
}

/** The element a command addresses (for conflict detection), or null for additive/global commands. */
export function commandTarget(c: EditCommand): string | null {
  switch (c.op) {
    case "trim_clip":
    case "delete_clip":
      return c.clipId;
    case "update_element":
    case "shift_element":
    case "split_element":
    case "remove_element":
    case "update_camera":
    case "update_graphic":
    case "update_effect":
      return c.elementId;
    case "capability": {
      const a = c.args ?? {};
      const v = a.clip_id ?? a.track_id ?? a.element_id;
      return typeof v === "string" ? v : null;
    }
    default:
      return null;
  }
}

const itemDesc = (it: SequenceItem) => (it.kind === "freeze" ? `freeze at ${fmt(it.sourceAt)}` : `${it.assetId === "source" ? "clip" : `"${it.assetId}" clip`} ${fmt(it.sourceIn)}–${fmt(it.sourceOut)}`);

/**
 * Plain-language lines describing what changed between two revisions —
 * derived from the committed state, so the chat never reports an edit that
 * did not land. Empty when nothing changed.
 */
export function describeTimelineDiff(before: RevisionLike, after: RevisionLike): string[] {
  const lines: string[] = [];
  const changed = changedElementIds(before, after);
  if (!changed.size) return lines;
  const bi = new Map((before.sequence?.items ?? []).map((i) => [i.id, i]));
  const ai = new Map((after.sequence?.items ?? []).map((i) => [i.id, i]));
  const bm = new Map(before.moments.map((m) => [m.id, m]));
  const am = new Map(after.moments.map((m) => [m.id, m]));
  const bt = new Map((before.sequence?.audioTracks ?? []).map((t) => [t.id, t]));
  const at = new Map((after.sequence?.audioTracks ?? []).map((t) => [t.id, t]));
  if (!before.sequence && after.sequence) lines.push("Converted the timeline to a sequence");
  let momentAdds = 0, momentUpdates = 0, momentRemoves = 0;
  for (const [id, fields] of changed) {
    if (ai.has(id) || bi.has(id)) {
      const it = ai.get(id) ?? bi.get(id)!;
      if (fields.includes("(added)")) lines.push(`Added ${itemDesc(it)}`);
      else if (fields.includes("(removed)")) lines.push(`Removed ${itemDesc(it)}`);
      else lines.push(`Changed ${itemDesc(it)}: ${fields.map(prettyField).join(", ")}`);
    } else if (at.has(id) || bt.has(id)) {
      const t = at.get(id) ?? bt.get(id)!;
      if (fields.includes("(added)")) lines.push(`Added audio track "${t.assetId}" at ${fmt(t.outputStart)}`);
      else if (fields.includes("(removed)")) lines.push(`Removed the audio track at ${fmt(t.outputStart)}`);
      else lines.push(`Changed the audio track at ${fmt(t.outputStart)}: ${fields.map(prettyField).join(", ")}`);
    } else {
      const m = am.get(id) ?? bm.get(id);
      if (!m) continue;
      if (fields.includes("(added)")) momentAdds++;
      else if (fields.includes("(removed)")) momentRemoves++;
      else momentUpdates++;
    }
  }
  const bits = [momentAdds ? `${momentAdds} edit${momentAdds === 1 ? "" : "s"} added` : "", momentUpdates ? `${momentUpdates} changed` : "", momentRemoves ? `${momentRemoves} removed` : ""].filter(Boolean);
  if (bits.length) lines.push(bits.join(", "));
  const d0 = before.sourceDuration != null ? safeDuration(before) : null;
  const d1 = after.sourceDuration != null ? safeDuration(after) : null;
  if (d0 != null && d1 != null && Math.abs(d0 - d1) > 0.01) lines.push(`Video length ${fmt(d0)} → ${fmt(d1)}`);
  return lines;
}

function safeDuration(r: RevisionLike): number | null {
  try {
    return outputDurationOf({ moments: r.moments, sequence: r.sequence ?? null, sourceDuration: r.sourceDuration ?? 0 });
  } catch {
    return null;
  }
}

function prettyField(f: string): string {
  return ({ sourceIn: "in point", sourceOut: "out point", speed: "speed", opacity: "fades", transitionIn: "transition", audio: "audio", duration: "hold", linkedTo: "linked hold", position: "position", startTime: "start", endTime: "end", textOverlay: "text", graphic: "graphic parts", fx: "effect settings", keyframes: "camera beats", enabled: "visibility" } as Record<string, string>)[f] ?? f;
}
