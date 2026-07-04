/**
 * General multilingual text system — script detection, text-derived direction,
 * shared font resolution, font-availability diagnostic, and script-aware wrapping.
 * This is the GENERAL system (not an Arabic patch) shared by preview + every
 * export path via overlay-draw.ts.
 *
 * Run with:  npm test   (node --test; the resolver in tests/loader.mjs lets these
 * import the src modules by `@/…` / extensionless paths).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectScript,
  textDirection,
  analyzeText,
  resolveTextStyle,
  isRtlScript,
  checkFontAvailability,
  FONT_FAMILY_BY_SCRIPT,
  REQUIRED_SCRIPT_FONTS,
} from "@/lib/render/text-shaping";
import { wrapText } from "@/lib/render/overlay-draw";

// ── §7 multilingual fixtures — script detection ──────────────────────────────

const FIXTURES: Array<{ label: string; text: string; script: string; direction: "ltr" | "rtl" }> = [
  { label: "English", text: "Watch this amazing tutorial", script: "latin", direction: "ltr" },
  { label: "Spanish", text: "Mira este tutorial increíble", script: "latin", direction: "ltr" },
  { label: "Arabic", text: "شاهد هذا الفيديو الرائع الآن", script: "arabic", direction: "rtl" },
  { label: "Urdu", text: "یہ ویڈیو ابھی دیکھیں", script: "arabic", direction: "rtl" }, // Urdu uses Arabic script
  { label: "Hebrew", text: "צפו בסרטון המדהים הזה", script: "hebrew", direction: "rtl" },
  { label: "Hindi", text: "यह वीडियो अभी देखें", script: "devanagari", direction: "ltr" },
  { label: "Japanese", text: "この動画を今すぐ見て", script: "cjk", direction: "ltr" },
  { label: "Chinese", text: "立即观看这个视频", script: "cjk", direction: "ltr" },
  { label: "Cyrillic", text: "Посмотрите это видео", script: "cyrillic", direction: "ltr" },
  { label: "Greek", text: "Δείτε αυτό το βίντεο", script: "greek", direction: "ltr" },
  { label: "Thai", text: "ดูวิดีโอนี้เลย", script: "thai", direction: "ltr" },
];

test("§7 detectScript classifies every supported script", () => {
  for (const f of FIXTURES) {
    assert.equal(detectScript(f.text), f.script, `${f.label} → ${f.script}`);
  }
});

test("§3 textDirection is RTL only for RTL scripts, LTR otherwise", () => {
  for (const f of FIXTURES) {
    assert.equal(textDirection(f.text), f.direction, `${f.label} direction`);
  }
  assert.equal(isRtlScript("arabic"), true);
  assert.equal(isRtlScript("hebrew"), true);
  assert.equal(isRtlScript("latin"), false);
  assert.equal(isRtlScript("cjk"), false);
});

// ── §3 mixed direction, numbers, punctuation, English words, URLs, emoji ─────

test("§3 mixed-direction / numbers / punctuation / URLs / emoji resolve a sensible base direction", () => {
  // First-strong (UAX#9): an RTL-led caption stays RTL even when a Latin URL/word
  // has MORE letters (the majority-count bug this replaced would wrongly say ltr).
  assert.equal(textDirection("شاهد example.com الآن"), "rtl");
  assert.equal(textDirection("الآن example.com"), "rtl");
  assert.equal(textDirection("בית example.com שלום"), "rtl"); // Hebrew-led
  assert.equal(textDirection("شاهد الآن على example.com الحلقة 3"), "rtl");
  // Latin-led (first strong is English) → base LTR even with an Arabic word.
  assert.equal(textDirection("watch the الآن clip now please"), "ltr");
  // Neutral-only (numbers + punctuation + URL, no strong letters) → LTR default.
  assert.equal(textDirection("12,345 — https://framevo.app/watch?v=1"), "ltr");
  assert.equal(textDirection("🎬🔥✨ 100%"), "ltr");
  // Emoji + numbers don't vote for a script.
  const a = analyzeText("🎬 2024 —");
  assert.equal(a.script, "unknown");
  assert.equal(a.direction, "ltr");
});

// ── §2 shared font resolution (one resolver → preview + every export path) ───

test("§2 resolveTextStyle maps each script to its Noto family stack", () => {
  const cases: Array<[string, string]> = [
    ["Hello world", "Noto Sans"],
    ["مرحبا بالعالم", "Noto Sans Arabic"],
    ["שלום עולם", "Noto Sans Hebrew"],
    ["नमस्ते दुनिया", "Noto Sans Devanagari"],
    ["你好世界", "Noto Sans CJK"],
    ["สวัสดีชาวโลก", "Noto Sans Thai"],
  ];
  for (const [text, family] of cases) {
    const style = resolveTextStyle(text);
    assert.ok(style.fontFamily.includes(family), `${text} → family stack includes ${family} (got ${style.fontFamily})`);
    // Every stack carries an emoji fallback + a generic terminator.
    assert.ok(/Emoji/.test(style.fontFamily), "emoji fallback present");
    assert.ok(/sans-serif$/.test(style.fontFamily), "generic terminator present");
  }
  // Unknown script (neutral text) → the Latin/generic stack (never boxes on the base font).
  assert.ok(resolveTextStyle("12345 …").fontFamily.includes("Noto Sans"));
});

test("§8 resolveTextStyle is deterministic — preview + export get the SAME resolution", () => {
  const text = "شاهد example.com";
  assert.deepEqual(resolveTextStyle(text), resolveTextStyle(text));
  // Every supported script has a family stack (no gaps).
  for (const s of Object.keys(FONT_FAMILY_BY_SCRIPT)) {
    assert.ok(FONT_FAMILY_BY_SCRIPT[s as keyof typeof FONT_FAMILY_BY_SCRIPT].length > 0);
  }
});

// ── §5 font-availability diagnostic ──────────────────────────────────────────

test("§5 checkFontAvailability reports missing script fonts (drives the server diagnostic)", () => {
  const allPresent = checkFontAvailability(() => true);
  assert.equal(allPresent.ok, true);
  assert.equal(allPresent.missing.length, 0);
  // Required script families + the (optional) emoji family.
  assert.equal(allPresent.available.length, REQUIRED_SCRIPT_FONTS.length + 1);

  // A runtime with no Arabic font → flagged, and the affected scripts named.
  const noArabic = checkFontAvailability((f) => f !== "Noto Sans Arabic");
  assert.equal(noArabic.ok, false);
  assert.ok(noArabic.missing.some((m) => m.family === "Noto Sans Arabic" && m.scripts.includes("arabic")));

  const none = checkFontAvailability(() => false);
  assert.equal(none.ok, false);
  assert.equal(none.missing.length, REQUIRED_SCRIPT_FONTS.length);

  // Emoji is PROBED (so a fontless image can warn) but OPTIONAL — its absence
  // never fails `ok`, and its presence is reported separately.
  assert.equal(allPresent.emojiAvailable, true);
  const noEmoji = checkFontAvailability((f) => f !== "Noto Color Emoji");
  assert.equal(noEmoji.emojiAvailable, false);
  assert.equal(noEmoji.ok, true, "missing emoji does NOT fail the required-scripts check");
  assert.ok(!noEmoji.missing.some((m) => m.family === "Noto Color Emoji"));
});

// ── §8 script-aware line wrapping (no overflow) ──────────────────────────────

// Fake canvas ctx: width ∝ code-point count (Array.from → surrogate-safe count).
const mockCtx = {
  measureText: (s: string) => ({ width: Array.from(s).length * 10 }),
} as unknown as CanvasRenderingContext2D;

test("§8 wrapText wraps Latin on spaces", () => {
  const lines = wrapText(mockCtx, "the quick brown fox jumps over", 100); // 10 chars/line
  assert.ok(lines.length > 1, "wrapped into multiple lines");
  assert.ok(lines.every((l) => Array.from(l).length <= 10 || !l.includes(" ")), "no line grossly overflows");
  assert.equal(lines.join(" "), "the quick brown fox jumps over", "no words lost/duplicated");
});

test("§8 wrapText char-breaks space-less CJK runs (never one overflowing line)", () => {
  const cjk = "你好世界这是一个很长的中文标题需要换行"; // 19 chars, no spaces
  const lines = wrapText(mockCtx, cjk, 50); // 5 chars/line
  assert.ok(lines.length >= 4, "CJK run broken across lines");
  for (const l of lines) assert.ok(Array.from(l).length <= 5, `line "${l}" within width`);
  assert.equal(lines.join(""), cjk, "no characters lost");
});

test("§8 wrapText char-breaks a long URL and keeps emoji whole", () => {
  const url = "https://framevo.app/watch/aaaaaaaaaaaaaaaaaaaa";
  const lines = wrapText(mockCtx, url, 100);
  assert.ok(lines.length > 1, "long URL broken");
  // Emoji (surrogate pairs) are never split mid-character.
  const emoji = wrapText(mockCtx, "🎬🔥✨🎥🎞️🍿🎪🎨", 30);
  for (const l of lines.concat(emoji)) assert.ok(l.length > 0);
  assert.ok(!emoji.join("").includes("�"), "no replacement chars from split surrogates");
});
