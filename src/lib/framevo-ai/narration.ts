/**
 * Framevo AI — completion narration, from REAL data only (approved rule 10).
 *
 * Every line is derived from the analysis the run persisted:
 *   • durations — `buildTimelineMap` over the actual moments (the same map the
 *     export uses);
 *   • counts — the actual timeline, per category;
 *   • deliberate omissions — the run's persisted `analysis.editorialPolicy`
 *     digest: a category is narrated as "kept out" ONLY when the resolved
 *     policy really disabled it for template reasons (never when the user
 *     toggled it off, never when it was merely infeasible, and never under a
 *     Classic resolution, which expresses no editorial taste).
 *
 * Pure. Unit-tested in tests/framevo-ai-state.test.ts.
 */
import type { DetectedMoment, ProjectDoc } from "@/lib/firebase/schema";
import { buildTimelineMap } from "@/lib/timeline/crop-speed";
import { categoryForEffectType, type EditCategoryId } from "@/lib/editorial/policy";
import { getTemplate } from "@/lib/editorial/templates";
import { formatSeconds } from "./state";

export interface CompletionNarration {
  /** "3:34 → 2:51" (absent when nothing was removed). */
  durationLine: string | null;
  /** What the edit did — real counts, user words. */
  lines: string[];
  /** Template-driven deliberate omissions — real policy reasons only. */
  omissions: string[];
  /** The style that governed the run, when an enforce template did. */
  styleName: string | null;
  editsTotal: number;
}

const CATEGORY_PHRASE: Partial<Record<EditCategoryId, [string, string]>> = {
  cut: ["cut", "cuts"],
  silence_removal: ["silence removal", "silence removals"],
  zoom: ["zoom", "zooms"],
  cursor_emphasis: ["cursor highlight", "cursor highlights"],
  captions: ["caption line", "caption lines"],
  hook_text: ["opening hook", "opening hooks"],
  text_overlay: ["text label", "text labels"],
  callout: ["callout", "callouts"],
  transition: ["transition", "transitions"],
  branding: ["call to action", "calls to action"],
  smart_crop: ["social reframe", "social reframes"],
  speed: ["speed-up", "speed-ups"],
  blur_redaction: ["blur", "blurs"],
};

/** Omission-worthy categories — the decorative/behavioural ones users notice. */
const OMISSION_CATEGORIES: EditCategoryId[] = [
  "transition",
  "callout",
  "text_overlay",
  "cursor_emphasis",
  "speed",
  "zoom",
  "hook_text",
  "branding",
];

const isAi = (m: DetectedMoment) => m.source !== "user" && m.provenance !== "user";
const live = (m: DetectedMoment) => m.enabled !== false;

export function buildCompletionNarration(
  project: Pick<ProjectDoc, "analysis" | "duration" | "editingTemplateId">
): CompletionNarration | null {
  const analysis = project.analysis;
  const moments = analysis?.detectedMoments ?? [];
  if (analysis?.status !== "complete" || moments.length === 0) return null;

  const duration = Math.max(0, project.duration ?? 0);
  const map = buildTimelineMap(moments, duration);
  const durationLine =
    map.totalRemoved > 0.5 && duration > 0
      ? `${formatSeconds(duration)} → ${formatSeconds(map.outputDuration)}`
      : null;

  // Real counts, per category, live AI edits only.
  const counts = new Map<EditCategoryId, number>();
  for (const m of moments) {
    if (!isAi(m) || !live(m)) continue;
    const c = categoryForEffectType(m.effectType);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const lines: string[] = [];
  if (map.totalRemoved > 0.5) {
    lines.push(`Removed ${formatSeconds(map.totalRemoved)} of pauses and dead time`);
  }
  const say = (c: EditCategoryId, verb = "Added") => {
    const n = counts.get(c) ?? 0;
    if (n === 0) return;
    const phrase = CATEGORY_PHRASE[c];
    if (!phrase) return;
    lines.push(`${verb} ${n} ${n === 1 ? phrase[0] : phrase[1]}`);
  };
  say("captions");
  say("zoom");
  say("cursor_emphasis");
  say("text_overlay");
  say("callout");
  say("hook_text");
  say("branding");
  say("transition");
  say("speed");
  if ((counts.get("smart_crop") ?? 0) > 0) lines.push("Reframed the video for social");

  // Deliberate omissions — ONLY what the resolved policy really says.
  const digest = analysis.editorialPolicy;
  const omissions: string[] = [];
  let styleName: string | null = null;
  if (digest && digest.mode === "enforce") {
    styleName = getTemplate(digest.templateId)?.name ?? null;
    for (const category of OMISSION_CATEGORIES) {
      const status = digest.statuses[category];
      if (status !== "disabled-by-default") continue;
      const reason = digest.reasons[category] ?? "";
      // A user toggle or an instruction is the USER's decision — narrate only
      // the TEMPLATE's taste ("<name> does not use this edit").
      if (!reason.toLowerCase().includes("does not use")) continue;
      if ((counts.get(category) ?? 0) > 0) continue; // it exists anyway (user-made)
      const phrase = CATEGORY_PHRASE[category];
      if (phrase) omissions.push(phrase[1]);
    }
  }

  const editsTotal = [...counts.values()].reduce((a, b) => a + b, 0);
  return { durationLine, lines, omissions, styleName, editsTotal };
}

/** The omissions sentence — one line, only when there is something true to say. */
export function omissionSentence(n: CompletionNarration): string | null {
  if (!n.omissions.length || !n.styleName) return null;
  const list =
    n.omissions.length === 1
      ? n.omissions[0]
      : `${n.omissions.slice(0, -1).join(", ")} and ${n.omissions[n.omissions.length - 1]}`;
  return `I kept ${list} out — they don't fit the ${n.styleName} style.`;
}
