/**
 * The Smart Clips GENERATION FLOW — what happens between the click and the
 * clips: persistence, the one-run-at-a-time guard, the empty/failure reasons
 * (never a silent zero), the export-preserving regenerate, and the six
 * counts-only clips_* events.
 *
 * Run with:  npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createClipGenerationController,
  type ClipGenEventName,
  type ClipGenEventPayload,
  type ClipGenerationDeps,
} from "../src/lib/clips/clip-generation.ts";
import type { ClipGenInput } from "../src/lib/clips/clip-generator.ts";
import type { GeneratedClip, TranscriptSegment } from "../src/lib/firebase/schema.ts";

const NOW = 1_700_000_000_000;

function curve(duration: number): number[] {
  const arr: number[] = [];
  for (let t = 0; t < duration; t++) {
    const peak = Math.max(0, 1 - Math.abs(t - 40) / 15);
    arr.push(Math.round(Math.min(1, 0.3 + 0.65 * peak) * 255));
  }
  return arr;
}

function transcript(duration: number): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  for (let s = 0; s < duration; s += 10) {
    segs.push({
      id: `s${s}`,
      startTime: s,
      endTime: Math.min(duration, s + 10),
      text: `Sentence ${s / 10} about the product feature.`,
    });
  }
  return segs;
}

function input(duration = 180): ClipGenInput {
  return {
    duration,
    selectedVideoType: "reels-shorts",
    now: NOW,
    analysis: {
      detectedMoments: [],
      transcript: { status: "complete", segments: transcript(duration) } as never,
      narrativeStructure: [
        { startTime: 0, endTime: 40, role: "intro", label: "Intro" },
        { startTime: 40, endTime: 120, role: "explanation", label: "Explanation" },
        { startTime: 120, endTime: duration, role: "result", label: "Result" },
      ],
      attentionCurve: curve(duration),
      attentionSampleRate: 1,
      audioAnalysis: undefined,
      videoType: undefined,
      editRecipe: undefined,
    },
    visualAnalysis: null,
  };
}

/** A controller over an in-memory "Firestore" + a recording emitter. */
function harness(
  overrides: Partial<ClipGenerationDeps> & { initial?: GeneratedClip[] } = {}
) {
  const writes: GeneratedClip[][] = [];
  const events: Array<{ name: ClipGenEventName; payload: ClipGenEventPayload }> = [];
  const running: boolean[] = [];
  let stored: GeneratedClip[] = overrides.initial ?? [];

  const controller = createClipGenerationController({
    buildInput: overrides.buildInput ?? (() => input()),
    readClips: overrides.readClips ?? (() => stored),
    writeClips:
      overrides.writeClips ??
      (async (next) => {
        stored = next;
        writes.push(next);
      }),
    isAnalyzed: overrides.isAnalyzed ?? (() => true),
    emit: (name, payload) => events.push({ name, payload }),
    onRunningChange: (r) => running.push(r),
  });

  return {
    controller,
    writes,
    events,
    running,
    stored: () => stored,
    names: () => events.map((e) => e.name),
  };
}

function clip(over: Partial<GeneratedClip> = {}): GeneratedClip {
  return {
    id: "c1",
    title: "Old clip",
    reason: "test",
    startTime: 0,
    endTime: 30,
    duration: 30,
    score: 0.7,
    clipType: "best_hook",
    suggestedAspectRatio: "9:16",
    suggestedCaptionStyle: "clean",
    suggestedHookText: "hook",
    editOperations: [{ type: "trim", startTime: 0, endTime: 30 }],
    exportStatus: "idle",
    createdAt: NOW,
    ...over,
  };
}

/* ── Generate ────────────────────────────────────────────────────────────── */

test("generate runs the generator and SAVES the clips (the Firestore write)", async () => {
  const h = harness();
  const res = await h.controller.run({ trigger: "user" });

  assert.equal(res.status, "generated");
  assert.ok(res.count > 0, "should produce clips");
  // The clips actually reached the writer — this is the ProjectDoc.clips write.
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].length, res.count);
  assert.equal(h.stored().length, res.count);
  assert.equal(res.message, `${res.count} smart clips generated`);
});

