/**
 * Phase-3 overlay generators — deterministic, whole-video, and CHEAP (no Gemini,
 * no extra network). Given the resolved `EditRecipePlan` + the final timeline,
 * they produce the recipe's enabled overlay edits (hook text, branding CTA, text
 * labels, callouts, transitions) as `DetectedMoment`s, plus an optional output
 * canvas for `smart_crop` (vertical reframing). They run once at finalize.
 *
 * HONESTY RULES (per product spec):
 *   • captions are NEVER auto-generated (no transcript pipeline → no fake words).
 *   • blur-redaction is NEVER auto-generated (no reliable auto-detector) — it
 *     stays a manual edit.
 *   • Each category is generated only when the recipe ENABLES it AND no edit of
 *     that type already exists (idempotent across re-analysis; never clobbers a
 *     user's manual overlays or a prior run's output).
 *   • hook text uses the real project title; CTA uses an editable type-based
 *     default; text labels + callouts reuse REAL moment labels / click targets.
 */
import type {
  DetectedMoment,
  EffectType,
  FocusRegion,
  OutputCanvas,
  SelectedVideoType,
} from "@/lib/firebase/schema";
import type {
  EditOperationCategory,
  EditRecipePlan,
} from "./edit-recipe";

export interface OverlayGenInput {
  plan: EditRecipePlan | null | undefined;
  /** The final timeline so far (for placement + dedup). */
  moments: DetectedMoment[];
  /** Source duration in seconds. */
  duration: number;
  /** Real project title — the only honest source for hook text. */
  projectTitle?: string | null;
  /** True when the project already has a user/explicit output canvas (don't override). */
  hasOutputCanvas: boolean;
}

export interface OverlayGenResult {
  moments: DetectedMoment[];
  /** Set only when smart_crop should reframe the whole export (vertical social). */
  outputCanvas?: OutputCanvas;
  log: {
    generated: Partial<Record<string, number>>;
    skipped: string[];
    smartCropAspect?: string;
  };
}

const GENERIC_LABELS = new Set([
  "cut", "zoom", "speed", "focus", "click", "crop", "moment", "edit",
  "speed up", "click emphasis", "crop / reframe",
]);

function isDescriptive(label: string | undefined): label is string {
  if (!label) return false;
  const l = label.trim().toLowerCase();
  return l.length >= 5 && !GENERIC_LABELS.has(l);
}

/** CTA copy per video type — a sensible, editable default (never fabricated data). */
function ctaTextFor(v: SelectedVideoType): string {
  switch (v) {
    case "reels-shorts":
    case "vlog":
      return "Follow for more";
    case "ad-promo":
      return "Get started";
    case "product-demo":
      return "Try it now";
    case "tutorial":
      return "Learn more";
    case "podcast-clip":
      return "Subscribe";
    default:
      return "Follow for more";
  }
}

function hookStyleFor(v: SelectedVideoType): "bold" | "minimal" | "neon" | "shadow" {
  if (v === "reels-shorts" || v === "ad-promo") return "bold";
  if (v === "talking-head" || v === "podcast-clip" || v === "tutorial") return "minimal";
  return "shadow";
}

function ctaStyleFor(v: SelectedVideoType): "minimal" | "creator" | "business" | "social" {
  if (v === "product-demo" || v === "tutorial") return "business";
  if (v === "ad-promo") return "social";
  return "creator";
}

/** OutputCanvas pixel dims for a social aspect (1080-based). */
function canvasForAspect(aspect: "9:16" | "1:1" | "16:9"): OutputCanvas {
  const dims =
    aspect === "9:16"
      ? { width: 1080, height: 1920 }
      : aspect === "1:1"
        ? { width: 1080, height: 1080 }
        : { width: 1920, height: 1080 };
  return {
    aspectRatio: aspect,
    width: dims.width,
    height: dims.height,
    fitMode: "smart-fit",
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    backgroundMode: "blur",
  };
}

const FULL_REGION: FocusRegion = { x: 0, y: 0, width: 1, height: 1 };

