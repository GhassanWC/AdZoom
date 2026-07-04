/**
 * Script-aware text style resolver — the SHARED brain for multilingual caption /
 * hook / text-overlay / callout / CTA rendering. Pure + framework-neutral (no
 * imports) so the ONE canvas renderer (overlay-draw.ts) — used identically by
 * preview, the browser export, the @napi-rs/canvas server worker, and Remotion/
 * Chromium — resolves font + direction the same way everywhere. Also feeds the
 * server font-availability diagnostic. This is a GENERAL system, not an
 * Arabic-specific patch.
 *
 * It answers two questions from the TEXT ITSELF (never from the ASR language):
 *   1. Which Unicode script dominates → which font family to request.
 *   2. Which base direction (LTR/RTL) → set ctx.direction; the canvas text engine
 *      then does Unicode shaping + bidi reordering for mixed text/numbers/URLs.
 *      We NEVER reverse strings manually.
 */

export type TextScript =
  | "latin"
  | "cyrillic"
  | "greek"
  | "arabic"
  | "hebrew"
  | "devanagari"
  | "cjk"
  | "thai"
  | "unknown";

export type TextDirection = "ltr" | "rtl";

/** Right-to-left scripts (base direction rtl). */
const RTL_SCRIPTS: ReadonlySet<TextScript> = new Set<TextScript>(["arabic", "hebrew"]);

export function isRtlScript(script: TextScript): boolean {
  return RTL_SCRIPTS.has(script);
}

