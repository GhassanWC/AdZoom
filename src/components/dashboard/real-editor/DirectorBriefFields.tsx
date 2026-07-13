"use client";

import * as React from "react";
import { Clapperboard, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { parseDirectorRequest, type DirectorRequestForm } from "@/lib/director/request";
import {
  DIRECTOR_ASPECTS,
  DIRECTOR_CAPTION_STYLES,
  DIRECTOR_CTA_MODES,
  DIRECTOR_PLATFORMS,
  DIRECTOR_STYLES,
  type DirectorAspect,
  type DirectorBrief,
  type DirectorCaptionStyle,
  type DirectorCtaMode,
  type DirectorGoal,
  type DirectorPlatform,
  type DirectorStyle,
} from "@/lib/director/types";

// ════════════════════════════════════════════════════════════════════════════
// Option labels — display strings for the FROZEN const arrays. The arrays are
// the source of truth for the VALUES; these only make them readable.
// ════════════════════════════════════════════════════════════════════════════

const PLATFORM_LABEL: Record<DirectorPlatform, string> = {
  tiktok: "TikTok",
  reels: "Instagram Reels",
  shorts: "YouTube Shorts",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  x: "X / Twitter",
  internal: "Internal / team",
};

const STYLE_LABEL: Record<DirectorStyle, string> = {
  energetic: "Energetic",
  professional: "Professional",
  calm: "Calm",
  cinematic: "Cinematic",
  minimal: "Minimal",
};

const CAPTION_STYLE_LABEL: Record<DirectorCaptionStyle, string> = {
  none: "No captions",
  clean: "Clean",
  bold_social: "Bold social",
  minimal: "Minimal",
  podcast: "Podcast",
  tutorial: "Tutorial",
};

const CTA_LABEL: Record<DirectorCtaMode, string> = {
  auto: "Auto — decide for me",
  always: "Always end with a CTA",
  never: "Never add a CTA",
};

/** The suggested directions. Each fills the prompt with a real, editable brief. */
const GOAL_CHIPS: { goal: DirectorGoal; label: string; prompt: string }[] = [
  {
    goal: "product-demo",
    label: "Create a product demo",
    prompt:
      "Create a product demo that walks through the main flow end to end. Cut the dead time, zoom in on what I click, and add captions.",
  },
  {
    goal: "tutorial",
    label: "Create a tutorial",
    prompt:
      "Create a clear tutorial. Keep every step, remove the pauses and false starts, and add captions people can follow along with.",
  },
  {
    goal: "social-clips",
    label: "Create social media clips",
    prompt:
      "Cut this down to a short vertical clip for social. Open on the strongest moment, keep it punchy, and use bold captions.",
  },
  {
    goal: "promo",
    label: "Create a short promotional video",
    prompt:
      "Make a short promo. Strong hook, only the best moments, and finish with a call to action.",
  },
  {
    goal: "clean-up",
    label: "Clean and improve the full video",
    prompt:
      "Clean up the full video: remove the silences and filler words, tighten the pacing, and keep everything important.",
  },
];

const PLACEHOLDER =
  "Turn this into a 45-second product demo for TikTok. Focus on the payment flow, cut the setup at the start, add captions and a strong hook.";

const FIELD_CLASS =
  "h-9 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 text-[12.5px] text-white outline-none transition-colors duration-150 focus:border-violet-400/50 disabled:opacity-50 [&>option]:bg-ink [&>option]:text-white";

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * The brief as the DIALOG holds it while you edit — the persisted
 * {@link DirectorBrief} plus the target duration kept as raw text, because a
 * half-typed number ("4" on the way to "45") is a valid thing to be looking at
 * and must not be clamped or coerced under the cursor.
 */
export interface DirectorBriefDraft {
  prompt: string;
  goal?: DirectorGoal;
  platform: DirectorPlatform;
  aspectRatio: DirectorAspect;
  style: DirectorStyle;
  captionStyle: DirectorCaptionStyle;
  cta: DirectorCtaMode;
  /** Raw input text. Empty = "as long as it needs to be". */
  target: string;
}

/** Seed the draft from the project's saved brief — this is what the user last wrote. */
export function directorDraftFromBrief(brief?: DirectorBrief | null): DirectorBriefDraft {
  const f = brief?.form ?? {};
  return {
    prompt: brief?.prompt ?? "",
    goal: f.goal,
    platform: f.platform ?? "youtube",
    aspectRatio: f.aspectRatio ?? "16:9",
    style: f.style ?? "professional",
    captionStyle: f.captionStyle ?? "clean",
    cta: f.cta ?? "auto",
    target: f.targetDurationSeconds ? String(f.targetDurationSeconds) : "",
  };
}

/** The draft's controls, in the shape the parser and the persisted brief use. */
export function directorDraftToForm(d: DirectorBriefDraft): DirectorRequestForm {
  const target = Number.parseInt(d.target, 10);
  return {
    ...(d.goal ? { goal: d.goal } : {}),
    platform: d.platform,
    aspectRatio: d.aspectRatio,
    style: d.style,
    captionStyle: d.captionStyle,
    cta: d.cta,
    ...(Number.isFinite(target) && target > 0 ? { targetDurationSeconds: target } : {}),
  };
}

/** Is there anything here worth running the Director for? */
export function directorDraftHasPrompt(d: DirectorBriefDraft): boolean {
  return d.prompt.trim().length > 0;
}

/**
 * The Director brief editor — the prompt, the suggested directions, and the six
 * controls that fill in whatever the prompt leaves unsaid.
 *
 * It is a CONTROLLED, PURE form: it renders a draft and reports changes. It does
 * not save, does not start a run, and does not know what will happen next — the
 * analysis dialog owns all of that, which is what lets one "Start analysis"
 * button carry both the brief and the edit selection.
 *
 * NOTE ON "Caption style": this is the LOOK of the caption edits the Director
 * plans, not a request to transcribe. Analysis never runs ASR (captions are the
 * separate, quota-metered action) — if a brief asks for captions and there is no
 * transcript, the Director stage says so in the activity log and applies
 * everything else.
 */
export function DirectorBriefFields({
  value,
  onChange,
  disabled,
}: {
  value: DirectorBriefDraft;
  onChange: (next: DirectorBriefDraft) => void;
  disabled?: boolean;
}) {
  const set = <K extends keyof DirectorBriefDraft>(key: K, v: DirectorBriefDraft[K]) =>
    onChange({ ...value, [key]: v });

  // The SAME pure parser the server runs — so "what the Director understood" is
  // the real thing, not a UI approximation of it.
  const parsed = parseDirectorRequest(value.prompt, directorDraftToForm(value));
  const hasPrompt = directorDraftHasPrompt(value);

  return (
    <section className="space-y-4 rounded-xl border border-violet-400/25 bg-violet-500/[0.06] p-4">
      {/* ── The brief ──────────────────────────────────────────────────────── */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-200 ring-1 ring-violet-400/25">
            <Clapperboard size={13} />
          </span>
          <h3 className="text-[13px] font-semibold text-white">
            Tell the Director what you want
          </h3>
          <span className="rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-fog/70">
            Optional
          </span>
        </div>
        <p className="text-[11.5px] leading-relaxed text-fog">
          Describe the video you want and the Director plans the story, cuts the dead time,
          zooms, picks matching designs from the preset library — as the final step of this
          analysis, on your timeline, where you can change any of it.
        </p>
        <textarea
          rows={3}
          value={value.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          placeholder={PLACEHOLDER}
          aria-label="Describe the video you want"
          disabled={disabled}
          className="w-full resize-none rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-[12.5px] leading-relaxed text-white outline-none transition-colors duration-150 placeholder:text-fog/60 focus:border-violet-400/50 disabled:opacity-50"
        />
      </div>

      {/* ── Suggested directions ───────────────────────────────────────────── */}
      <div className="space-y-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
          Suggested directions
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {GOAL_CHIPS.map((c) => (
            <button
              key={c.goal}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...value, prompt: c.prompt, goal: c.goal })}
              className={cn(
                "fv-press-sm inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11.5px] font-medium",
                "transition-[background-color,border-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
                "disabled:pointer-events-none disabled:opacity-40",
                value.goal === c.goal
                  ? "border-violet-400/40 bg-violet-500/15 text-violet-100"
                  : "border-white/[0.08] bg-white/[0.03] text-fog hover:border-white/20 hover:text-white"
              )}
            >
              <Sparkles size={11} className="shrink-0" />
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Direction controls ─────────────────────────────────────────────── */}
      <div className="space-y-2.5">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
          Direction
        </h4>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Target duration">
            <input
              type="number"
              min={5}
              max={3600}
              inputMode="numeric"
              value={value.target}
              onChange={(e) => set("target", e.target.value)}
              placeholder="Auto"
              disabled={disabled}
              aria-label="Target duration in seconds"
              className={FIELD_CLASS}
            />
          </Field>
          <Field label="Aspect ratio">
            <select
              value={value.aspectRatio}
              onChange={(e) => set("aspectRatio", e.target.value as DirectorAspect)}
              disabled={disabled}
              aria-label="Aspect ratio"
              className={FIELD_CLASS}
            >
              {DIRECTOR_ASPECTS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Platform">
            <select
              value={value.platform}
              onChange={(e) => set("platform", e.target.value as DirectorPlatform)}
              disabled={disabled}
              aria-label="Platform"
              className={FIELD_CLASS}
            >
              {DIRECTOR_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABEL[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Editing style">
            <select
              value={value.style}
              onChange={(e) => set("style", e.target.value as DirectorStyle)}
              disabled={disabled}
              aria-label="Editing style"
              className={FIELD_CLASS}
            >
              {DIRECTOR_STYLES.map((s) => (
                <option key={s} value={s}>
                  {STYLE_LABEL[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Caption style">
            <select
              value={value.captionStyle}
              onChange={(e) => set("captionStyle", e.target.value as DirectorCaptionStyle)}
              disabled={disabled}
              aria-label="Caption style"
              className={FIELD_CLASS}
            >
              {DIRECTOR_CAPTION_STYLES.map((c) => (
                <option key={c} value={c}>
                  {CAPTION_STYLE_LABEL[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Call to action">
            <select
              value={value.cta}
              onChange={(e) => set("cta", e.target.value as DirectorCtaMode)}
              disabled={disabled}
              aria-label="Call to action"
              className={FIELD_CLASS}
            >
              {DIRECTOR_CTA_MODES.map((c) => (
                <option key={c} value={c}>
                  {CTA_LABEL[c]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* What the Director will actually act on — the prompt overrides the
            controls when it's explicit, so show the resolved request. */}
        {hasPrompt ? (
          <p className="text-[11px] leading-relaxed text-fog/70">
            Reads as:{" "}
            <span className="text-fog">
              {STYLE_LABEL[parsed.style].toLowerCase()} {PLATFORM_LABEL[parsed.platform]} edit,{" "}
              {parsed.aspectRatio},{" "}
              {parsed.targetDurationSeconds
                ? `about ${fmt(parsed.targetDurationSeconds)} long`
                : "as long as it needs to be"}
              ,{" "}
              {parsed.captionStyle === "none"
                ? "no captions"
                : `${CAPTION_STYLE_LABEL[parsed.captionStyle].toLowerCase()} captions`}
              .
            </span>
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-fog/70">
            Leave the brief empty and the Director sits this one out — Framevo still generates
            the edits you pick below.
          </p>
        )}
      </div>
    </section>
  );
}

/** A labelled form control. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[11px] font-medium text-fog">{label}</span>
      {children}
    </label>
  );
}
