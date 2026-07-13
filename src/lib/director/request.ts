/**
 * AI Director — request parser.
 *
 * Turns the user's natural-language prompt + the panel's form controls into a
 * normalized `DirectorRequest`. The prompt is authoritative where it is explicit
 * ("make it 30 seconds", "for TikTok", "vertical") — a user who types a duration
 * shouldn't have to also change the dropdown — but the form always wins when the
 * prompt says nothing, so the controls are never decorative.
 *
 * Pure + dependency-free: the same parser runs in the browser (to preview what
 * the Director understood), on the server (to build the plan), and in tests.
 */
import {
  DIRECTOR_ASPECTS,
  DIRECTOR_CAPTION_STYLES,
  DIRECTOR_CTA_MODES,
  DIRECTOR_GOALS,
  DIRECTOR_PLATFORMS,
  DIRECTOR_STYLES,
  type DirectorAspect,
  type DirectorBrief,
  type DirectorCaptionStyle,
  type DirectorCtaMode,
  type DirectorGoal,
  type DirectorPlatform,
  type DirectorRequest,
  type DirectorStyle,
} from "./types";

/**
 * What the panel's controls supply. All optional — the prompt can carry it all.
 *
 * This IS the persisted brief's form, not a parallel copy of it: the controls the
 * user sets before analysis and the controls the Director panel sends are the
 * same set of controls, and letting the two shapes drift is how a field ends up
 * silently ignored on one of the two paths.
 */
export type DirectorRequestForm = DirectorBrief["form"];

/** Hard bounds — a "0 second" or "4 hour" target is a typo, not an instruction. */
export const MIN_TARGET_SECONDS = 5;
export const MAX_TARGET_SECONDS = 3600;

const PLATFORM_DEFAULT_ASPECT: Record<DirectorPlatform, DirectorAspect> = {
  tiktok: "9:16",
  reels: "9:16",
  shorts: "9:16",
  youtube: "16:9",
  linkedin: "1:1",
  x: "16:9",
  internal: "16:9",
};

