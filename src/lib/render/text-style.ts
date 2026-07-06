/**
 * text-style — the ONE shared text-styling model for every text-based edit in
 * Framevo (captions, hook text, text overlays, callouts, branding CTAs, and any
 * future text edit). Pure + DOM-free (type-only imports) so it's unit-testable
 * and safe to import from both the editor UI and the shared render core
 * (`overlay-draw.ts`), which means preview and every export path style text
 * IDENTICALLY by construction.
 *
 * Design:
 *   • `TextStyle` (schema) is the STORED shape — every field optional, so a doc
 *     only carries what the user actually changed (lean writes, no hash churn).
 *   • `TextStyleValues` is the RESOLVED shape — every field present, ready to
 *     draw. `resolveTextStyleValues(moment)` produces it by layering:
 *         DEFAULTS  ←  legacy-preset mapping  ←  moment.textStyle
 *     so (a) brand-new edits get sensible defaults, (b) OLD projects with only a
 *     `stylePreset`/`size` render sensibly (legacy mapping), and (c) any field
 *     the user set wins. No migration/backfill needed — defaults resolve at draw
 *     time AND at edit time (the inspector seeds from the same resolver).
 *
 * All sizes are RESOLUTION-INDEPENDENT fractions:
 *   • `fontScale`      — fraction of canvas height (the em size)
 *   • padding/stroke/shadow/letterSpacing — fractions of the resolved font size
 *   • `customX`/`customY` — 0..1 fractions of canvas width/height
 * so the same style renders proportionally at 720p preview and 1080p export.
 */
import type {
  BrandingCtaSettings,
  CaptionSettings,
  DetectedMoment,
  EffectType,
  HookTextSettings,
  OverlaySize,
  TextAlign,
  TextBgMode,
  TextFontFamily,
  TextOverlaySettings,
  TextStyle,
  TextStylePreset,
  TextVPosition,
} from "@/lib/firebase/schema";

export type {
  TextAlign,
  TextBgMode,
  TextFontFamily,
  TextStyle,
  TextStylePreset,
  TextVPosition,
} from "@/lib/firebase/schema";

/** RESOLVED text style — every field present (safe to draw directly). */
export type TextStyleValues = Required<TextStyle>;

// ── defaults ───────────────────────────────────────────────────────────────

/** The universal fallback for every field. Chosen to read well on video. */
export const DEFAULT_TEXT_STYLE: TextStyleValues = {
  preset: "clean",
  fontFamily: "auto",
  fontScale: 0.05,
  fontWeight: 600,
  color: "#ffffff",
  textOpacity: 1,
  align: "center",
  uppercase: false,
  letterSpacing: 0,
  lineHeight: 1.25,
  background: "pill",
  backgroundColor: "#000000",
  backgroundOpacity: 0.55,
  paddingX: 0.55,
  paddingY: 0.28,
  borderRadius: 0.28,
  strokeColor: "#000000",
  strokeWidth: 0,
  shadow: true,
  shadowColor: "#000000",
  shadowBlur: 0.28,
  shadowOpacity: 0.6,
  shadowOffsetX: 0,
  shadowOffsetY: 0.05,
  position: "bottom",
  customX: 0.5,
  customY: 0.82,
};

// ── color helpers (pure) ─────────────────────────────────────────────────────

/** Clamp to [0,1]. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Parse `#rgb` / `#rrggbb` → {r,g,b}. Falls back to black on anything else. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const s = (hex ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return { r: 0, g: 0, b: 0 };
}

/** Compose a canvas `rgba(...)` string from a hex color + 0..1 opacity. */
export function rgba(hex: string, opacity: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${clamp01(opacity).toFixed(3)})`;
}

/** Parse `rgba(r,g,b,a)` / `rgb(r,g,b)` → {hex, opacity}. Used to migrate the
 *  legacy preset tables (which stored composite rgba strings) into the split
 *  hex-color + opacity model. Falls back to opaque black. */
export function rgbaToHexOpacity(str: string): { hex: string; opacity: number } {
  const m = (str ?? "").match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i
  );
  if (!m) return { hex: "#000000", opacity: 1 };
  const to2 = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  const hex = `#${to2(+m[1])}${to2(+m[2])}${to2(+m[3])}`;
  const opacity = m[4] === undefined ? 1 : clamp01(parseFloat(m[4]));
  return { hex, opacity };
}