/** Classify a single Unicode code point to a script bucket (null = neutral: digits, punctuation, spaces, emoji, symbols). */
function scriptOfCodePoint(cp: number): TextScript | null {
  // Latin (basic + Latin-1 letters + extended)
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return "latin";
  if ((cp >= 0xc0 && cp <= 0x24f) || (cp >= 0x1e00 && cp <= 0x1eff)) return "latin";
  // Greek (incl. extended)
  if ((cp >= 0x370 && cp <= 0x3ff) || (cp >= 0x1f00 && cp <= 0x1fff)) return "greek";
  // Cyrillic
  if ((cp >= 0x400 && cp <= 0x52f) || (cp >= 0x1c80 && cp <= 0x1c8f) || (cp >= 0x2de0 && cp <= 0x2dff)) return "cyrillic";
  // Hebrew (block + presentation forms)
  if ((cp >= 0x590 && cp <= 0x5ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) return "hebrew";
  // Arabic (block + supplement + extended-A + presentation forms A/B)
  if (
    (cp >= 0x600 && cp <= 0x6ff) ||
    (cp >= 0x750 && cp <= 0x77f) ||
    (cp >= 0x8a0 && cp <= 0x8ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  )
    return "arabic";
  // Devanagari (+ extended)
  if ((cp >= 0x900 && cp <= 0x97f) || (cp >= 0xa8e0 && cp <= 0xa8ff)) return "devanagari";
  // Thai
  if (cp >= 0xe00 && cp <= 0xe7f) return "thai";
  // CJK — Han (unified + ext A/B–F + compat), kana, Hangul (syllables + jamo)
  if (
    (cp >= 0x3040 && cp <= 0x30ff) || // hiragana + katakana
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul compatibility jamo
    (cp >= 0x31f0 && cp <= 0x31ff) || // katakana phonetic extensions
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
    (cp >= 0xff65 && cp <= 0xff9f) || // halfwidth katakana
    (cp >= 0x20000 && cp <= 0x2ebef) // CJK ext B–F (astral)
  )
    return "cjk";
  return null;
}

/**
 * Analyze a string's writing system + base direction:
 *   • `script`    — the DOMINANT script (most letters wins). Drives font choice,
 *                   so a mostly-Arabic caption gets the Arabic font even with an
 *                   embedded English word.
 *   • `direction` — the base paragraph direction by the Unicode Bidi Algorithm's
 *                   FIRST-STRONG rule (UAX#9 P2/P3): the first strong-directional
 *                   letter sets it. So "شاهد example.com الآن" is RTL (first letter
 *                   is Arabic) even though it has more Latin letters, and
 *                   "watch الآن clip" is LTR. Neutral-only text (numbers / URLs /
 *                   emoji) has no strong char → LTR. The canvas engine then
 *                   reorders the mixed runs correctly under this base.
 * Neutral characters (digits, punctuation, spaces, emoji, symbols) don't vote.
 */
export function analyzeText(text: string): {
  script: TextScript;
  direction: TextDirection;
  rtlCount: number;
  ltrCount: number;
} {
  let rtlCount = 0;
  let ltrCount = 0;
  let firstStrong: TextDirection | null = null;
  const counts: Record<TextScript, number> = {
    latin: 0, cyrillic: 0, greek: 0, arabic: 0, hebrew: 0, devanagari: 0, cjk: 0, thai: 0, unknown: 0,
  };
  // Array.from → iterate by code point (surrogate-pair safe for CJK astral + emoji).
  for (const ch of Array.from(text ?? "")) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const s = scriptOfCodePoint(cp);
    if (!s) continue;
    counts[s]++;
    const rtl = RTL_SCRIPTS.has(s);
    if (rtl) rtlCount++;
    else ltrCount++;
    if (firstStrong === null) firstStrong = rtl ? "rtl" : "ltr";
  }
  let script: TextScript = "unknown";
  let best = 0;
  for (const s of Object.keys(counts) as TextScript[]) {
    if (s === "unknown") continue;
    if (counts[s] > best) {
      best = counts[s];
      script = s;
    }
  }
  // First-strong base direction (UAX#9); no strong char → ltr.
  const direction: TextDirection = firstStrong ?? "ltr";
  return { script, direction, rtlCount, ltrCount };
}

export function detectScript(text: string): TextScript {
  return analyzeText(text).script;
}

export function textDirection(text: string): TextDirection {
  return analyzeText(text).direction;
}

// ── Font families ────────────────────────────────────────────────────────────
// One CSS/canvas font-family STACK per script: the script's Noto family first,
// then platform system fallbacks, an emoji family, and a generic. The same string
// works for ctx.font (canvas) and CSS. Server images install the Noto families;
// browsers fall back to the platform font when Noto is absent.

const EMOJI_FALLBACK = `"Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"`;
const LATIN_BASE = `"Noto Sans", -apple-system, "Segoe UI", system-ui, "Liberation Sans", Arial`;

export const FONT_FAMILY_BY_SCRIPT: Record<TextScript, string> = {
  latin: `${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  cyrillic: `${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  greek: `${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  unknown: `${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  arabic: `"Noto Sans Arabic", "Noto Naskh Arabic", "Geeza Pro", "Segoe UI", Tahoma, ${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  hebrew: `"Noto Sans Hebrew", "Segoe UI", ${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  devanagari: `"Noto Sans Devanagari", "Nirmala UI", "Segoe UI", ${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  cjk: `"Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR", "Microsoft YaHei", "Yu Gothic", "Malgun Gothic", ${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
  thai: `"Noto Sans Thai", "Leelawadee UI", "Segoe UI", ${LATIN_BASE}, ${EMOJI_FALLBACK}, sans-serif`,
};

export interface ResolvedTextStyle {
  script: TextScript;
  direction: TextDirection;
  /** CSS/canvas font-family list to request for this text's script. */
  fontFamily: string;
}

/** Resolve font family + base direction for a string, from its own script. */
export function resolveTextStyle(text: string): ResolvedTextStyle {
  const { script, direction } = analyzeText(text);
  return { script, direction, fontFamily: FONT_FAMILY_BY_SCRIPT[script] };
}

/**
 * The PRIMARY font family each officially-supported script needs at runtime — the
 * shared source of truth for the server font-availability diagnostic (each export
 * runtime supplies an `isAvailable(family)` probe). Latin/Cyrillic/Greek share
 * "Noto Sans"; emoji is a cross-cutting extra.
 */
export const REQUIRED_SCRIPT_FONTS: ReadonlyArray<{ scripts: TextScript[]; family: string }> = [
  { scripts: ["latin", "cyrillic", "greek", "unknown"], family: "Noto Sans" },
  { scripts: ["arabic"], family: "Noto Sans Arabic" },
  { scripts: ["hebrew"], family: "Noto Sans Hebrew" },
  { scripts: ["devanagari"], family: "Noto Sans Devanagari" },
  { scripts: ["cjk"], family: "Noto Sans CJK SC" },
  { scripts: ["thai"], family: "Noto Sans Thai" },
];

/** Color-emoji family — checked but OPTIONAL (its absence never fails `ok`). */
export const EMOJI_FONT_FAMILY = "Noto Color Emoji";

export interface FontDiagnostic {
  ok: boolean;
  available: string[];
  missing: { family: string; scripts: TextScript[] }[];
  /** Emoji font present? Reported separately — its absence does NOT fail `ok`. */
  emojiAvailable: boolean;
}

/**
 * Given a runtime family-availability probe, report which required script fonts
 * are present vs missing. Runtime-agnostic: the caller passes `has` (e.g.
 * @napi-rs/canvas `GlobalFonts.has` on the server, `document.fonts.check` in the
 * browser). The emoji font IS probed (`emojiAvailable`) so a fontless image can
 * warn, but — being optional — it never marks the run "not ok".
 */
export function checkFontAvailability(has: (family: string) => boolean): FontDiagnostic {
  const available: string[] = [];
  const missing: { family: string; scripts: TextScript[] }[] = [];
  for (const { family, scripts } of REQUIRED_SCRIPT_FONTS) {
    if (has(family)) available.push(family);
    else missing.push({ family, scripts });
  }
  const emojiAvailable = has(EMOJI_FONT_FAMILY);
  if (emojiAvailable) available.push(EMOJI_FONT_FAMILY);
  return { ok: missing.length === 0, available, missing, emojiAvailable };
}
