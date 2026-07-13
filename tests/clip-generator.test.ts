/**
 * Unit tests for the Smart Clip Generator (pure heuristic over analysis signals).
 *
 * Run with:  npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateClips,
  generateClipsDetailed,
  generateFallbackClips,
  clipGenMessage,
  clipRangeCutMoments,
  resolveClipVideoType,
  CLIP_TYPE_META,
  type ClipGenInput,
} from "../src/lib/clips/clip-generator.ts";
import type {
  DetectedMoment,
  NarrativeSegment,
  TranscriptSegment,
} from "../src/lib/firebase/schema.ts";

const NOW = 1_700_000_000_000;

/** 8-bit attention curve (0..255) at 1 Hz with two clear peaks. */
function curve(duration: number): number[] {
  const arr: number[] = [];
  for (let t = 0; t < duration; t++) {
    // Peaks around 20s and (duration-25)s; quiet middle + very quiet tail-start.
    const nearPeakA = Math.max(0, 1 - Math.abs(t - 20) / 12);
    const nearPeakB = Math.max(0, 1 - Math.abs(t - (duration - 25)) / 12);
    const v = 0.25 + 0.7 * Math.max(nearPeakA, nearPeakB);
    arr.push(Math.round(Math.min(1, v) * 255));
  }
  return arr;
}

function narrative(duration: number): NarrativeSegment[] {
  return [
    { startTime: 0, endTime: 30, role: "intro", label: "Intro" },
    { startTime: 30, endTime: 90, role: "explanation", label: "Explanation" },
    { startTime: 90, endTime: 140, role: "action", label: "Action" },
    { startTime: 140, endTime: duration, role: "result", label: "Result" },
  ];
}

function transcript(duration: number): TranscriptSegment[] {
  // 10s sentences so boundary-snapping has something to land on.
  const segs: TranscriptSegment[] = [];
  for (let s = 0; s < duration; s += 10) {
    segs.push({
      id: `s${s}`,
      startTime: s,
      endTime: Math.min(duration, s + 10),
      text: `This is sentence number ${s / 10} talking about the product feature here.`,
    });
  }
  return segs;
}

function moment(id: string, start: number, end: number, prov: "event" | "cv" | "ai" = "ai"): DetectedMoment {
  return {
    id,
    startTime: start,
    endTime: end,
    label: "Zoom",
    reason: "test",
    focusRegion: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
    effectType: "zoom",
    provenance: prov,
    confidenceScore: 0.7,
  };
}

function fullInput(duration: number, selectedVideoType: ClipGenInput["selectedVideoType"] = "reels-shorts"): ClipGenInput {
  return {
    duration,
    selectedVideoType,
    now: NOW,
    analysis: {
      detectedMoments: [
        moment("m1", 18, 24, "event"),
        moment("m2", 22, 27, "cv"),
        moment("m3", 100, 106, "ai"),
        moment("m4", duration - 22, duration - 16, "event"),
      ],
      transcript: { status: "complete", segments: transcript(duration) } as never,
      narrativeStructure: narrative(duration),
      attentionCurve: curve(duration),
      attentionSampleRate: 1,
      audioAnalysis: undefined,
      videoType: undefined,
      editRecipe: undefined,
    },
    visualAnalysis: null,
  };
}

test("returns [] for zero / invalid duration", () => {
  assert.deepEqual(generateClips({ duration: 0 }), []);
  assert.deepEqual(generateClips({ duration: -5 }), []);
  assert.deepEqual(generateClips({ duration: NaN }), []);
});

test("very short video → exactly one whole-video edited clip", () => {
  const clips = generateClips({ duration: 14, selectedVideoType: "reels-shorts", now: NOW });
  assert.equal(clips.length, 1);
  assert.equal(clips[0].startTime, 0);
  assert.equal(clips[0].endTime, 14);
  assert.equal(clips[0].duration, 14);
  assert.equal(clips[0].exportStatus, "idle");
  assert.ok(clips[0].reason.length > 0);
});