export function generateOverlayEdits(input: OverlayGenInput): OverlayGenResult {
  const { plan, moments, duration, projectTitle, hasOutputCanvas } = input;
  const out: DetectedMoment[] = [];
  const generated: Partial<Record<string, number>> = {};
  const skipped: string[] = [];
  let outputCanvas: OutputCanvas | undefined;
  let smartCropAspect: string | undefined;

  if (!plan || duration <= 0) {
    return { moments: out, log: { generated, skipped: ["no-plan-or-duration"] } };
  }

  const videoType = plan.effectiveVideoType;
  const enabled = (c: EditOperationCategory) => plan.enabledCategories.includes(c);
  const opParams = (c: EditOperationCategory): Record<string, unknown> | undefined =>
    plan.operations.find((o) => o.category === c && o.enabled)?.params;
  const hasType = (t: EffectType) => moments.some((m) => m.effectType === t);
  // Never auto-generate on top of a timeline the user has already hand-tuned
  // with overlays — respect their edits.
  const userTouchedOverlays = moments.some(
    (m) => (m.source === "user" || m.edited) &&
      (m.effectType === "hook-text" || m.effectType === "text-overlay" ||
        m.effectType === "callout" || m.effectType === "branding-cta" ||
        m.effectType === "transition")
  );

  const stamp = (
    m: Omit<DetectedMoment, "recipe" | "source" | "provenance">,
    category: string,
    reason: string
  ): DetectedMoment => ({
    ...m,
    source: "ai",
    provenance: "ai",
    recipe: { source: "recipe", recipeType: videoType, category, reason },
  });

  // 1. Hook text — first ~1–3s, from the real project title.
  if (enabled("hook_text") && !hasType("hook-text") && !userTouchedOverlays) {
    const title = (projectTitle ?? "").trim();
    if (title.length >= 2 && duration > 1.2) {
      const end = Math.min(duration - 0.05, Math.max(1.4, Math.min(3, duration * 0.3)));
      out.push(
        stamp(
          {
            id: "gen-hook",
            startTime: 0.15,
            endTime: end,
            label: "Hook",
            reason: "Opening hook from the project title.",
            focusRegion: FULL_REGION,
            effectType: "hook-text",
            hookText: {
              text: title.slice(0, 60),
              stylePreset: hookStyleFor(videoType),
              position: videoType === "reels-shorts" ? "center" : "top",
              animation: "pop",
            },
          },
          "hook_text",
          "Grabs attention in the first seconds."
        )
      );
      generated["hook-text"] = 1;
    } else {
      skipped.push("hook_text:no-title");
    }
  }

  // 2. Branding / CTA end-card — enabled via "branding" OR a cta text_overlay op.
  const wantsCta =
    enabled("branding") ||
    plan.operations.some(
      (o) => o.category === "text_overlay" && o.enabled && o.params?.kind === "cta"
    );
  if (wantsCta && !hasType("branding-cta") && !userTouchedOverlays && duration > 5) {
    const start = Math.max(0, duration - 4);
    out.push(
      stamp(
        {
          id: "gen-cta",
          startTime: start,
          endTime: duration,
          label: "CTA",
          reason: "End-card call to action.",
          focusRegion: FULL_REGION,
          effectType: "branding-cta",
          brandingCta: {
            ctaText: ctaTextFor(videoType),
            position: "bottom-right",
            stylePreset: ctaStyleFor(videoType),
          },
        },
        "branding",
        "Drives the viewer to act at the end."
      )
    );
    generated["branding-cta"] = 1;
  }

  // 3. Text labels — reuse REAL descriptive moment labels (tutorial steps /
  // product-demo action labels). Conservative: top 3 by attention.
  if (
    enabled("text_overlay") &&
    !hasType("text-overlay") &&
    !userTouchedOverlays &&
    (videoType === "tutorial" || videoType === "product-demo")
  ) {
    const candidates = moments
      .filter(
        (m) =>
          (m.effectType === "zoom" ||
            m.effectType === "cursor-focus" ||
            m.effectType === "click-highlight") &&
          isDescriptive(m.label)
      )
      .sort((a, b) => (b.attentionScore ?? 0) - (a.attentionScore ?? 0))
      .slice(0, 3);
    let i = 0;
    for (const c of candidates) {
      out.push(
        stamp(
          {
            id: `gen-textlabel-${i}`,
            startTime: c.startTime,
            endTime: Math.min(c.endTime, c.startTime + 3),
            label: "Label",
            reason: "Labels a key step.",
            focusRegion: FULL_REGION,
            effectType: "text-overlay",
            textOverlay: {
              text: c.label,
              position: "bottom-center",
              size: "medium",
              alignment: "center",
              backgroundStyle: "pill",
              animation: "fade",
            },
          },
          "text_overlay",
          "Explains the current step."
        )
      );
      i++;
    }
    if (i > 0) generated["text-overlay"] = i;
  }

  // 4. Callouts — point at REAL click / UI targets. Product demo / screen
  // recording / tutorial. Top 4 grounded, high-confidence targets.
  if (enabled("callout") && !hasType("callout") && !userTouchedOverlays) {
    const grounded = moments
      .filter(
        (m) =>
          (m.effectType === "click-highlight" ||
            m.effectType === "cursor-focus" ||
            m.effectType === "zoom") &&
          (m.targetRegionSource === "click-event" || m.targetRegionSource === "ui-region") &&
          (m.confidenceScore ?? 0) >= 0.55
      )
      .sort((a, b) => (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0))
      .slice(0, 4);
    let i = 0;
    for (const g of grounded) {
      out.push(
        stamp(
          {
            id: `gen-callout-${i}`,
            startTime: g.startTime,
            endTime: Math.min(g.endTime, g.startTime + 2.5),
            label: "Callout",
            reason: "Draws the eye to the action.",
            focusRegion: { ...g.focusRegion },
            effectType: "callout",
            callout: {
              text: isDescriptive(g.label) ? g.label : "Here",
              style: "box",
            },
          },
          "callout",
          "Highlights an important interaction."
        )
      );
      i++;
    }
    if (i > 0) generated["callout"] = i;
  }

  // 5. Transitions — a short fade where active cuts resume (scene punctuation).
  if (enabled("transition") && !hasType("transition") && !userTouchedOverlays) {
    // Place the fade JUST AFTER the cut resumes — the pre-cut side is removed
    // time (never composed), so a straddling dip would render only half. A
    // fully-post-cut window gives a clean symmetric fade-in on visible frames.
    const cutEnds = moments
      .filter((m) => m.effectType === "cut" && m.cut?.active !== false)
      .map((m) => m.endTime)
      .filter((e) => e > 0.3 && e < duration - 0.5)
      .sort((a, b) => a - b)
      .slice(0, 5);
    let i = 0;
    for (const e of cutEnds) {
      out.push(
        stamp(
          {
            id: `gen-transition-${i}`,
            startTime: e,
            endTime: Math.min(duration, e + 0.4),
            label: "Transition",
            reason: "Softens a scene change.",
            focusRegion: FULL_REGION,
            effectType: "transition",
            transition: { style: "fade" },
          },
          "transition",
          "Smooths the cut."
        )
      );
      i++;
    }
    if (i > 0) generated["transition"] = i;
  }

  // 6. Smart crop — vertical/social reframe. Applied via the OUTPUT CANVAS (real
  // export), recorded as a full-span moment. Only when the recipe op names a
  // concrete social aspect AND the user hasn't chosen their own canvas.
  if (enabled("smart_crop") && !hasType("smart-crop") && !hasOutputCanvas) {
    const rawAspect = opParams("smart_crop")?.aspect;
    if (rawAspect === "9:16" || rawAspect === "1:1" || rawAspect === "16:9") {
      outputCanvas = canvasForAspect(rawAspect);
      smartCropAspect = rawAspect;
      const focusRaw = opParams("smart_crop")?.focus;
      const focusTarget =
        focusRaw === "face" ? "face" : focusRaw === "speaker" ? "face" : "motion";
      out.push(
        stamp(
          {
            id: "gen-smartcrop",
            startTime: 0,
            endTime: duration,
            label: `Smart crop ${rawAspect}`,
            reason: `Reframed to ${rawAspect} for social.`,
            focusRegion: FULL_REGION,
            effectType: "smart-crop",
            smartCrop: { aspectRatio: rawAspect, focusTarget },
          },
          "smart_crop",
          "Vertical reframe for social feeds."
        )
      );
      generated["smart-crop"] = 1;
    } else {
      skipped.push("smart_crop:no-aspect");
    }
  }

  return { moments: out, outputCanvas, log: { generated, skipped, smartCropAspect } };
}
