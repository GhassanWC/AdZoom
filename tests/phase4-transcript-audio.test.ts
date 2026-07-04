/**
 * Phase 4 — Transcript + Audio Intelligence. Locks the acceptance criteria:
 * real silence detection, transcript-driven captions (NEVER faked), per-type
 * caption styling, transcript-strengthened hooks, and honest provider gating.
 *
 * Run with:  npm test   (node --test, native TS strip). All modules under test
 * use type-only `@/` imports, so they load cleanly via relative paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectSilence, DEFAULT_SILENCE_OPTIONS } from "../src/lib/audio/silence.ts";
import {
  generateCaptionMoments,
  captionStyleForVideoType,
} from "../src/lib/analysis/caption-generator.ts";
import { getTranscriptProvider } from "../src/lib/transcript/provider.ts";
import { parseSpeechResults, parseDuration, speechHttpError } from "../src/lib/transcript/speech-parse.ts";
import {
  decideTranscription,
  sourceFingerprint,
  asrExecutionMode,
  isAsrRunnable,
  resolveAsrDispatch,
  hasBackgroundAsrTarget,
  INLINE_ASR_MAX_SECONDS,
  PROCESSING_STALE_MS,
} from "../src/lib/transcript/transcription-job.ts";
import { resolveEditRecipe } from "../src/lib/analysis/edit-recipe.ts";
import { generateOverlayEdits } from "../src/lib/analysis/overlay-generators.ts";

// ── Silence detection (pure) ────────────────────────────────────────────────

/** Build an RMS timeline: alternating [loud, silent, loud] blocks (seconds). */
function rmsBlocks(blocks: Array<{ sec: number; loud: boolean }>, hz: number): number[] {
  const out: number[] = [];
  for (const b of blocks) {
    const n = Math.round(b.sec * hz);
    for (let i = 0; i < n; i++) out.push(b.loud ? 0.2 : 0.001);
  }
  return out;
}

test("detectSilence finds a long pause between speech", () => {
  const hz = 10;
  const rms = rmsBlocks(
    [
      { sec: 3, loud: true },
      { sec: 2, loud: false },
      { sec: 3, loud: true },
    ],
    hz
  );
  const r = detectSilence(rms, hz);
  assert.equal(r.silenceSegments?.length, 1, "one silence segment");
  const s = r.silenceSegments![0];
  assert.ok(Math.abs(s.startTime - 3) < 0.2 && Math.abs(s.endTime - 5) < 0.2, "silence at 3–5s");
  assert.equal(r.longPauses?.length, 1, "the 2s gap is a long pause (>= 0.8s)");
  assert.equal(r.speechSegments?.length, 2, "two speech runs");
  assert.ok(r.hasUsableSpeech, "6s of speech over 8s → usable");
  assert.ok(Math.abs((r.totalSilenceSeconds ?? 0) - 2) < 0.25);
});

test("detectSilence: all-silent → no usable speech, no speech segments", () => {
  const r = detectSilence(rmsBlocks([{ sec: 6, loud: false }], 10), 10);
  assert.equal(r.hasUsableSpeech, false);
  assert.equal(r.speechSegments?.length, 0);
  assert.ok((r.silenceSegments?.length ?? 0) >= 1);
});

test("detectSilence: continuous speech → usable, no silence", () => {
  const r = detectSilence(rmsBlocks([{ sec: 8, loud: true }], 10), 10);
  assert.ok(r.hasUsableSpeech);
  assert.equal(r.silenceSegments?.length, 0);
  assert.equal(r.longPauses?.length, 0);
});

test("detectSilence: empty / zero-rate input is safe", () => {
  const r = detectSilence([], 10);
  assert.equal(r.hasUsableSpeech, false);
  assert.equal(r.speechSegments?.length, 0);
  assert.equal(r.totalSilenceSeconds, 0);
  const z = detectSilence([0.2, 0.2], 0);
  assert.equal(z.hasUsableSpeech, false);
});

test("silence options expose tunable thresholds", () => {
  assert.ok(DEFAULT_SILENCE_OPTIONS.longPauseSec > DEFAULT_SILENCE_OPTIONS.minSilenceSec);
});

// ── Captions (transcript-driven, never faked) ───────────────────────────────