// ── font-family resolution ───────────────────────────────────────────────────

/**
 * Build the CSS `font-family` value for a chosen family. Every non-`auto` stack
 * ENDS in `scriptStack` (the script-aware Noto stack from `text-shaping`) so a
 * serif/mono choice still falls back to a glyph-complete font for Arabic / CJK /
 * etc. Both the browser and the server canvas resolve these consistently.
 */
export function fontFamilyStack(family: TextFontFamily, scriptStack: string): string {
  switch (family) {
    case "serif":
      return `"Noto Serif", Georgia, "Times New Roman", ${scriptStack}`;
    case "mono":
      return `"Noto Sans Mono", "Liberation Mono", "Courier New", ${scriptStack}`;
    case "sans":
    case "auto":
    default:
      return scriptStack;
  }
}

// ── style presets ────────────────────────────────────────────────────────────

/**
 * Starting-point presets. Each is a PARTIAL that populates styling values only —
 * NOT position/customX/customY/align (those stay under the user's control per
 * the product spec). After applying, every value remains manually editable.
 */
export const TEXT_STYLE_PRESETS: Record<TextStylePreset, Partial<TextStyle>> = {
  clean: {
    fontWeight: 600,
    fontScale: 0.05,
    color: "#ffffff",
    uppercase: false,
    letterSpacing: 0,
    background: "pill",
    backgroundColor: "#000000",
    backgroundOpacity: 0.55,
    strokeWidth: 0,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 0.28,
    shadowOpacity: 0.55,
    shadowOffsetX: 0,
    shadowOffsetY: 0.05,
  },
  bold: {
    fontWeight: 800,
    fontScale: 0.06,
    color: "#ffffff",
    uppercase: true,
    letterSpacing: 0.01,
    background: "pill",
    backgroundColor: "#000000",
    backgroundOpacity: 0.35,
    strokeWidth: 0,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 0.3,
    shadowOpacity: 0.6,
    shadowOffsetX: 0,
    shadowOffsetY: 0.05,
  },
  minimal: {
    fontWeight: 600,
    fontScale: 0.046,
    color: "#ffffff",
    uppercase: false,
    letterSpacing: 0,
    background: "none",
    strokeWidth: 0,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 0.22,
    shadowOpacity: 0.5,
    shadowOffsetX: 0,
    shadowOffsetY: 0.04,
  },
  neon: {
    fontWeight: 800,
    fontScale: 0.058,
    color: "#c4b5fd",
    uppercase: true,
    letterSpacing: 0.02,
    background: "none",
    strokeWidth: 0,
    shadow: true,
    shadowColor: "#8b5cf6",
    shadowBlur: 0.55,
    shadowOpacity: 0.85,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  },
  shadow: {
    fontWeight: 800,
    fontScale: 0.056,
    color: "#ffffff",
    uppercase: false,
    letterSpacing: 0,
    background: "none",
    strokeWidth: 0,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 0.5,
    shadowOpacity: 0.9,
    shadowOffsetX: 0.02,
    shadowOffsetY: 0.06,
  },
};

/** Apply a preset ON TOP of an existing (possibly partial) style, recording the
 *  preset name. Position/align are preserved from `base`. */
export function applyTextStylePreset(base: TextStyle, preset: TextStylePreset): TextStyle {
  return { ...base, ...TEXT_STYLE_PRESETS[preset], preset };
}

