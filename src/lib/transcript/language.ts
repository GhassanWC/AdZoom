/**
 * Transcript spoken-language model — the single source of truth for the
 * languages Framevo can transcribe, the RTL set, and the language-precedence /
 * Auto-Detect-candidate logic. Pure (type-only imports) so it's unit-testable
 * and shared by the Analyze dialog, the analysis route, and the ASR worker.
 *
 * PRODUCT RULE: Framevo transcribes speech in the language ACTUALLY SPOKEN. It
 * never translates to English. `TRANSCRIPT_LANGUAGE` is only a LAST-resort server
 * fallback and must NEVER override the user's explicit selection.
 */

export type TranscriptLanguageMode = "auto" | "selected";

export interface TranscriptLanguageOption {
  /** BCP-47 code sent to the ASR provider. */
  code: string;
  /** Human label for the picker. */
  label: string;
  /** Right-to-left script → captions render RTL. */
  rtl?: boolean;
}

/**
 * Supported spoken languages (searchable list). NOT exhaustive of what the
 * provider accepts — add more freely; the architecture is code-driven, not
 * limited to these. Arabic (Oman) = ar-OM is present for Oman users.
 */
export const TRANSCRIPT_LANGUAGES: readonly TranscriptLanguageOption[] = [
  { code: "en-US", label: "English (United States)" },
  { code: "en-GB", label: "English (United Kingdom)" },
  { code: "ar-OM", label: "Arabic (Oman)", rtl: true },
  { code: "ar-SA", label: "Arabic (Saudi Arabia)", rtl: true },
  { code: "ar-AE", label: "Arabic (United Arab Emirates)", rtl: true },
  { code: "ar-EG", label: "Arabic (Egypt)", rtl: true },
  { code: "ar-QA", label: "Arabic (Qatar)", rtl: true },
  { code: "ar-KW", label: "Arabic (Kuwait)", rtl: true },
  { code: "ar-BH", label: "Arabic (Bahrain)", rtl: true },
  { code: "ar-JO", label: "Arabic (Jordan)", rtl: true },
  { code: "ar-LB", label: "Arabic (Lebanon)", rtl: true },
  { code: "ar-MA", label: "Arabic (Morocco)", rtl: true },
  { code: "fr-FR", label: "French" },
  { code: "es-ES", label: "Spanish" },
  { code: "de-DE", label: "German" },
  { code: "it-IT", label: "Italian" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "hi-IN", label: "Hindi" },
  { code: "ur-PK", label: "Urdu", rtl: true },
  { code: "fa-IR", label: "Persian", rtl: true },
  { code: "tr-TR", label: "Turkish" },
  { code: "ru-RU", label: "Russian" },
  { code: "ja-JP", label: "Japanese" },
  { code: "ko-KR", label: "Korean" },
  { code: "cmn-Hans-CN", label: "Chinese (Mandarin, Simplified)" },
  { code: "id-ID", label: "Indonesian" },
  { code: "nl-NL", label: "Dutch" },
];

const RTL_LANG_PREFIXES = new Set(["ar", "he", "iw", "fa", "ur", "ps", "sd", "ug", "yi", "dv"]);

/** Bare language subtag of a BCP-47 code ("ar-OM" → "ar"). */
export function languageSubtag(code: string | null | undefined): string {
  return (code ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
}

/** True when a BCP-47 code (or bare language) is a right-to-left script. */
export function isRtlLanguage(code: string | null | undefined): boolean {
  return RTL_LANG_PREFIXES.has(languageSubtag(code));
}

/** Human label for a code — exact match, else by language subtag, else the code. */
export function transcriptLanguageLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const lc = code.toLowerCase();
  const exact = TRANSCRIPT_LANGUAGES.find((l) => l.code.toLowerCase() === lc);
  if (exact) return exact.label;
  const sub = languageSubtag(code);
  const byPrefix = TRANSCRIPT_LANGUAGES.find((l) => languageSubtag(l.code) === sub);
  return byPrefix ? byPrefix.label : code;
}

/** Google Speech v1 accepts at most 3 `alternativeLanguageCodes`; keep the set tiny. */
export const MAX_ALT_LANGUAGE_CODES = 3;

export interface ResolvedTranscriptLanguage {
  mode: TranscriptLanguageMode;
  /** Primary BCP-47 sent as `RecognitionConfig.languageCode`. */
  languageCode: string;
  /** Auto-Detect candidates (v1 `alternativeLanguageCodes`). Empty in selected mode. */
  alternativeLanguageCodes: string[];
}