const TRANSCRIPT = {
  status: "complete" as const,
  language: "en",
  text: "Hello world. This is a test caption line for the demo video today.",
  segments: [
    { id: "s0", startTime: 0.5, endTime: 2.0, text: "Hello world" },
    { id: "s1", startTime: 2.2, endTime: 6.0, text: "This is a test caption line for the demo video today" },
  ],
};

test("captions are NOT generated without a real transcript (no fake words)", () => {
  for (const t of [undefined, null, { status: "unavailable" }, { status: "failed" }, { status: "processing" }]) {
    const r = generateCaptionMoments(t, "reels-shorts");
    assert.equal(r.moments.length, 0, `status ${JSON.stringify(t)} must yield no captions`);
  }
  // "complete" but with NO segments is still not usable.
  assert.equal(generateCaptionMoments({ status: "complete", segments: [] }, "reels-shorts").moments.length, 0);
});

test("captions generate from a real transcript with segment timings", () => {
  const r = generateCaptionMoments(TRANSCRIPT, "reels-shorts");
  assert.ok(r.moments.length >= 2, "at least one caption per segment");
  for (const m of r.moments) {
    assert.equal(m.effectType, "captions");
    assert.ok(m.captions?.text.length > 0, "caption has real text");
    assert.ok(m.endTime > m.startTime, "positive duration");
    assert.equal(m.recipe?.category, "captions");
    assert.equal(m.source, "ai");
  }
  // Timings come from the transcript, not invented.
  assert.ok(r.moments[0].startTime >= 0.4);
});

test("caption style follows the video type (spec §5)", () => {
  assert.equal(captionStyleForVideoType("reels-shorts"), "bold_social");
  assert.equal(captionStyleForVideoType("ad-promo"), "bold_social");
  assert.equal(captionStyleForVideoType("talking-head"), "clean");
  assert.equal(captionStyleForVideoType("podcast-clip"), "podcast");
  assert.equal(captionStyleForVideoType("tutorial"), "tutorial");
  assert.equal(captionStyleForVideoType("screen-recording"), "tutorial");
  assert.equal(generateCaptionMoments(TRANSCRIPT, "reels-shorts").moments[0].captions?.stylePreset, "bold_social");
  assert.equal(generateCaptionMoments(TRANSCRIPT, "tutorial").moments[0].captions?.stylePreset, "tutorial");
  assert.equal(generateCaptionMoments(TRANSCRIPT, "podcast-clip").moments[0].captions?.stylePreset, "podcast");
});

test("word-level timings pass through to captions when present", () => {
  const withWords = {
    status: "complete" as const,
    segments: [{ id: "s0", startTime: 0, endTime: 2, text: "hi there" }],
    words: [
      { word: "hi", startTime: 0.0, endTime: 0.4 },
      { word: "there", startTime: 0.5, endTime: 1.2 },
    ],
  };
  const r = generateCaptionMoments(withWords, "talking-head");
  assert.ok(r.moments[0].captions?.words && r.moments[0].captions.words.length === 2);
});

// ── Provider gating (no fake) ───────────────────────────────────────────────

test("no transcript provider is configured → getTranscriptProvider() is null", async () => {
  // No TRANSCRIPT_PROVIDER env in the test runtime → null (honest, never fakes).
  delete process.env.TRANSCRIPT_PROVIDER;
  assert.equal(await getTranscriptProvider(), null);
});

test("google_speech selected but missing project id → unavailable (never fakes)", async () => {
  const saved = {
    p: process.env.TRANSCRIPT_PROVIDER,
    g: process.env.GOOGLE_CLOUD_PROJECT_ID,
    f: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  };
  process.env.TRANSCRIPT_PROVIDER = "google_speech";
  delete process.env.GOOGLE_CLOUD_PROJECT_ID;
  delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  try {
    assert.equal(await getTranscriptProvider(), null, "no project id → null (unavailable), not the provider");
  } finally {
    if (saved.p === undefined) delete process.env.TRANSCRIPT_PROVIDER;
    else process.env.TRANSCRIPT_PROVIDER = saved.p;
    if (saved.g !== undefined) process.env.GOOGLE_CLOUD_PROJECT_ID = saved.g;
    if (saved.f !== undefined) process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = saved.f;
  }
});