test("a user click emits clicked → started → completed (counts only)", async () => {
  const h = harness();
  await h.controller.run({ trigger: "user" });

  assert.deepEqual(h.names(), [
    "clips_generate_clicked",
    "clips_generation_started",
    "clips_generation_completed",
  ]);

  const started = h.events.find((e) => e.name === "clips_generation_started")!.payload;
  assert.equal(started.durationSeconds, 180);
  assert.equal(started.transcriptAvailable, true);
  assert.equal(started.attentionSamples, 180);
  assert.equal(started.momentCount, 0);

  const completed = h.events.find((e) => e.name === "clips_generation_completed")!.payload;
  assert.ok(typeof completed.clipCount === "number" && completed.clipCount > 0);
  assert.equal(completed.fallbackUsed, false);

  // No user content in ANY payload — counts, booleans and short codes only.
  for (const { payload } of h.events) {
    for (const value of Object.values(payload)) {
      if (typeof value !== "string") continue;
      assert.ok(
        ["generate", "regenerate", "not_analyzed", "ok", "fallback", "source_too_short", "no_duration"].includes(
          value
        ),
        `unexpected free-text in analytics payload: ${value}`
      );
    }
  }
});

test("an auto-run does NOT emit clips_generate_clicked (only real clicks do)", async () => {
  const h = harness();
  await h.controller.run({ trigger: "auto" });
  assert.ok(!h.names().includes("clips_generate_clicked"));
  assert.ok(h.names().includes("clips_generation_completed"));
});

/* ── Loading state ───────────────────────────────────────────────────────── */

test("loading state clears after success", async () => {
  const h = harness();
  await h.controller.run();
  assert.deepEqual(h.running, [true, false]);
  assert.equal(h.controller.isRunning(), false);
});

test("loading state clears after failure — the button never sticks on 'Generating…'", async () => {
  const h = harness({
    writeClips: async () => {
      throw new Error("permission-denied: clips write rejected");
    },
  });
  const res = await h.controller.run();

  assert.equal(res.status, "failed");
  assert.equal(res.message, "Clip generation failed");
  assert.match(res.error ?? "", /permission-denied/);
  assert.deepEqual(h.running, [true, false]);
  assert.equal(h.controller.isRunning(), false);
  assert.ok(h.names().includes("clips_generation_failed"));
});

test("a failed run does not touch the existing clips", async () => {
  const existing = [clip({ id: "keep" })];
  const h = harness({
    initial: existing,
    writeClips: async () => {
      throw new Error("network");
    },
  });
  await h.controller.run({ mode: "regenerate" });
  assert.deepEqual(h.stored(), existing, "clips must survive a failed regenerate");
});

/* ── Double-click guard ──────────────────────────────────────────────────── */

test("repeated clicks while a run is in flight do not duplicate clips", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    writeClips: async (next) => {
      await gate;
      h.writes.push(next);
    },
  });

  const first = h.controller.run({ trigger: "user" });
  // Three more clicks land while the first write is still in flight.
  const others = await Promise.all([
    h.controller.run({ trigger: "user" }),
    h.controller.run({ trigger: "user" }),
    h.controller.run({ trigger: "user" }),
  ]);

  for (const r of others) {
    assert.equal(r.status, "busy", "a click during a run must be a no-op");
    assert.equal(r.count, 0);
  }

  release();
  const res = await first;
  assert.equal(res.status, "generated");
  // Exactly ONE write, so exactly one set of clips — no duplicates.
  assert.equal(h.writes.length, 1);
  assert.equal(h.names().filter((n) => n === "clips_generation_started").length, 1);
});

/* ── Regenerate ──────────────────────────────────────────────────────────── */

test("regenerate REPLACES the existing clips", async () => {
  const stale = [clip({ id: "stale", title: "Stale", startTime: 5, endTime: 25 })];
  const h = harness({ initial: stale });

  const res = await h.controller.run({ mode: "regenerate", trigger: "user" });

  assert.equal(res.status, "generated");
  assert.equal(h.writes.length, 1);
  assert.ok(!h.stored().some((c) => c.id === "stale"), "stale clip should be gone");
  assert.equal(h.stored().length, res.count);
  const clicked = h.events.find((e) => e.name === "clips_generate_clicked")!;
  assert.equal(clicked.payload.mode, "regenerate");
});