test("long video → 3–8 clips, each with required fields", () => {
  const clips = generateClips(fullInput(180));
  assert.ok(clips.length >= 3 && clips.length <= 8, `count ${clips.length}`);
  for (const c of clips) {
    assert.ok(typeof c.id === "string" && c.id.length > 0);
    assert.ok(typeof c.title === "string" && c.title.length > 0);
    assert.ok(typeof c.reason === "string" && c.reason.length > 0);
    assert.ok(c.endTime > c.startTime);
    assert.equal(c.duration, c.endTime - c.startTime);
    assert.ok(c.score >= 0 && c.score <= 1);
    assert.ok(c.clipType in CLIP_TYPE_META);
    assert.ok(["9:16", "1:1", "4:5", "16:9"].includes(c.suggestedAspectRatio));
    assert.ok(typeof c.suggestedHookText === "string");
    assert.ok(Array.isArray(c.editOperations) && c.editOperations.length >= 1);
    assert.equal(c.editOperations[0].type, "trim");
    // Clip window is inside the media.
    assert.ok(c.startTime >= 0 && c.endTime <= 180 + 0.001);
  }
});

test("clips respect the video-type length rule (reels 15–60s)", () => {
  const clips = generateClips(fullInput(180, "reels-shorts"));
  for (const c of clips) {
    // Allow the 8s hard floor for exceptional clips, but none should exceed max*1.4.
    assert.ok(c.duration >= 8, `too short: ${c.duration}`);
    assert.ok(c.duration <= 60 * 1.4, `too long for reels: ${c.duration}`);
  }
});

test("podcast clips run longer than reels clips (per length rule)", () => {
  // Same source, different video type: podcast's ideal window (50s) is longer
  // than reels' (28s), so podcast clips should be longer on average — and each
  // stays within its own max (podcast 90s, reels 60s, ×1.4 snap tolerance).
  const podcast = generateClips(fullInput(300, "podcast-clip"));
  const reels = generateClips(fullInput(300, "reels-shorts"));
  const avg = (cs: { duration: number }[]) => cs.reduce((a, c) => a + c.duration, 0) / cs.length;
  assert.ok(
    avg(podcast) > avg(reels) + 5,
    `podcast avg ${avg(podcast).toFixed(1)} should exceed reels avg ${avg(reels).toFixed(1)}`
  );
  for (const c of podcast) assert.ok(c.duration <= 90 * 1.4 + 0.01, `podcast too long: ${c.duration}`);
  for (const c of reels) assert.ok(c.duration <= 60 * 1.4 + 0.01, `reels too long: ${c.duration}`);
});

test("clips are sorted by start time and don't heavily overlap", () => {
  const clips = generateClips(fullInput(240));
  for (let i = 1; i < clips.length; i++) {
    assert.ok(clips[i].startTime >= clips[i - 1].startTime, "not sorted");
    // No clip should start before the previous one ends by more than a little.
    const overlap = clips[i - 1].endTime - clips[i].startTime;
    const minLen = Math.min(clips[i].duration, clips[i - 1].duration);
    assert.ok(overlap <= 0.4 * minLen + 0.5, `too much overlap at ${i}`);
  }
});

test("transcript boundaries: clip starts/ends align to sentence edges", () => {
  const clips = generateClips(fullInput(180));
  // Sentences are at 10s multiples → snapped edges should be near multiples of 10.
  for (const c of clips) {
    const startRem = c.startTime % 10;
    const endRem = c.endTime % 10;
    assert.ok(
      Math.min(startRem, 10 - startRem) < 0.5,
      `start ${c.startTime} not on a sentence boundary`
    );
    assert.ok(
      Math.min(endRem, 10 - endRem) < 0.5 || Math.abs(c.endTime - 180) < 0.5,
      `end ${c.endTime} not on a sentence boundary`
    );
  }
});

test("deterministic — same input yields identical output", () => {
  const a = generateClips(fullInput(200));
  const b = generateClips(fullInput(200));
  assert.deepEqual(a, b);
});

