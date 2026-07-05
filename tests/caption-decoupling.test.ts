/**
 * Captions decoupled from AI analysis — the invariants that keep caption
 * generation behind its own action and out of the full analysis flow:
 *   • the Analyze dialog offers NO caption toggle;
 *   • the AI-caption existence resolver drives the button (generate / generated
 *     / processing / stale), and manual captions never count;
 *   • duplicate protection + backward-compat detection;
 *   • the shared caption generator honors the user's chosen style/position.
 *
 * The server-side reserve/commit/dedup lifecycle itself is covered by
 * tests/caption-quota.test.ts (the ledger reducers the captions route reuses).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AI_EDIT_GROUPS,
  AI_EDIT_TOGGLE_KEYS,
  AI_EDIT_EXTRA_KEYS,
} from "@/lib/analysis/analyze-dialog-config";
import {
  resolveAiCaptionStatus,
  transcriptMatchesSource,
  projectSourceFingerprint,
} from "@/lib/analysis/ai-caption-status";
import { generateCaptionMoments } from "@/lib/analysis/caption-generator";
import { sourceFingerprint } from "@/lib/transcript/transcription-job";
import type { DetectedMoment, Transcript } from "@/lib/firebase/schema";

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const cap = (id: string, source: "ai" | "user" = "ai"): DetectedMoment =>
  ({
    id,
    startTime: 1,
    endTime: 2,
    label: "cap",
    effectType: "captions",
    source,
    captions: { text: "hi", stylePreset: "clean", position: "bottom" },
  }) as unknown as DetectedMoment;

const SOURCE = { storagePath: "u/p/v.mp4", originalVideoUrl: "", fileSize: 1000, duration: 90 };
const FP = sourceFingerprint(SOURCE);
const fullFp = (fp: string) => `${fp}|auto|auto|latest_long|google_speech`;

const transcript = (status: Transcript["status"], extra: Partial<Transcript> = {}): Transcript => ({
  status,
  ...extra,
});

/* ── 1. Captions absent from the full Analyze dialog ─────────────────────── */

test("the Analyze dialog config contains NO captions toggle", () => {
  for (const group of AI_EDIT_GROUPS) {
    for (const item of group.items) {
      assert.notEqual(item.key, "generateCaptions");
    }
  }
  assert.ok(!AI_EDIT_TOGGLE_KEYS.includes("generateCaptions"));
  assert.ok(!AI_EDIT_EXTRA_KEYS.includes("generateCaptions"));
});

test("the analyze route no longer runs ASR / reserves quota / generates captions", () => {
  const src = readFileSync("src/app/api/projects/[id]/analyze/route.ts", "utf8");
  // The transcription/caption machinery must be gone from analysis.
  assert.ok(!src.includes("generateCaptionMoments"), "analysis must not generate captions");
  assert.ok(!src.includes("reserveCaptionSeconds"), "analysis must not reserve caption quota");
  assert.ok(!src.includes("dispatchTranscription"), "analysis must not dispatch transcription");
  assert.ok(!src.includes("transcribeVideo"), "analysis must not call the ASR provider");
  // ...and it must PRESERVE existing captions across a re-analyze.
  assert.ok(src.includes("reAddedCaptions"), "analysis must preserve existing caption moments");
});

test("the AnalysisOptionsModal strips generateCaptions from what it submits", () => {
  const src = readFileSync("src/components/dashboard/real-editor/AnalysisOptionsModal.tsx", "utf8");
  assert.ok(src.includes("generateCaptions: _captionsDecoupled"), "must destructure captions out of the options");
  assert.ok(!src.includes("SpokenLanguagePicker"), "no spoken-language picker in the analyze dialog");
});

/* ── 2. AI-caption existence resolver ────────────────────────────────────── */

test("no AI captions → the Generate button is enabled ('generate')", () => {
  const s = resolveAiCaptionStatus({ moments: [], transcript: null, currentSourceFingerprint: FP });
  assert.equal(s.state, "generate");
  assert.equal(s.canGenerate, true);
  assert.equal(s.hasAiCaptions, false);
});

test("valid AI captions → 'generated' but still clickable to REGENERATE (counts minutes)", () => {
  const s = resolveAiCaptionStatus({
    moments: [cap("c1"), cap("c2")],
    transcript: transcript("complete", { sourceFingerprint: fullFp(FP), language: "en" }),
    currentSourceFingerprint: FP,
  });
  assert.equal(s.state, "generated");
  // The button is NOT disabled when captions exist — regeneration is allowed
  // (a fresh, charged ASR run; the modal forces it).
  assert.equal(s.canGenerate, true);
  assert.equal(s.aiCaptionCount, 2);
  assert.equal(s.label, "Regenerate AI Captions");
});

test("processing transcript → button shows processing state", () => {
  const s = resolveAiCaptionStatus({
    moments: [],
    transcript: transcript("processing"),
    currentSourceFingerprint: FP,
  });
  assert.equal(s.state, "processing");
  assert.equal(s.canGenerate, false);
});