// ── Transcription job lifecycle + dedup (pure) ──────────────────────────────

const NOW = 1_000_000_000_000;
const FP = "users/u/p/original/v.mp4|1000|30";
const complete = (fp?: string) => ({
  status: "complete" as const,
  segments: [{ id: "s0", startTime: 0, endTime: 1, text: "hi" }],
  ...(fp !== undefined ? { sourceFingerprint: fp } : {}),
});

test("sourceFingerprint is stable + changes when the video changes", () => {
  const base = { storagePath: "p", fileSize: 1000, duration: 30 };
  assert.equal(sourceFingerprint(base), sourceFingerprint({ ...base }));
  assert.notEqual(sourceFingerprint(base), sourceFingerprint({ ...base, fileSize: 2000 }));
  assert.notEqual(sourceFingerprint(base), sourceFingerprint({ ...base, storagePath: "q" }));
});

test("decideTranscription: not runnable → unavailable (never fakes)", () => {
  const d = decideTranscription({ existing: undefined, fingerprint: FP, runnable: false, now: NOW });
  assert.equal(d.action, "unavailable");
});

test("decideTranscription: reuse a fresh complete transcript (dedup)", () => {
  const d = decideTranscription({ existing: complete(FP), fingerprint: FP, runnable: true, now: NOW });
  assert.equal(d.action, "reuse");
  // Legacy transcript with no stored fingerprint is assumed unchanged → reuse.
  const legacy = decideTranscription({ existing: complete(), fingerprint: FP, runnable: true, now: NOW });
  assert.equal(legacy.action, "reuse");
});

test("decideTranscription: re-transcribe when the video changed or forced", () => {
  const changed = decideTranscription({ existing: complete("OLD"), fingerprint: FP, runnable: true, now: NOW });
  assert.equal(changed.action, "transcribe");
  const forced = decideTranscription({ existing: complete(FP), fingerprint: FP, runnable: true, forceRetranscribe: true, now: NOW });
  assert.equal(forced.action, "transcribe");
});

test("decideTranscription: don't double-queue an in-flight job; retry a stale one", () => {
  const recent = decideTranscription({
    existing: { status: "processing", requestedAt: NOW - 1000, sourceFingerprint: FP },
    fingerprint: FP, runnable: true, now: NOW,
  });
  assert.equal(recent.action, "skip");
  const stale = decideTranscription({
    existing: { status: "processing", requestedAt: NOW - PROCESSING_STALE_MS - 1, sourceFingerprint: FP },
    fingerprint: FP, runnable: true, now: NOW,
  });
  assert.equal(stale.action, "transcribe");
});

test("decideTranscription: missing / failed / unavailable / empty → transcribe", () => {
  for (const existing of [undefined, { status: "failed" as const }, { status: "unavailable" as const }, { status: "complete" as const, segments: [] }]) {
    assert.equal(decideTranscription({ existing, fingerprint: FP, runnable: true, now: NOW }).action, "transcribe");
  }
});