test("resolveClipVideoType maps auto → detected type, else passes through", () => {
  assert.equal(resolveClipVideoType("podcast-clip", undefined), "podcast-clip");
  assert.equal(resolveClipVideoType("auto", "saas-demo"), "product-demo");
  assert.equal(resolveClipVideoType("auto", "vertical-short"), "reels-shorts");
  assert.equal(resolveClipVideoType("auto", undefined), "reels-shorts");
  assert.equal(resolveClipVideoType(undefined, "coding-tutorial"), "tutorial");
});

test("clipRangeCutMoments carves the window with synthetic cuts", () => {
  // Mid window → lead + tail cut.
  const mid = clipRangeCutMoments(30, 90, 180);
  assert.equal(mid.length, 2);
  assert.equal(mid[0].effectType, "cut");
  assert.equal(mid[0].startTime, 0);
  assert.equal(mid[0].endTime, 30);
  assert.equal(mid[1].startTime, 90);
  assert.equal(mid[1].endTime, 180);
  assert.equal(mid[0].cut?.active, true);

  // Window at the very start → only a tail cut.
  const head = clipRangeCutMoments(0, 60, 180);
  assert.equal(head.length, 1);
  assert.equal(head[0].startTime, 60);

  // Whole video → no cuts.
  assert.equal(clipRangeCutMoments(0, 180, 180).length, 0);

  // Inverted range is normalized, not crashed.
  const inv = clipRangeCutMoments(90, 30, 180);
  assert.ok(inv.every((m) => m.endTime > m.startTime));
});

test("works with NO structural signals (fallback windows)", () => {
  const clips = generateClips({ duration: 120, selectedVideoType: "reels-shorts", now: NOW });
  assert.ok(clips.length >= 1, `fallback produced ${clips.length}`);
  for (const c of clips) assert.ok(c.endTime > c.startTime);
});

/* ── Never a silent empty ────────────────────────────────────────────────── */

test("below the 8s floor is the ONLY empty — and it says why", () => {
  const out = generateClipsDetailed({ duration: 5, now: NOW });
  assert.deepEqual(out.clips, []);
  assert.equal(out.reasonCode, "source_too_short");
  assert.equal(
    clipGenMessage(out.reasonCode, 0),
    "No clips can be generated because the video is shorter than 8 seconds."
  );

  const noDuration = generateClipsDetailed({ duration: 0, now: NOW });
  assert.deepEqual(noDuration.clips, []);
  assert.equal(noDuration.reasonCode, "no_duration");
});

test("every analyzed video above 20s produces at least one clip, whatever the signals", () => {
  // A sweep over the shapes a real project actually arrives in.
  const shapes: Array<[string, ClipGenInput]> = [
    ["full signals", fullInput(180)],
    ["no analysis at all", { duration: 90, now: NOW }],
    [
      "analysis present but empty",
      {
        duration: 90,
        now: NOW,
        analysis: {
          detectedMoments: [],
          transcript: undefined,
          narrativeStructure: [],
          attentionCurve: undefined,
          attentionSampleRate: undefined,
          audioAnalysis: undefined,
          videoType: undefined,
          editRecipe: undefined,
        } as never,
      },
    ],
    [
      "only cuts + speed-ups (nothing clusterable)",
      {
        duration: 75,
        now: NOW,
        analysis: {
          detectedMoments: [
            { ...moment("c1", 10, 12), effectType: "cut" },
            { ...moment("c2", 40, 42), effectType: "speed-up" },
          ],
          transcript: undefined,
          narrativeStructure: [],
          attentionCurve: undefined,
          attentionSampleRate: undefined,
          audioAnalysis: undefined,
          videoType: undefined,
          editRecipe: undefined,
        } as never,
      },
    ],
    [
      "narrative beats all too short to fit the rule",
      {
        duration: 60,
        now: NOW,
        analysis: {
          detectedMoments: [],
          transcript: undefined,
          narrativeStructure: [
            { startTime: 0, endTime: 1, role: "transition", label: "T" },
            { startTime: 1, endTime: 2, role: "filler", label: "F" },
          ],
          attentionCurve: undefined,
          attentionSampleRate: undefined,
          audioAnalysis: undefined,
          videoType: undefined,
          editRecipe: undefined,
        } as never,
      },
    ],
  ];

  for (const [name, inp] of shapes) {
    const out = generateClipsDetailed(inp);
    assert.ok(out.clips.length >= 1, `"${name}" returned zero clips`);
    assert.ok(["ok", "fallback"].includes(out.reasonCode), `"${name}" → ${out.reasonCode}`);
    for (const c of out.clips) {
      assert.ok(c.endTime > c.startTime, `"${name}" produced a degenerate window`);
      assert.ok(c.endTime <= inp.duration + 0.001, `"${name}" ran past the media`);
      assert.ok(c.reason.length > 0, `"${name}" produced an unexplained clip`);
    }
  }
});