test("manual captions alone do NOT disable AI caption generation", () => {
  const s = resolveAiCaptionStatus({
    moments: [cap("m1", "user"), cap("m2", "user")],
    transcript: null,
    currentSourceFingerprint: FP,
  });
  assert.equal(s.hasAiCaptions, false);
  assert.equal(s.state, "generate");
  assert.equal(s.canGenerate, true);
});

test("source video change makes existing AI captions STALE → re-enable generation", () => {
  const changedSource = { ...SOURCE, fileSize: 2000 };
  const s = resolveAiCaptionStatus({
    moments: [cap("c1")],
    transcript: transcript("complete", { sourceFingerprint: fullFp(FP) }),
    currentSourceFingerprint: projectSourceFingerprint(changedSource),
  });
  assert.equal(s.stale, true);
  assert.equal(s.state, "generate");
  assert.equal(s.canGenerate, true);
});

test("deleting AI captions re-enables the button", () => {
  const before = resolveAiCaptionStatus({
    moments: [cap("c1")],
    transcript: transcript("complete", { sourceFingerprint: fullFp(FP) }),
    currentSourceFingerprint: FP,
  });
  assert.equal(before.state, "generated");
  // After deletion the timeline has no AI captions (manual survive).
  const after = resolveAiCaptionStatus({
    moments: [cap("m1", "user")],
    transcript: transcript("complete", { sourceFingerprint: fullFp(FP) }),
    currentSourceFingerprint: FP,
  });
  assert.equal(after.state, "generate");
  assert.equal(after.canGenerate, true);
});

test("no ASR provider → 'unavailable' (button disabled)", () => {
  const s = resolveAiCaptionStatus({
    moments: [],
    transcript: null,
    currentSourceFingerprint: FP,
    providerConfigured: false,
  });
  assert.equal(s.state, "unavailable");
  assert.equal(s.canGenerate, false);
});

/* ── 3. Backward compatibility (old full-analysis captions) ──────────────── */

test("old projects with AI captions are detected as already generated", () => {
  // Legacy transcript may lack a stored fingerprint — assume current (never
  // force needless re-transcription), so existing AI captions read as done.
  const legacy = resolveAiCaptionStatus({
    moments: [cap("cap-0-0"), cap("cap-1-0")],
    transcript: transcript("complete"), // no sourceFingerprint
    currentSourceFingerprint: FP,
  });
  assert.equal(legacy.state, "generated");
  assert.equal(legacy.stale, false);
  assert.equal(legacy.aiCaptionCount, 2);
});

test("transcriptMatchesSource: prefix match, exact, legacy, and mismatch", () => {
  assert.equal(transcriptMatchesSource(transcript("complete", { sourceFingerprint: fullFp(FP) }), FP), true);
  assert.equal(transcriptMatchesSource(transcript("complete", { sourceFingerprint: FP }), FP), true);
  assert.equal(transcriptMatchesSource(transcript("complete"), FP), true); // legacy → assumed current
  assert.equal(transcriptMatchesSource(transcript("complete", { sourceFingerprint: fullFp("other|1|2") }), FP), false);
});

/* ── 4. Style/position override in the shared generator ──────────────────── */

test("generateCaptionMoments honors the user's chosen style + position", () => {
  const t = transcript("complete", {
    language: "en",
    segments: [{ id: "s0", startTime: 0, endTime: 1.5, text: "hello world" }],
  });
  const gen = generateCaptionMoments(t, "auto", { stylePreset: "podcast", position: "top" });
  assert.ok(gen.moments.length >= 1);
  const c = gen.moments[0] as unknown as { captions: { stylePreset: string; position: string } };
  assert.equal(c.captions.stylePreset, "podcast");
  assert.equal(c.captions.position, "top");
});

test("generateCaptionMoments falls back to the video-type style when no override", () => {
  const t = transcript("complete", {
    language: "en",
    segments: [{ id: "s0", startTime: 0, endTime: 1.5, text: "hello world" }],
  });
  const gen = generateCaptionMoments(t, "reels-shorts");
  const c = gen.moments[0] as unknown as { captions: { stylePreset: string; position: string } };
  assert.equal(c.captions.stylePreset, "bold_social"); // reels default
  assert.equal(c.captions.position, "bottom");
});

/* ── 5. Server duplicate protection wiring ───────────────────────────────── */

test("the worker only generates captions for the caption flow (wantsCaptions = true)", () => {
  const src = readFileSync("src/lib/transcript/run-transcription.ts", "utf8");
  // Analysis no longer dispatches, so any worker job IS a caption job.
  assert.ok(src.includes("function wantsCaptions"));
  assert.ok(/function wantsCaptions\([^)]*\): boolean \{\s*return true;/.test(src));
});

test("the captions route reuses the shared processTranscriptionJob (verify+commit)", () => {
  const src = readFileSync("src/lib/transcript/caption-request.ts", "utf8");
  assert.ok(src.includes("processTranscriptionJob"), "must reuse the shared worker job");
  assert.ok(src.includes("reserveCaptionSeconds"), "must reserve quota for a new ASR run");
  assert.ok(src.includes('status: "exists"'), "must short-circuit when AI captions already exist");
  assert.ok(src.includes('status: "processing"'), "must short-circuit an in-flight job");
});