test("asrExecutionMode + isAsrRunnable read env safely", () => {
  const saved = {
    e: process.env.TRANSCRIPT_EXECUTION,
    p: process.env.TRANSCRIPT_PROVIDER,
    g: process.env.GOOGLE_CLOUD_PROJECT_ID,
    f: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    u: process.env.TRANSCRIPT_WORKER_URL,
  };
  try {
    delete process.env.TRANSCRIPT_EXECUTION;
    assert.equal(asrExecutionMode(), "disabled");
    process.env.TRANSCRIPT_EXECUTION = "worker";
    assert.equal(asrExecutionMode(), "worker");
    process.env.TRANSCRIPT_EXECUTION = "inline";
    assert.equal(asrExecutionMode(), "inline");
    process.env.TRANSCRIPT_EXECUTION = "garbage";
    assert.equal(asrExecutionMode(), "disabled");

    process.env.TRANSCRIPT_PROVIDER = "google_speech";
    process.env.GOOGLE_CLOUD_PROJECT_ID = "adzoom-prod";
    // inline → runnable with just provider + project.
    process.env.TRANSCRIPT_EXECUTION = "inline";
    assert.equal(isAsrRunnable(), true);
    // worker → needs a dispatch URL (else not runnable → unavailable, not stuck).
    process.env.TRANSCRIPT_EXECUTION = "worker";
    delete process.env.TRANSCRIPT_WORKER_URL;
    assert.equal(isAsrRunnable(), false, "worker mode with no URL is not runnable");
    process.env.TRANSCRIPT_WORKER_URL = "https://asr.example.com";
    assert.equal(isAsrRunnable(), true);
    process.env.TRANSCRIPT_EXECUTION = "disabled";
    assert.equal(isAsrRunnable(), false);
  } finally {
    for (const [k, v] of [
      ["TRANSCRIPT_EXECUTION", saved.e],
      ["TRANSCRIPT_PROVIDER", saved.p],
      ["GOOGLE_CLOUD_PROJECT_ID", saved.g],
      ["NEXT_PUBLIC_FIREBASE_PROJECT_ID", saved.f],
      ["TRANSCRIPT_WORKER_URL", saved.u],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("resolveAsrDispatch: async by default — only SHORT inline videos run synchronously", () => {
  // disabled → never runs.
  assert.equal(resolveAsrDispatch({ execMode: "disabled", durationSeconds: 5 }), "none");
  // worker → ALWAYS background (never blocks analysis), any duration.
  assert.equal(resolveAsrDispatch({ execMode: "worker", durationSeconds: 5 }), "background");
  assert.equal(resolveAsrDispatch({ execMode: "worker", durationSeconds: 3600 }), "background");
  // inline → inline ONLY for short videos (≤ the threshold); longer → background.
  assert.equal(resolveAsrDispatch({ execMode: "inline", durationSeconds: 10 }), "inline");
  assert.equal(resolveAsrDispatch({ execMode: "inline", durationSeconds: INLINE_ASR_MAX_SECONDS }), "inline");
  assert.equal(
    resolveAsrDispatch({ execMode: "inline", durationSeconds: INLINE_ASR_MAX_SECONDS + 1 }),
    "background",
    "just over the threshold → background"
  );
  // A 2.5-minute video NEVER runs inline (the whole point of this change).
  assert.equal(resolveAsrDispatch({ execMode: "inline", durationSeconds: 159 }), "background");
  // Unknown duration → treat as long → background (never blocks).
  assert.equal(resolveAsrDispatch({ execMode: "inline", durationSeconds: null }), "background");
  assert.equal(resolveAsrDispatch({ execMode: "inline" }), "background");
  // The threshold sits in the intended 45–60s band.
  assert.ok(INLINE_ASR_MAX_SECONDS >= 45 && INLINE_ASR_MAX_SECONDS <= 60);
});

test("hasBackgroundAsrTarget: a worker URL OR the app origin (dev self-POST) is enough", () => {
  const saved = { u: process.env.TRANSCRIPT_WORKER_URL, a: process.env.NEXT_PUBLIC_APP_URL };
  try {
    delete process.env.TRANSCRIPT_WORKER_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    assert.equal(hasBackgroundAsrTarget(), false, "no target when neither is set");
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    assert.equal(hasBackgroundAsrTarget(), true, "app origin (dev self-POST) counts");
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.TRANSCRIPT_WORKER_URL = "https://asr.example.com";
    assert.equal(hasBackgroundAsrTarget(), true, "dedicated worker URL counts");
  } finally {
    if (saved.u === undefined) delete process.env.TRANSCRIPT_WORKER_URL;
    else process.env.TRANSCRIPT_WORKER_URL = saved.u;
    if (saved.a === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = saved.a;
  }
});

// ── Google Speech-to-Text response parsing (pure) ───────────────────────────

test("parseDuration handles Speech REST formats", () => {
  assert.equal(parseDuration("1.200s"), 1.2);
  assert.equal(parseDuration("5s"), 5);
  assert.equal(parseDuration({ seconds: 2, nanos: 500_000_000 }), 2.5);
  assert.equal(parseDuration(3.25), 3.25);
  assert.equal(parseDuration(undefined), 0);
});

test("parseSpeechResults builds a real transcript with segments + words", () => {
  const results = [
    {
      languageCode: "en-us",
      alternatives: [
        {
          transcript: "hello world",
          confidence: 0.95,
          words: [
            { word: "hello", startTime: "0s", endTime: "0.4s", confidence: 0.9 },
            { word: "world", startTime: "0.4s", endTime: "0.9s", confidence: 0.92 },
          ],
        },
      ],
    },
    {
      alternatives: [
        {
          transcript: "second line",
          words: [
            { word: "second", startTime: "1.0s", endTime: "1.5s" },
            { word: "line", startTime: "1.5s", endTime: "2.0s" },
          ],
        },
      ],
    },
  ];
  const t = parseSpeechResults(results);
  assert.equal(t.language, "en-us");
  assert.equal(t.segments.length, 2);
  assert.equal(t.segments[0].text, "hello world");
  assert.ok(Math.abs(t.segments[0].startTime - 0) < 1e-6 && Math.abs(t.segments[0].endTime - 0.9) < 1e-6);
  assert.equal(t.words.length, 4);
  assert.equal(t.words[0].word, "hello");
  assert.equal(t.text, "hello world second line");
});

test("speechHttpError: a disabled-API 403 becomes a concise, actionable message with the enable URL", () => {
  const body = JSON.stringify({
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message:
        "Cloud Speech-to-Text API has not been used in project 574329747163 before or it is disabled. " +
        "Enable it by visiting https://console.developers.google.com/apis/api/speech.googleapis.com/overview?project=574329747163 " +
        "then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.",
    },
  });
  const err = speechHttpError("longrunningrecognize", 403, body);
  // Names the concrete project + a clickable enable URL, and does NOT dump raw JSON.
  assert.match(err.message, /not enabled for project 574329747163/);
  assert.match(err.message, /speech\.googleapis\.com\/overview\?project=574329747163/);
  assert.match(err.message, /re-analyze/);
  assert.ok(!err.message.includes('"error"'), "no raw JSON leaks into the message");
});

test("speechHttpError: a non-disabled error keeps the API's own message (no raw dump)", () => {
  const err = speechHttpError("recognize", 400, JSON.stringify({ error: { message: "Invalid audio encoding." } }));
  assert.match(err.message, /recognize failed \(400\): Invalid audio encoding\./);
  // A non-JSON body degrades to a trimmed snippet, never a crash.
  const err2 = speechHttpError("recognize", 500, "<html>Internal Error</html>");
  assert.match(err2.message, /recognize failed \(500\)/);
});

test("parseSpeechResults tolerates empty / missing results", () => {
  assert.equal(parseSpeechResults(undefined).segments.length, 0);
  assert.equal(parseSpeechResults([]).segments.length, 0);
  assert.equal(parseSpeechResults([{ alternatives: [] }]).segments.length, 0);
  // Segment without word offsets still gets a sane, non-inverted window.
  const t = parseSpeechResults([{ alternatives: [{ transcript: "no words here" }], resultEndTime: "3s" }]);
  assert.equal(t.segments.length, 1);
  assert.ok(t.segments[0].endTime > t.segments[0].startTime);
});

test("a parsed transcript flows into caption generation (end-to-end shape)", () => {
  const parsed = parseSpeechResults([
    { languageCode: "en-us", alternatives: [{ transcript: "hello world", words: [
      { word: "hello", startTime: "0s", endTime: "0.4s" },
      { word: "world", startTime: "0.4s", endTime: "0.9s" },
    ] }] },
  ]);
  const transcript = {
    status: "complete" as const,
    text: parsed.text,
    language: parsed.language,
    segments: parsed.segments,
    words: parsed.words,
  };
  const caps = generateCaptionMoments(transcript, "reels-shorts");
  assert.ok(caps.moments.length >= 1);
  assert.equal(caps.moments[0].effectType, "captions");
  assert.equal(caps.moments[0].captions?.stylePreset, "bold_social");
});

// ── Recipe + overlay integration ────────────────────────────────────────────

const AUDIO_SIGNALS = {
  hasTranscript: true,
  hasAudioAnalysis: true,
  hasUsableSpeech: true,
  silenceSegmentCount: 3,
  hasSceneData: true,
  hasVisualMoments: true,
  hasInteractionData: false,
  isScreenRecording: false,
  durationSeconds: 30,
};

test("hook_text uses the transcript's opening line when a transcript exists", () => {
  // reels-shorts is a type whose recipe enables hook_text.
  const plan = resolveEditRecipe({ selectedVideoType: "reels-shorts", signals: AUDIO_SIGNALS });
  const res = generateOverlayEdits({
    plan,
    moments: [],
    duration: 30,
    projectTitle: "Fallback Title",
    hasOutputCanvas: false,
    transcript: TRANSCRIPT,
  });
  const hook = res.moments.find((m) => m.effectType === "hook-text");
  assert.ok(hook, "hook generated");
  assert.equal(hook?.hookText?.text, "Hello world", "hook uses the transcript's first sentence");
});

test("hook_text falls back to the project title with no transcript", () => {
  const plan = resolveEditRecipe({
    selectedVideoType: "reels-shorts",
    signals: { ...AUDIO_SIGNALS, hasTranscript: false },
  });
  const res = generateOverlayEdits({
    plan,
    moments: [],
    duration: 30,
    projectTitle: "Fallback Title",
    hasOutputCanvas: false,
  });
  const hook = res.moments.find((m) => m.effectType === "hook-text");
  assert.equal(hook?.hookText?.text, "Fallback Title");
});

test("Analyze toggles suppress overlay generation (allow:false → not generated)", () => {
  const plan = resolveEditRecipe({ selectedVideoType: "reels-shorts", signals: AUDIO_SIGNALS });
  // Everything allowed → hook + CTA + smart-crop generate.
  const on = generateOverlayEdits({
    plan, moments: [], duration: 25, projectTitle: "T", hasOutputCanvas: false, transcript: TRANSCRIPT,
  });
  assert.ok(on.moments.some((m) => m.effectType === "hook-text"), "hook on by default");
  assert.ok(on.moments.some((m) => m.effectType === "branding-cta"), "cta on by default");
  assert.ok(on.outputCanvas, "smart crop on by default");
  // Toggling hook_text / branding(cta) / smart_crop OFF suppresses them.
  const off = generateOverlayEdits({
    plan, moments: [], duration: 25, projectTitle: "T", hasOutputCanvas: false, transcript: TRANSCRIPT,
    allow: { hook_text: false, branding: false, smart_crop: false },
  });
  assert.ok(off.moments.every((m) => m.effectType !== "hook-text"), "hook suppressed");
  assert.ok(off.moments.every((m) => m.effectType !== "branding-cta"), "cta suppressed");
  assert.equal(off.outputCanvas, undefined, "smart crop suppressed (no output canvas)");
});

test("callouts + transitions toggles suppress those overlays", () => {
  // callouts need interaction/cursor data to be feasible in the recipe.
  const plan = resolveEditRecipe({
    selectedVideoType: "product-demo",
    signals: { ...AUDIO_SIGNALS, hasInteractionData: true },
  });
  const click = (id, start) => ({
    id, startTime: start, endTime: start + 2, label: "Open the settings menu", reason: "",
    focusRegion: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
    effectType: "click-highlight", targetRegionSource: "click-event", confidenceScore: 0.8, attentionScore: 0.7,
  });
  const moments = [click("a", 5), click("b", 12)];
  const on = generateOverlayEdits({ plan, moments, duration: 30, projectTitle: "D", hasOutputCanvas: false });
  assert.ok(on.moments.some((m) => m.effectType === "callout"), "callouts on by default");
  const off = generateOverlayEdits({
    plan, moments, duration: 30, projectTitle: "D", hasOutputCanvas: false,
    allow: { callout: false, transition: false },
  });
  assert.ok(off.moments.every((m) => m.effectType !== "callout"), "callouts suppressed");
  assert.ok(off.moments.every((m) => m.effectType !== "transition"), "transitions suppressed");
});

test("overlay generation still never emits captions itself (route owns captions)", () => {
  const plan = resolveEditRecipe({ selectedVideoType: "reels-shorts", signals: AUDIO_SIGNALS });
  const res = generateOverlayEdits({
    plan,
    moments: [],
    duration: 30,
    projectTitle: "T",
    hasOutputCanvas: false,
    transcript: TRANSCRIPT,
  });
  assert.ok(res.moments.every((m) => m.effectType !== "captions"), "captions are generated in the route, not here");
  // Existing cut/zoom/speed pool is untouched (additive overlays only).
  assert.ok(res.moments.every((m) => m.effectType !== "cut" && m.effectType !== "zoom" && m.effectType !== "speed-up"));
});