/* ── Fallback ────────────────────────────────────────────────────────────── */

test("no strong moments → 1–3 fallback clips, flagged and explained", () => {
  const out = generateClipsDetailed({
    duration: 90,
    selectedVideoType: "reels-shorts",
    now: NOW,
    analysis: {
      detectedMoments: [],
      transcript: undefined,
      narrativeStructure: [],
      attentionCurve: undefined,
      attentionSampleRate: undefined,
      audioAnalysis: undefined,
      videoType: undefined,
      editRecipe: undefined,
    } as never,
  });

  assert.equal(out.fallbackUsed, true);
  assert.equal(out.reasonCode, "fallback");
  assert.ok(out.clips.length >= 1 && out.clips.length <= 3, `got ${out.clips.length}`);
  for (const c of out.clips) {
    assert.equal(c.fallback, true, "a fallback clip must say so");
    assert.match(c.reason, /fallback/i);
  }
  // Evenly spaced when there's nothing at all to rank on.
  assert.ok(out.clips.every((c) => c.signals?.includes("evenly spaced window")));
});

test("fallback aims at the highest-attention windows when an attention curve exists", () => {
  // Attention peaks hard at 60s. Tested against the fallback directly: with a
  // curve present the SCORED path normally wins, so this branch only ever runs
  // when scoring comes back empty — but it still has to aim at the peak.
  const attentionCurve: number[] = [];
  for (let t = 0; t < 120; t++) {
    const peak = Math.max(0, 1 - Math.abs(t - 60) / 10);
    attentionCurve.push(Math.round(Math.min(1, 0.05 + 0.9 * peak) * 255));
  }

  const clips = generateFallbackClips({
    duration: 120,
    selectedVideoType: "reels-shorts",
    now: NOW,
    analysis: {
      detectedMoments: [],
      transcript: undefined,
      narrativeStructure: [],
      attentionCurve,
      attentionSampleRate: 1,
      audioAnalysis: undefined,
      videoType: undefined,
      editRecipe: undefined,
    } as never,
  });

  assert.ok(clips.length >= 1 && clips.length <= 3);
  assert.ok(
    clips.some((c) => c.startTime <= 60 && c.endTime >= 60),
    `no fallback clip covers the attention peak (got ${clips
      .map((c) => `${c.startTime}-${c.endTime}`)
      .join(", ")})`
  );
  assert.ok(clips.every((c) => c.signals?.includes("highest-attention window")));
  assert.ok(clips.every((c) => c.fallback === true));
});