// ── legacy mapping (old preset-only bags → TextStyle) ────────────────────────

/** Old caption presets (from the pre-TextStyle render core) as split values. */
const LEGACY_CAPTION: Record<CaptionSettings["stylePreset"], Partial<TextStyle>> = {
  clean: { fontWeight: 600, fontScale: 0.05, background: "pill", backgroundColor: "#000000", backgroundOpacity: 0.55, shadow: true, uppercase: false },
  bold_social: { fontWeight: 800, fontScale: 0.062, background: "pill", backgroundColor: "#000000", backgroundOpacity: 0.35, shadow: true, uppercase: true },
  minimal: { fontWeight: 600, fontScale: 0.045, background: "none", shadow: true, uppercase: false },
  podcast: { fontWeight: 700, fontScale: 0.052, background: "pill", backgroundColor: "#0c0a18", backgroundOpacity: 0.72, shadow: false, uppercase: false },
  tutorial: { fontWeight: 600, fontScale: 0.046, background: "pill", backgroundColor: "#000000", backgroundOpacity: 0.6, shadow: false, uppercase: false },
};

const LEGACY_HOOK: Record<HookTextSettings["stylePreset"], Partial<TextStyle>> = {
  bold: { fontWeight: 900, fontScale: 0.085, color: "#ffffff", background: "none", shadow: true, uppercase: true, shadowColor: "#000000", shadowOpacity: 0.65, shadowBlur: 0.4 },
  minimal: { fontWeight: 700, fontScale: 0.07, color: "#ffffff", background: "none", shadow: true, uppercase: false, shadowColor: "#000000", shadowOpacity: 0.65, shadowBlur: 0.4 },
  neon: { fontWeight: 900, fontScale: 0.085, color: "#c4b5fd", background: "none", shadow: true, uppercase: true, shadowColor: "#8b5cf6", shadowOpacity: 0.7, shadowBlur: 0.4 },
  shadow: { fontWeight: 800, fontScale: 0.08, color: "#ffffff", background: "pill", backgroundColor: "#000000", backgroundOpacity: 0.4, shadow: true, uppercase: false, shadowColor: "#000000", shadowOpacity: 0.65, shadowBlur: 0.4 },
};

const LEGACY_OVERLAY_SIZE: Record<OverlaySize, number> = {
  small: 0.032,
  medium: 0.045,
  large: 0.06,
};

const LEGACY_CTA: Record<BrandingCtaSettings["stylePreset"], { color: string; bg: string; bgOpacity: number }> = {
  minimal: { color: "#0a0a12", bg: "#ffffff", bgOpacity: 0.92 },
  creator: { color: "#ffffff", bg: "#8b5cf6", bgOpacity: 0.95 },
  business: { color: "#ffffff", bg: "#2563eb", bgOpacity: 0.95 },
  social: { color: "#ffffff", bg: "#ec4899", bgOpacity: 0.95 },
};

/** Map a 9-grid text-overlay position → (vertical position, horizontal align). */
function overlayPositionToAnchor(pos: TextOverlaySettings["position"]): {
  position: TextVPosition;
  align: TextAlign;
} {
  if (pos === "custom") return { position: "custom", align: "center" };
  const [v, h] = pos.split("-");
  const position: TextVPosition = v === "top" ? "top" : v === "bottom" ? "bottom" : "center";
  const align: TextAlign = h === "left" ? "left" : h === "right" ? "right" : "center";
  return { position, align };
}

/**
 * Derive a partial TextStyle from a moment's LEGACY (pre-TextStyle) settings bag,
 * so old projects render sensibly before the user touches anything. Returns `{}`
 * for non-text effects or when no legacy bag is present.
 */
