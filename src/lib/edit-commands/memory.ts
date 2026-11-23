/**
 * The assistant's per-project memory (ProjectDoc.assistantMemory): standing
 * constraints, approved looks, things to avoid. Pure helpers shared by the
 * route (which records it) and the editor (which enforces the audio lock).
 */

import type { AssistantMemoryItem } from "@/lib/firebase/schema";

export const MAX_MEMORY = 24;

/** "Keep the commentary / original audio / the sound" — a standing audio constraint. */
const KEEP_AUDIO = /\b(keep|preserve|don'?t (?:touch|cut|change|remove|lose)|leave)\b[^.!?]{0,30}\b(commentary|commentator|narration|audio|sound(?:track)?|voice ?over|voice|announcer)\b/i;

export function audioLockFromMessage(message: string): AssistantMemoryItem | null {
  const m = KEEP_AUDIO.exec(message);
  if (!m) return null;
  return { kind: "constraint", text: `Keep the original ${m[2].toLowerCase()} — never cut, trim, mute or speed up the footage.`, lock: "audio", at: Date.now() };
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
