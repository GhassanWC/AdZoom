/**
 * Framevo AI panel — pure state derivation (the repo's `*-state` convention).
 *
 * ONE panel, THREE states:
 *
 *   SETUP        — nothing to edit yet (or a re-run was requested): the
 *                  outcome-first card. Video · Style · Output · instruction ·
 *                  [Edit video].
 *   WORKING      — Framevo AI is editing: inline progress, no modal bounce.
 *   CONVERSATION — the transcript + composer; setup collapses to a summary.
 *
 * Everything here is pure and unit-tested (tests/framevo-ai-state.test.ts) so
 * the component is a thin renderer.
 */
import { isProcessing } from "@/lib/analysis-stages";
import type { ProjectDoc, ProjectStatus, SelectedVideoType } from "@/lib/firebase/schema";
import { VIDEO_TYPE_META } from "@/lib/analysis/video-type";
import {
  contextFromSelectedVideoType,
  normalizeContentProfile,
  type ContentProfile,
} from "@/lib/editorial/context";
import {
  defaultTemplateFor,
  getTemplate,
  templatesForProfile,
  type EditingTemplate,
} from "@/lib/editorial/templates";
import type { DirectorBrief, DirectorPlatform } from "@/lib/director/types";

export type FramevoAiStage = "setup" | "working" | "conversation";

export function deriveStage(input: {
  hasMoments: boolean;
  analyzing: boolean;
  projectStatus: ProjectStatus | string | undefined;
  /** The user asked to revisit setup (the "Change setup" affordance). */
  setupRequested?: boolean;
}): FramevoAiStage {
  const processing = input.projectStatus
    ? isProcessing(input.projectStatus as ProjectStatus)
    : false;
  if (input.analyzing || processing) return "working";
  if (!input.hasMoments || input.setupRequested) return "setup";
  return "conversation";
}

/** The profile governing setup — persisted when present, derived otherwise. */
export function profileForProject(
  project: Pick<ProjectDoc, "contentProfile" | "selectedVideoType">
): ContentProfile {
  return (
    normalizeContentProfile(project.contentProfile) ??
    contextFromSelectedVideoType(project.selectedVideoType)
  );
}

/**
 * The template the setup card shows as selected: the project's choice when it
 * still applies, else the profile's first offered style, else Classic.
 */
export function selectedTemplateForProject(
  project: Pick<ProjectDoc, "contentProfile" | "selectedVideoType" | "editingTemplateId">
): EditingTemplate {
  const chosen = getTemplate(project.editingTemplateId);
  if (chosen) return chosen;
  const offered = templatesForProfile(profileForProject(project));
  return offered[0] ?? defaultTemplateFor(project.selectedVideoType ?? "auto");
}

/** The styles the picker offers: profile-matched templates + Classic last. */
export function templateChoicesForProject(
  project: Pick<ProjectDoc, "contentProfile" | "selectedVideoType">
): EditingTemplate[] {
  const offered = templatesForProfile(profileForProject(project));
  const classic = defaultTemplateFor(project.selectedVideoType ?? "auto");
  return [...offered, classic];
}

// ── The setup card's compact rows ───────────────────────────────────────────

const PLATFORM_LABEL: Record<DirectorPlatform, string> = {
  tiktok: "TikTok",
  reels: "Instagram Reels",
  shorts: "YouTube Shorts",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  x: "X / Twitter",
  internal: "Internal",
};

export function platformLabel(p: DirectorPlatform | undefined): string {
  return p ? PLATFORM_LABEL[p] : "YouTube";
}

export function videoRowLabel(
  project: Pick<ProjectDoc, "selectedVideoType">
): { label: string; detail: string } {
  const t: SelectedVideoType = project.selectedVideoType ?? "auto";
  const meta = VIDEO_TYPE_META[t];
  return t === "auto"
    ? { label: "Auto detect", detail: "Framevo AI picks the closest match while editing." }
    : { label: meta.label, detail: meta.description };
}

/** "YouTube · 16:9 · Keep original length" — the one-line output summary. */
export function outputRowLabel(brief: DirectorBrief | null | undefined): string {
  const form = brief?.form ?? {};
  const platform = platformLabel(form.platform);
  const aspect = form.aspectRatio ?? "16:9";
  const length = form.targetDurationSeconds
    ? `About ${formatSeconds(form.targetDurationSeconds)}`
    : "Keep original length";
  return `${platform} · ${aspect} · ${length}`;
}

export function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`;
}

/**
 * The 3–4 capability chips a style card shows — drawn from the template's
 * REAL policy (never invented, never a planned category). "What it does" in
 * the user's words.
 */
export function templateChips(template: EditingTemplate): string[] {
  if (!template.spec) return ["Framevo's original behaviour"];
  const chips: string[] = [];
  const s = template.spec.edits;
  const on = (k: keyof typeof s) => {
    const st = s[k]?.status;
    return st === "core" || st === "encouraged";
  };
  if (on("captions")) chips.push("Captions");
  if (on("cut") || on("silence_removal")) chips.push("Tight cuts");
  if (on("zoom")) chips.push(s.zoom?.intensity && s.zoom.intensity <= 0.4 ? "Subtle zooms" : "Zooms");
  else if (s.zoom?.status === "allowed") chips.push("Rare zooms");
  if (on("cursor_emphasis")) chips.push("Cursor focus");
  if (on("text_overlay")) chips.push("Step labels");
  if (on("transition")) chips.push("Transitions");
  if (on("hook_text")) chips.push("Opening hook");
  if (on("branding")) chips.push("CTA");
  if (on("smart_crop")) chips.push("Social reframe");
  if (on("speed")) chips.push("Speed ramps");
  const off: string[] = [];
  if (!s.transition && !s.callout && !s.text_overlay) off.push("No decoration");
  return [...chips.slice(0, 4), ...off].slice(0, 5);
}