export interface ResolveLanguageInput {
  /** The run's chosen mode (default "auto"). */
  mode?: TranscriptLanguageMode | null;
  /** The user-selected BCP-47 (selected mode). */
  selectedCode?: string | null;
  /** Prior COMPLETE transcript's confirmed language (only when the source is unchanged). */
  priorLanguage?: string | null;
  /** App/project or browser locale (a strong Auto-Detect signal). */
  locale?: string | null;
  /** Server env fallback (TRANSCRIPT_LANGUAGE) — LAST resort, never overrides selection. */
  envFallback?: string | null;
}

/**
 * Map a locale/language to a supported regioned BCP-47 when unambiguous. A bare
 * "ar" → the first supported Arabic (ar-OM here); a regioned code passes through.
 */
function toSupportedBcp47(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.trim();
  if (!c) return null;
  if (c.includes("-")) return c; // already regioned — use verbatim
  const sub = c.toLowerCase();
  const match = TRANSCRIPT_LANGUAGES.find((l) => languageSubtag(l.code) === sub);
  return match ? match.code : c;
}

/**
 * Resolve the language config for a run. Precedence (product spec §3):
 *   1. User-selected spoken language (mode="selected")
 *   2. Previously confirmed transcript language (unchanged source)
 *   3. Auto-detection — a SMALL candidate list from locale + prior + env
 *   4. TRANSCRIPT_LANGUAGE env (final server fallback)
 *   5. en-US (only if nothing else is available)
 * TRANSCRIPT_LANGUAGE NEVER overrides an explicit selection. Kept tiny because
 * too many candidates reduce Google v1 detection reliability.
 */
export function resolveTranscriptLanguage(input: ResolveLanguageInput): ResolvedTranscriptLanguage {
  const mode: TranscriptLanguageMode = input.mode === "selected" ? "selected" : "auto";

  // 1. Explicit selection wins outright — no alternatives, no env override.
  if (mode === "selected" && input.selectedCode?.trim()) {
    return { mode: "selected", languageCode: input.selectedCode.trim(), alternativeLanguageCodes: [] };
  }

  // Auto-Detect: build a small, high-signal candidate list. The FIRST is the
  // primary `languageCode`; the rest become `alternativeLanguageCodes` (v1 limit).
  const candidates: string[] = [];
  const push = (c?: string | null) => {
    const v = toSupportedBcp47(c);
    if (v && !candidates.some((x) => x.toLowerCase() === v.toLowerCase())) candidates.push(v);
  };
  push(input.priorLanguage); // 2. confirmed language for the unchanged source
  push(input.locale); // 3. app/project/browser locale
  push(input.envFallback); // 4. env fallback
  push("en-US"); // 5. last resort

  const languageCode = candidates[0] ?? "en-US";
  const alternativeLanguageCodes = candidates
    .slice(1)
    .filter((c) => c.toLowerCase() !== languageCode.toLowerCase())
    .slice(0, MAX_ALT_LANGUAGE_CODES);
  return { mode: "auto", languageCode, alternativeLanguageCodes };
}

/**
 * Cheap heuristic: does `text` look like it's in the expected language's script?
 * Only distinguishes Arabic-script vs Latin-script (the reported failure mode:
 * Arabic audio → English words). Returns `null` (no opinion) for scripts we don't
 * check. Used for the "wrong language?" warning — NEVER to translate.
 */
export function transcriptScriptMatchesLanguage(
  text: string | null | undefined,
  languageCode: string | null | undefined
): boolean | null {
  const t = (text ?? "").trim();
  if (!t || !languageCode) return null;
  const arabicChars = (t.match(/[؀-ۿݐ-ݿࢠ-ࣿ]/g) ?? []).length;
  const latinChars = (t.match(/[A-Za-z]/g) ?? []).length;
  const total = arabicChars + latinChars;
  if (total < 8) return null; // too little signal
  const expectRtl = isRtlLanguage(languageCode);
  const arabicShare = arabicChars / total;
  if (expectRtl) return arabicShare >= 0.5; // Arabic expected → should be mostly Arabic script
  const sub = languageSubtag(languageCode);
  // Latin-script languages: flag when the text is dominated by Arabic script.
  if (["en", "fr", "es", "de", "it", "pt", "nl", "tr", "id"].includes(sub)) {
    return arabicShare <= 0.3;
  }
  return null;
}
