/**
 * The assistant's per-project memory (ProjectDoc.assistantMemory): standing
 * constraints, approved looks, things to avoid. Pure helpers shared by the
 * route (which records it) and the editor (which enforces the audio lock).
 */

import type { AssistantMemoryItem } from "@/lib/firebase/schema";

export const MAX_MEMORY = 24;

/** "Keep the commentary / original audio / the sound" — a standing audio constraint. */
const KEEP_AUDIO = /\b(keep|preserve|don'?t (?:touch|cut|change|remove|lose)|leave)\b[^.!?]{0,30}\b(commentary|commentator|narration|audio|sound(?:track)?|voice ?over|voice|announcer)\b/i;
/**
 * "…but keep its original sound" as the PARAMETER of a picture-only request
 * (B-roll, replace the picture) is not a standing rule — it describes that one
 * edit. Recording it as a lock made the model refuse unrelated edits later.
 */
const PICTURE_ONLY_REQUEST = /\b(picture[- ]only|b[- ]?roll|(?:replace|swap|change|cover)\b[^.!?]{0,40}\b(?:picture|video|visuals?|footage|shot)\b[^.!?]{0,30}\b(?:keep|but|with|and))\b/i;

export function audioLockFromMessage(message: string): AssistantMemoryItem | null {
  const m = KEEP_AUDIO.exec(message);
  if (!m) return null;
  if (PICTURE_ONLY_REQUEST.test(message)) return null;
  return { kind: "constraint", text: `Keep the original ${m[2].toLowerCase()} audible — this applies only to edits that change the soundtrack (cuts, trims, deletes, speed changes, mutes, silent freezes). Picture-only replacement, reordering with its sound, detaching audio, effects, zooms and captions are fine.`, lock: "audio", at: Date.now() };
}

/** Human label of a locked operation, or null when the op leaves the original soundtrack intact. */
export function lockedAudioOperation(cmd: { op: string; capability?: string; args?: Record<string, unknown> }): string | null {
  if (cmd.op === "capability") {
    const cap = cmd.capability ?? "";
    const args = cmd.args ?? {};
    switch (cap) {
      case "trim_item": return "trimming the clip";
      case "delete_item": return "deleting the clip";
      case "set_clip_speed": return "changing the clip's speed";
      case "freeze_frame": return args.audio === "continue" ? null : "freezing with the sound paused";
      case "set_hold": return "changing the hold";
      case "set_clip_audio": return args.mute === true || (typeof args.gain === "number" && args.gain < 1) ? "turning the clip's sound down" : null;
      case "replace_source": return args.picture_only === true ? null : "replacing the clip's sound with another asset";
      // move_clip keeps the linked sound WITH its picture; detach_audio only unlinks it; tracks are additions.
      default: return null;
    }
  }
  switch (cmd.op) {
    case "trim_clip": return "trimming the footage";
    case "delete_clip": return "deleting footage";
    case "remove_range": return "cutting the footage";
    case "set_speed": return "changing the speed";
    case "tighten_pauses": return "tightening the pauses";
    default: return null;
  }
}

export function isAudioLocked(memory: readonly AssistantMemoryItem[] | undefined, message?: string): boolean {
  return !!memory?.some((x) => x.lock === "audio") || (message ? !!audioLockFromMessage(message) : false);
}

/** Add items, newest wins on the same text; capped. */
export function mergeMemory(memory: readonly AssistantMemoryItem[] | undefined, add: readonly AssistantMemoryItem[]): AssistantMemoryItem[] {
  const out = [...(memory ?? [])];
  for (const item of add) {
    const key = item.text.trim().toLowerCase();
    if (!key) continue;
    const at = out.findIndex((x) => x.text.trim().toLowerCase() === key || (item.lock && x.lock === item.lock));
    if (at >= 0) out.splice(at, 1);
    out.push({ ...item, text: item.text.trim().slice(0, 200) });
  }
  return out.slice(-MAX_MEMORY);
}