export function legacyTextStyle(moment: DetectedMoment): Partial<TextStyle> {
  switch (moment.effectType) {
    case "captions": {
      const c = moment.captions;
      if (!c) return {};
      return {
        ...LEGACY_CAPTION[c.stylePreset],
        color: "#ffffff",
        align: "center",
        position: c.position === "custom" ? "bottom" : c.position,
        lineHeight: 1.25,
        paddingX: 0.55,
        paddingY: 0.28,
        borderRadius: 0.28,
        shadowOffsetY: 0.05,
      };
    }
    case "hook-text": {
      const h = moment.hookText;
      if (!h) return {};
      return {
        ...LEGACY_HOOK[h.stylePreset],
        align: "center",
        position: h.position,
        lineHeight: 1.16,
        paddingX: 0.5,
        paddingY: 0.24,
        borderRadius: 0.25,
      };
    }
    case "text-overlay": {
      const t = moment.textOverlay;
      if (!t) return {};
      const anchor = overlayPositionToAnchor(t.position);
      const bg: TextBgMode =
        t.backgroundStyle === "pill" ? "pill" : t.backgroundStyle === "box" ? "box" : "none";
      return {
        fontWeight: 700,
        fontScale: LEGACY_OVERLAY_SIZE[t.size] ?? 0.045,
        color: "#ffffff",
        align: t.alignment ?? anchor.align,
        position: anchor.position,
        background: bg,
        backgroundColor: "#0a0a10",
        backgroundOpacity: 0.72,
        lineHeight: 1.28,
        paddingX: 0.5,
        paddingY: 0.32,
        borderRadius: 0.24,
        // Legacy "shadow" background style → a real drop shadow.
        shadow: t.backgroundStyle === "shadow",
        shadowColor: "#000000",
        shadowOpacity: 0.7,
        shadowBlur: 0.35,
        shadowOffsetY: 0.06,
      };
    }
    case "branding-cta": {
      const cta = moment.brandingCta;
      if (!cta) return {};
      const accent = LEGACY_CTA[cta.stylePreset] ?? LEGACY_CTA.creator;
      return {
        fontWeight: 800,
        fontScale: 0.036,
        color: accent.color,
        align: "center",
        background: "pill",
        backgroundColor: accent.bg,
        backgroundOpacity: accent.bgOpacity,
        paddingX: 0.9,
        paddingY: 0.55,
        shadow: false,
        uppercase: false,
        lineHeight: 1.2,
      };
    }
    case "callout": {
      return {
        fontWeight: 700,
        fontScale: 0.03,
        color: "#ffffff",
        align: "center",
        background: "pill",
        backgroundColor: "#8b5cf6",
        backgroundOpacity: 0.95,
        shadow: false,
        uppercase: false,
        paddingX: 0.6,
        paddingY: 0.4,
      };
    }
    default:
      return {};
  }
}

/** Text effect types that carry a TextStyle. */
const TEXT_EFFECTS: ReadonlySet<EffectType> = new Set<EffectType>([
  "captions",
  "hook-text",
  "text-overlay",
  "callout",
  "branding-cta",
]);

export function isTextEffectType(t: EffectType): boolean {
  return TEXT_EFFECTS.has(t);
}

/**
 * Resolve a moment's full, ready-to-draw text style by layering:
 *   DEFAULT_TEXT_STYLE  ←  legacy-preset mapping  ←  moment.textStyle
 * Every field is guaranteed present. The SAME resolver feeds the render core
 * (preview + export) and the inspector, so what you edit is what renders.
 */
export function resolveTextStyleValues(moment: DetectedMoment): TextStyleValues {
  return {
    ...DEFAULT_TEXT_STYLE,
    ...legacyTextStyle(moment),
    ...(moment.textStyle ?? {}),
  };
}

/**
 * Resolve for the INSPECTOR the same way, but return only the effective values
 * (identical to `resolveTextStyleValues`) — exposed separately so UI code reads
 * intent clearly. Kept as a thin alias to avoid divergence.
 */
export const resolveEditTextStyle = resolveTextStyleValues;
