/**
 * The editing chat's message model + the pure rules behind what it says.
 *
 *  • ONE welcome line and at most two suggestions that fit THIS footage.
 *  • A green check is earned: only a reply whose request actually changed the
 *    timeline is an "edit" message. Questions, refusals and progress are
 *    neutral text, never a check.
 *  • Short, specific results ("Added 3 zooms on clicks") — and when part of a
 *    request was blocked, which part worked and what stopped the rest.
 *
 * Pure (no React) — tested in tests/edit-commands-chat.test.ts.
 */

import type { AssistantLogEntry, ProjectDoc } from "@/lib/firebase/schema";
import type { EditError } from "./types";
import type { FootageNeed } from "./parse";

export const WELCOME = "What would you like to change in your video?";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /**
   * text     — a neutral reply (question, explanation). No check mark.
   * progress — a step that is running ("Transcribing the speech…").
   * edit     — the timeline changed. The ONLY kind that shows a green check.
   * blocked  — nothing changed, and why.
   */
  kind: "text" | "progress" | "edit" | "blocked";
  text?: string;
  edit?: AssistantLogEntry;
  /** On an edit: the parts of the request that did NOT happen, and why. */
  blocked?: string[];
  /** Small print under an edit ("Kept the later take…"). */
  notes?: string[];
  /** Candidate answers — clicking one fills the message box. */
  options?: string[];
}

const SCREEN_TYPES = new Set(["screen-recording", "product-demo", "tutorial"]);

/**
 * At most two suggestions, chosen from what this footage is and what the edit
 * already has. Never suggests something that's already done.
 */
export function welcomeSuggestions(
  project: Pick<ProjectDoc, "analysis" | "selectedVideoType" | "interactionsPath" | "interactionScope" | "visualAnalysis" | "clickMarks">
): string[] {
  const moments = project.analysis?.detectedMoments ?? [];
  const has = (t: string) => moments.some((m) => m.effectType === t && m.enabled !== false);
  const speech = project.analysis?.audioAnalysis?.hasUsableSpeech !== false;
  const screen =
    !!project.interactionsPath ||
    project.interactionScope === "tab" ||
    SCREEN_TYPES.has(project.selectedVideoType ?? "") ||
    (project.visualAnalysis?.inferredClicks?.length ?? 0) > 0 ||
    (project.clickMarks?.length ?? 0) > 0;

  const out: string[] = [];
  if (speech && !has("captions")) out.push("Add captions");
  if (screen && !has("zoom")) out.push("Add zooms on clicks");
  if (out.length < 2 && speech && !has("cut")) out.push("Tighten the long pauses");
  if (out.length < 2 && !screen && !has("zoom")) out.push("Add zooms on clicks");
  if (out.length < 2 && !has("text-overlay")) out.push("Add a title at the start");
  return out.slice(0, 2);
}

const NEED_BLOCKED: Record<FootageNeed, string> = {
  transcript: "Captions weren't added",
  clicks: "No zooms were added",
  pauses: "The pacing wasn't changed",
};

/** Error codes that mean "the data this part needed wasn't there". */
const NEED_FOR_CODE: Partial<Record<EditError["code"], FootageNeed>> = {
  no_transcript: "transcript",
  no_clicks: "clicks",
  no_audio: "pauses",
};

/**
 * What didn't happen, phrased for the user. A preparation failure ("speech-to-
 * text failed: quota reached") explains its dependent part better than the
 * executor's generic "no transcript", so it wins.
 */
export function blockedLines(
  errors: readonly EditError[],
  prepFailures: readonly { need: FootageNeed; note: string }[]
): string[] {
  const out: string[] = [];
  const usedPrep = new Set<FootageNeed>();
  for (const e of errors) {
    const need = NEED_FOR_CODE[e.code];
    const prep = need ? prepFailures.find((p) => p.need === need) : undefined;
    if (prep) {
      usedPrep.add(prep.need);
      out.push(`${NEED_BLOCKED[prep.need]} — ${prep.note}.`);
    } else {
      out.push(e.message);
    }
  }
  for (const p of prepFailures) {
    if (!usedPrep.has(p.need) && !out.some((l) => l.includes(p.note))) out.push(`${NEED_BLOCKED[p.need]} — ${p.note}.`);
  }
  return [...new Set(out)];
}

let seq = 0;
export function chatId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}
