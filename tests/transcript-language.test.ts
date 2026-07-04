/**
 * Multilingual transcription + captions — locks the acceptance criteria:
 * the selected spoken language is honored (not en-US), it overrides
 * TRANSCRIPT_LANGUAGE, Auto-Detect sends a small candidate list, changing the
 * language forces retranscription (fingerprint), the original-language transcript
 * makes original-language captions (never translated), and RTL is applied.
 *
 * Run with:  npm test   (node --test, native TS strip). All modules under test
 * use type-only `@/` imports (or pure value imports), so they load via relative paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTranscriptLanguage,
  isRtlLanguage,
  transcriptLanguageLabel,
  transcriptScriptMatchesLanguage,
  MAX_ALT_LANGUAGE_CODES,
  TRANSCRIPT_LANGUAGES,
} from "../src/lib/transcript/language.ts";
import {
  transcriptionFingerprint,
  decideTranscription,
} from "../src/lib/transcript/transcription-job.ts";
import { generateCaptionMoments } from "../src/lib/analysis/caption-generator.ts";

const SRC = { storagePath: "users/u/p/video.mp4", fileSize: 12_345, duration: 159 };
const MODEL = "latest_long";
const PROV = "google_speech";

// ── §1–3: language precedence ───────────────────────────────────────────────

test("selected ar-OM is sent as the language (NOT en-US), no alternatives", () => {
  const r = resolveTranscriptLanguage({ mode: "selected", selectedCode: "ar-OM" });
  assert.equal(r.mode, "selected");
  assert.equal(r.languageCode, "ar-OM");
  assert.deepEqual(r.alternativeLanguageCodes, [], "selected mode sends no alternatives");
});

test("a selected language OVERRIDES TRANSCRIPT_LANGUAGE (env never wins over the user)", () => {
  const r = resolveTranscriptLanguage({
    mode: "selected",
    selectedCode: "ar-OM",
    envFallback: "en-US", // TRANSCRIPT_LANGUAGE
    priorLanguage: "en-US",
    locale: "en-US",
  });
  assert.equal(r.languageCode, "ar-OM", "user selection beats env + prior + locale");
});

test("Auto Detect supplies only the intended candidate languages (primary + a tiny alt list)", () => {
  // Oman user: prior confirmed ar-OM (unchanged source), browser en-US.
  const r = resolveTranscriptLanguage({
    mode: "auto",
    priorLanguage: "ar-OM",
    locale: "en-US",
    envFallback: "fr-FR",
  });
  assert.equal(r.mode, "auto");
  assert.equal(r.languageCode, "ar-OM", "prior confirmed language leads");
  // Candidates are en-US (locale) then fr-FR (env) then en-US dedup — capped, no dupes.
  assert.ok(r.alternativeLanguageCodes.includes("en-US"));
  assert.ok(r.alternativeLanguageCodes.length <= MAX_ALT_LANGUAGE_CODES);
  assert.ok(!r.alternativeLanguageCodes.some((c) => c.toLowerCase() === "ar-om"), "primary never repeats in alts");
});

test("Auto Detect with no signal defaults to en-US (last resort), never crashes", () => {
  const r = resolveTranscriptLanguage({ mode: "auto" });
  assert.equal(r.languageCode, "en-US");
});

test("existing projects with NO language settings default safely to Auto/en-US", () => {
  const r = resolveTranscriptLanguage({}); // undefined mode → auto
  assert.equal(r.mode, "auto");
  assert.equal(r.languageCode, "en-US");
});

test("English selection still works", () => {
  const r = resolveTranscriptLanguage({ mode: "selected", selectedCode: "en-US" });
  assert.equal(r.languageCode, "en-US");
});

// ── §7: cache / fingerprint — changing language forces retranscription ───────

test("changing the language changes the transcript fingerprint (forces retranscription)", () => {
  const en = transcriptionFingerprint({ source: SRC, languageMode: "selected", languageCode: "en-US", model: MODEL, provider: PROV });
  const ar = transcriptionFingerprint({ source: SRC, languageMode: "selected", languageCode: "ar-OM", model: MODEL, provider: PROV });
  assert.notEqual(en, ar, "en-US and ar-OM must not share a fingerprint");
});

test("same language + unchanged video → identical fingerprint (reuse)", () => {
  const a = transcriptionFingerprint({ source: SRC, languageMode: "selected", languageCode: "ar-OM", model: MODEL, provider: PROV });
  const b = transcriptionFingerprint({ source: { ...SRC }, languageMode: "selected", languageCode: "ar-OM", model: MODEL, provider: PROV });
  assert.equal(a, b);
});

test("auto-mode fingerprint is stable regardless of the resolved code (reuse is correct)", () => {
  const a = transcriptionFingerprint({ source: SRC, languageMode: "auto", languageCode: "ar-OM", model: MODEL, provider: PROV });
  const b = transcriptionFingerprint({ source: SRC, languageMode: "auto", languageCode: "en-US", model: MODEL, provider: PROV });
  assert.equal(a, b, "auto keys on 'auto', not the detected language");
});

test("a transcript made with en-US is NOT reused after switching to ar-OM", () => {
  const enFp = transcriptionFingerprint({ source: SRC, languageMode: "selected", languageCode: "en-US", model: MODEL, provider: PROV });
  const arFp = transcriptionFingerprint({ source: SRC, languageMode: "selected", languageCode: "ar-OM", model: MODEL, provider: PROV });
  const stored = { status: "complete" as const, segments: [{ id: "s", startTime: 0, endTime: 1, text: "hi" }], sourceFingerprint: enFp };
  assert.equal(
    decideTranscription({ existing: stored, fingerprint: arFp, runnable: true, now: 1000 }).action,
    "transcribe",
    "switching en-US → ar-OM must re-transcribe"
  );
  assert.equal(
    decideTranscription({ existing: stored, fingerprint: enFp, runnable: true, now: 1000 }).action,
    "reuse",
    "same language + unchanged video reuses"
  );
});

// ── §8–9: original-language captions (never translated) + RTL ────────────────

const arabicSegment = { id: "s0", startTime: 0, endTime: 2.5, text: "مرحبا بكم في هذا الفيديو" };

test("an Arabic transcript creates Arabic captions — RTL, tagged, and NOT translated", () => {
  const res = generateCaptionMoments(
    { status: "complete", language: "ar-OM", segments: [arabicSegment] },
    "reels-shorts"
  );
  assert.ok(res.moments.length > 0, "captions generated");
  const cap = res.moments[0].captions;
  assert.ok(cap);
  assert.equal(cap!.direction, "rtl", "Arabic captions render right-to-left");
  assert.equal(cap!.lang, "ar-OM");
  // The caption text is the SAME Arabic script — never translated to English.
  assert.ok(/[؀-ۿ]/.test(cap!.text), "caption keeps Arabic script");
  assert.ok(!/[A-Za-z]{3,}/.test(cap!.text), "no English words injected");
});

test("English captions stay left-to-right", () => {
  const res = generateCaptionMoments(
    { status: "complete", language: "en-US", segments: [{ id: "s0", startTime: 0, endTime: 2, text: "hello everyone" }] },
    "reels-shorts"
  );
  assert.equal(res.moments[0].captions!.direction, "ltr");
});

// ── helpers ──────────────────────────────────────────────────────────────────

test("isRtlLanguage + labels cover Arabic/Urdu/Persian and Oman", () => {
  assert.equal(isRtlLanguage("ar-OM"), true);
  assert.equal(isRtlLanguage("ur-PK"), true);
  assert.equal(isRtlLanguage("fa-IR"), true);
  assert.equal(isRtlLanguage("en-US"), false);
  assert.equal(isRtlLanguage(undefined), false);
  assert.equal(transcriptLanguageLabel("ar-OM"), "Arabic (Oman)");
  // Arabic (Oman) is present for Oman users.
  assert.ok(TRANSCRIPT_LANGUAGES.some((l) => l.code === "ar-OM"));
});

test("§10 script-mismatch detector flags Latin text for an Arabic selection (never translates)", () => {
  assert.equal(transcriptScriptMatchesLanguage("مرحبا بكم في هذا الفيديو الجميل جدا", "ar-OM"), true);
  assert.equal(
    transcriptScriptMatchesLanguage("hello everyone and welcome back to the channel", "ar-OM"),
    false,
    "Latin text for an Arabic selection is a mismatch"
  );
  assert.equal(transcriptScriptMatchesLanguage("hello everyone welcome back friends", "en-US"), true);
  assert.equal(transcriptScriptMatchesLanguage("hi", "ar-OM"), null, "too little signal → no opinion");
});