function pick<T extends string>(
  v: unknown,
  values: readonly T[],
  fallback: T
): T {
  return typeof v === "string" && (values as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

function clampTarget(v: number | undefined): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(MAX_TARGET_SECONDS, Math.max(MIN_TARGET_SECONDS, Math.round(v)));
}

/**
 * Pull a duration out of free text. Handles the forms people actually type:
 * "45-second", "45 seconds", "45s", "make it 30 sec", "1:30", "2 minutes",
 * "a minute and a half", "under 60 seconds".
 *
 * Returns undefined when the text names no duration — the caller then falls back
 * to the form control, so silence never means "0 seconds".
 */
export function parseTargetDuration(text: string): number | undefined {
  const s = text.toLowerCase();

  // "1:30" / "01:30" — m:ss
  const clock = s.match(/\b(\d{1,2}):([0-5]\d)\b/);
  if (clock) {
    return clampTarget(Number(clock[1]) * 60 + Number(clock[2]));
  }

  // "a minute and a half" / "minute and a half"
  if (/\b(a\s+)?minute\s+and\s+a\s+half\b/.test(s)) return 90;

  // "90 seconds" / "90-second" / "90s" / "90 sec"
  const secs = s.match(/\b(\d{1,4})\s*[-\s]?\s*(seconds?|secs?|s)\b/);
  if (secs) return clampTarget(Number(secs[1]));

  // "2 minutes" / "2-minute" / "2 min" / "1.5 minutes"
  const mins = s.match(/\b(\d{1,3}(?:\.\d+)?)\s*[-\s]?\s*(minutes?|mins?|m)\b/);
  if (mins) return clampTarget(Number(mins[1]) * 60);

  return undefined;
}

/** Platform named in the prompt, if any. */
export function parsePlatform(text: string): DirectorPlatform | undefined {
  const s = text.toLowerCase();
  if (/\btik\s?tok\b/.test(s)) return "tiktok";
  if (/\b(instagram\s+)?reels?\b/.test(s)) return "reels";
  if (/\b(yt\s+|youtube\s+)?shorts?\b/.test(s)) return "shorts";
  if (/\byoutube\b/.test(s)) return "youtube";
  if (/\blinked\s?in\b/.test(s)) return "linkedin";
  if (/\b(twitter|x\.com)\b/.test(s)) return "x";
  return undefined;
}

/** Aspect named in the prompt, if any. */
export function parseAspect(text: string): DirectorAspect | undefined {
  const s = text.toLowerCase();
  if (/\b9:16\b/.test(s) || /\bvertical\b/.test(s) || /\bportrait\b/.test(s)) return "9:16";
  if (/\b1:1\b/.test(s) || /\bsquare\b/.test(s)) return "1:1";
  if (/\b4:5\b/.test(s)) return "4:5";
  if (/\b16:9\b/.test(s) || /\bhorizontal\b/.test(s) || /\blandscape\b/.test(s)) return "16:9";
  return undefined;
}

/** Editing style named in the prompt, if any. */
export function parseStyle(text: string): DirectorStyle | undefined {
  const s = text.toLowerCase();
  if (/\b(energetic|punchy|fast|snappy|hype|high[- ]energy)\b/.test(s)) return "energetic";
  if (/\b(professional|corporate|business|polished|formal)\b/.test(s)) return "professional";
  if (/\b(calm|relaxed|gentle|slow)\b/.test(s)) return "calm";
  if (/\b(cinematic|dramatic|filmic)\b/.test(s)) return "cinematic";
  if (/\b(minimal|clean|understated|simple)\b/.test(s)) return "minimal";
  return undefined;
}

/** Goal named in the prompt, if any. */
export function parseGoal(text: string): DirectorGoal | undefined {
  const s = text.toLowerCase();
  if (/\b(product\s+demo|demo|walkthrough|showcase)\b/.test(s)) return "product-demo";
  if (/\b(tutorial|how[- ]to|teach|lesson|guide)\b/.test(s)) return "tutorial";
  if (/\b(clips?|social\s+clips?|shorts?|highlights?)\b/.test(s)) return "social-clips";
  if (/\b(promo|ad|advert|commercial|trailer)\b/.test(s)) return "promo";
  if (/\b(clean\s*(up|it)?|tidy|polish|improve|tighten)\b/.test(s)) return "clean-up";
  return undefined;
}

/** CTA intent in the prompt. Explicit "no CTA" must beat the default. */
export function parseCta(text: string): DirectorCtaMode | undefined {
  const s = text.toLowerCase();
  if (/\b(no|without|skip|don'?t\s+(add|include))\b[^.]{0,20}\b(cta|call[- ]to[- ]action|end\s?card)\b/.test(s)) {
    return "never";
  }
  if (/\b(cta|call[- ]to[- ]action|end\s?card|finish\s+with|end\s+with)\b/.test(s)) return "always";
  return undefined;
}

/** Caption intent in the prompt. */
export function parseCaptionStyle(text: string): DirectorCaptionStyle | undefined {
  const s = text.toLowerCase();
  if (/\b(no|without|skip)\b[^.]{0,20}\bcaptions?\b/.test(s)) return "none";
  if (!/\b(captions?|subtitles?)\b/.test(s)) return undefined;
  if (/\b(energetic|bold|punchy|social|hype)\b/.test(s)) return "bold_social";
  if (/\b(professional|clean|corporate|business)\b/.test(s)) return "clean";
  if (/\bminimal\b/.test(s)) return "minimal";
  if (/\bpodcast\b/.test(s)) return "podcast";
  if (/\btutorial\b/.test(s)) return "tutorial";
  return "clean";
}

/**
 * Build the normalized request.
 *
 * Precedence: an EXPLICIT signal in the prompt beats the form control, because a
 * user who writes "make it vertical for TikTok" has clearly stated their intent
 * and shouldn't be overridden by a dropdown they never touched. The form is the
 * fallback for everything the prompt leaves unsaid.
 *
 * The one exception is `aspectRatio`: if neither the prompt nor the form names
 * one, it is derived from the platform (TikTok ⇒ 9:16), which is what the user
 * means every time.
 */
export function parseDirectorRequest(
  prompt: string,
  form: DirectorRequestForm = {}
): DirectorRequest {
  const text = (prompt ?? "").trim();

  const goal: DirectorGoal =
    parseGoal(text) ?? pick(form.goal, DIRECTOR_GOALS, text ? "custom" : "clean-up");

  const platform: DirectorPlatform =
    parsePlatform(text) ?? pick(form.platform, DIRECTOR_PLATFORMS, "youtube");

  // Prompt → form → platform default. Never left unset: the executor needs a
  // concrete aspect to build an OutputCanvas from.
  const aspectRatio: DirectorAspect =
    parseAspect(text) ??
    (form.aspectRatio && (DIRECTOR_ASPECTS as readonly string[]).includes(form.aspectRatio)
      ? form.aspectRatio
      : PLATFORM_DEFAULT_ASPECT[platform]);

  const style: DirectorStyle =
    parseStyle(text) ?? pick(form.style, DIRECTOR_STYLES, "professional");

  const captionStyle: DirectorCaptionStyle =
    parseCaptionStyle(text) ??
    pick(form.captionStyle, DIRECTOR_CAPTION_STYLES, styleToCaption(style));

  const cta: DirectorCtaMode =
    parseCta(text) ?? pick(form.cta, DIRECTOR_CTA_MODES, "auto");

  const targetDurationSeconds =
    parseTargetDuration(text) ?? clampTarget(form.targetDurationSeconds);

  const ctaText = (form.ctaText ?? "").trim() || undefined;

  return {
    prompt: text,
    goal,
    platform,
    ...(targetDurationSeconds !== undefined ? { targetDurationSeconds } : {}),
    aspectRatio,
    style,
    captionStyle,
    cta,
    ...(ctaText ? { ctaText } : {}),
  };
}

/** A sensible caption look for an editing style, when the user didn't say. */
function styleToCaption(style: DirectorStyle): DirectorCaptionStyle {
  switch (style) {
    case "energetic":
      return "bold_social";
    case "professional":
      return "clean";
    case "minimal":
      return "minimal";
    case "calm":
    case "cinematic":
    default:
      return "clean";
  }
}

/**
 * Stable hash of the request + the source it applies to. Two identical
 * "Direct my video" clicks produce the same hash → the run is treated as a
 * re-apply of the same plan rather than a second set of duplicate edits.
 *
 * FNV-1a: tiny, dependency-free, and browser-safe (same choice as
 * clip-export-status.ts:stableHash).
 */
export function hashDirectorRequest(
  request: DirectorRequest,
  sourceFingerprint: string
): string {
  const canonical = JSON.stringify([
    request.prompt,
    request.goal,
    request.platform,
    request.targetDurationSeconds ?? null,
    request.aspectRatio,
    request.style,
    request.captionStyle,
    request.cta,
    request.ctaText ?? null,
    sourceFingerprint,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