test("fallback falls back to edit density when there is no attention curve", () => {
  const edits: DetectedMoment[] = [
    { ...moment("z1", 70, 74), effectType: "zoom" },
    { ...moment("t1", 72, 76), effectType: "text-overlay" },
    { ...moment("cap", 70, 78), effectType: "captions" },
  ];
  const clips = generateFallbackClips({
    duration: 150,
    selectedVideoType: "reels-shorts",
    now: NOW,
    analysis: {
      detectedMoments: edits,
      transcript: undefined,
      narrativeStructure: [],
      attentionCurve: undefined,
      attentionSampleRate: undefined,
      audioAnalysis: undefined,
      videoType: undefined,
      editRecipe: undefined,
    } as never,
  });

  assert.ok(
    clips.some((c) => c.startTime <= 74 && c.endTime >= 74),
    "a fallback clip should sit on the densest edit activity"
  );
  assert.ok(clips.some((c) => c.signals?.includes("densest edit activity")));
});

test("existing AI edits alone can produce clip windows (no transcript, no attention)", () => {
  // A dense burst of real timeline edits at ~70s and nothing else to go on.
  const edits: DetectedMoment[] = [
    { ...moment("z1", 70, 74), effectType: "zoom" },
    { ...moment("t1", 72, 76), effectType: "text-overlay" },
    { ...moment("h1", 71, 73), effectType: "hook-text" },
    { ...moment("cap", 70, 78), effectType: "captions" },
    { ...moment("cta", 74, 78), effectType: "branding-cta" },
  ];

  const out = generateClipsDetailed({
    duration: 150,
    selectedVideoType: "reels-shorts",
    now: NOW,
    analysis: {
      detectedMoments: edits,
      transcript: undefined,
      narrativeStructure: [],
      attentionCurve: undefined,
      attentionSampleRate: undefined,
      audioAnalysis: undefined,
      videoType: undefined,
      editRecipe: undefined,
    } as never,
  });

  assert.ok(out.clips.length >= 1, "edit density alone should yield clips");
  assert.ok(
    out.clips.some((c) => c.startTime <= 74 && c.endTime >= 74),
    "a clip should cover the dense edit cluster at ~70–78s"
  );
});

test("a missing transcript never blocks generation", () => {
  const withText = generateClipsDetailed(fullInput(180));
  const noText = generateClipsDetailed({
    ...fullInput(180),
    analysis: { ...fullInput(180).analysis!, transcript: undefined },
  });

  assert.ok(noText.clips.length >= 1, "no transcript must still generate");
  assert.equal(noText.stats.transcriptAvailable, false);
  assert.equal(withText.stats.transcriptAvailable, true);
  // Titles fall back to timestamps rather than quotes — but clips still exist.
  for (const c of noText.clips) assert.ok(c.title.length > 0);
});

test("a very short (but cuttable) video gets exactly one edited version", () => {
  const out = generateClipsDetailed({ duration: 14, selectedVideoType: "reels-shorts", now: NOW });
  assert.equal(out.clips.length, 1);
  assert.equal(out.reasonCode, "ok");
  assert.equal(out.clips[0].startTime, 0);
  assert.equal(out.clips[0].endTime, 14);
  assert.match(out.clips[0].title, /Edited/);
});

/* ── Stats (what gets logged — counts only) ──────────────────────────────── */

test("stats carry counts only — never transcript text", () => {
  const out = generateClipsDetailed(fullInput(180));
  assert.deepEqual(Object.keys(out.stats).sort(), [
    "attentionSamples",
    "clipCount",
    "durationSeconds",
    "fallbackUsed",
    "momentCount",
    "transcriptAvailable",
  ]);
  assert.equal(out.stats.durationSeconds, 180);
  assert.equal(out.stats.momentCount, 4);
  assert.equal(out.stats.transcriptAvailable, true);
  assert.equal(out.stats.attentionSamples, 180);
  assert.equal(out.stats.clipCount, out.clips.length);

  for (const v of Object.values(out.stats)) {
    assert.ok(typeof v === "number" || typeof v === "boolean", "stats must be counts/flags only");
  }
});

test("clipGenMessage singularizes a one-clip result", () => {
  assert.equal(clipGenMessage("ok", 1), "1 smart clip generated");
  assert.equal(clipGenMessage("ok", 5), "5 smart clips generated");
  assert.equal(clipGenMessage("fallback", 1), "Could not find strong moments, so 1 fallback clip was created");
});