test("regenerate PRESERVES a completed export when a new clip covers the same window", async () => {
  // First run to learn the windows the generator actually produces.
  const probe = harness();
  await probe.controller.run();
  const target = probe.stored()[0];

  // That clip was exported; now regenerate over it.
  const exported = clip({
    id: "old-exported",
    startTime: target.startTime,
    endTime: target.endTime,
    exportStatus: "completed",
    exportUrl: "https://cdn.example/clip.mp4",
    exportSettingsHash: "abc123",
    exportSourceFingerprint: "fp1",
  });
  const h = harness({ initial: [exported] });
  await h.controller.run({ mode: "regenerate" });

  const same = h.stored().find(
    (c) => Math.abs(c.startTime - target.startTime) < 1 && Math.abs(c.endTime - target.endTime) < 1
  );
  assert.ok(same, "the same window should be regenerated");
  assert.equal(same.exportStatus, "completed", "completed export must ride across");
  assert.equal(same.exportUrl, "https://cdn.example/clip.mp4");
  assert.equal(same.exportSettingsHash, "abc123");

  // Clips on OTHER windows are genuinely new → idle, no borrowed download.
  for (const c of h.stored()) {
    if (c === same) continue;
    assert.equal(c.exportStatus, "idle");
    assert.equal(c.exportUrl, undefined);
  }
});

test("a plain generate does not inherit export records", async () => {
  const probe = harness();
  await probe.controller.run();
  const target = probe.stored()[0];

  const h = harness({
    initial: [
      clip({
        startTime: target.startTime,
        endTime: target.endTime,
        exportStatus: "completed",
        exportUrl: "https://cdn.example/x.mp4",
        exportSettingsHash: "h",
      }),
    ],
  });
  await h.controller.run({ mode: "generate" });
  for (const c of h.stored()) assert.equal(c.exportStatus, "idle");
});

/* ── Never a silent empty ────────────────────────────────────────────────── */

test("un-analyzed project: blocked with the exact reason, generator never runs", async () => {
  const h = harness({ isAnalyzed: () => false });
  const res = await h.controller.run({ trigger: "user" });

  assert.equal(res.status, "empty");
  assert.equal(res.reasonCode, "not_analyzed");
  assert.equal(res.message, "Analyze video first to generate smart clips.");
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.names(), ["clips_generate_clicked", "clips_generation_empty"]);
  // Never entered the running state → no stuck spinner.
  assert.deepEqual(h.running, []);
});

test("a too-short video comes back with the reason, not a bare empty", async () => {
  const h = harness({ buildInput: () => ({ duration: 5, now: NOW, analysis: null }) });
  const res = await h.controller.run({ trigger: "user" });

  assert.equal(res.status, "empty");
  assert.equal(res.reasonCode, "source_too_short");
  assert.equal(
    res.message,
    "No clips can be generated because the video is shorter than 8 seconds."
  );
  assert.equal(h.writes.length, 0, "an empty run must not wipe the clips");
  assert.ok(h.names().includes("clips_generation_empty"));
});

test("an empty run leaves existing clips intact", async () => {
  const existing = [clip({ id: "keep" })];
  const h = harness({
    initial: existing,
    buildInput: () => ({ duration: 3, now: NOW, analysis: null }),
  });
  await h.controller.run({ mode: "regenerate" });
  assert.deepEqual(h.stored(), existing);
});

/* ── Fallback ────────────────────────────────────────────────────────────── */

test("a weak-signal video still generates, and reports the fallback", async () => {
  const h = harness({
    // Analyzed, 90s, but nothing to go on: no transcript, no attention, no moments.
    buildInput: () => ({
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
    }),
  });

  const res = await h.controller.run({ trigger: "user" });

  assert.equal(res.status, "generated");
  assert.ok(res.count >= 1, "a 90s analyzed video must never produce zero clips");
  assert.equal(res.fallbackUsed, true);
  assert.match(res.message, /fallback clips? (was|were) created/);
  assert.ok(h.names().includes("clips_generation_fallback_used"));
  assert.equal(h.writes.length, 1);

  const fallbackEvt = h.events.find((e) => e.name === "clips_generation_fallback_used")!;
  assert.equal(fallbackEvt.payload.fallbackUsed, true);
  assert.equal(fallbackEvt.payload.transcriptAvailable, false);
  assert.equal(fallbackEvt.payload.attentionSamples, 0);
});
