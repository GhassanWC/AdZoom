/**
 * The AI Editor — editorial decision engine.
 *
 * These tests pin the behaviour the engine exists to guarantee: that an edit
 * which cannot justify itself does not reach the timeline, that "no edit" is a
 * reachable outcome, that judgment is made across the WHOLE video rather than
 * per chunk, and that the engine never overrules a human.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideTimeline,
  editorialMaxEdits,
  isEditorialJustification,
  EDITORIAL_JUSTIFICATIONS,
  type EditorialContext,
} from "../src/lib/analysis/editorial-decision.ts";
import type { DetectedMoment, EffectType } from "../src/lib/firebase/schema.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

function moment(over: Partial<DetectedMoment> & { id: string; startTime: number }): DetectedMoment {
  return {
    endTime: over.startTime + 1.5,
    effectType: "zoom" as EffectType,
    reason: "Emphasises the button the user just clicked",
    confidenceScore: 0.8,
    provenance: "cv",
    ...over,
  } as DetectedMoment;
}

/** A 160s video with clicks every 10s, so grounding is available throughout. */
function ctx(over: Partial<EditorialContext> = {}): EditorialContext {
  return {
    duration: 160,
    pacing: "moderate",
    videoType: "saas-demo",
    clickTimes: Array.from({ length: 16 }, (_, i) => i * 10),
    // Flat-but-not-dead attention so nothing is dropped merely for being quiet.
    attentionCurve: new Array(160).fill(Math.round(0.6 * 255)),
    attentionSampleRate: 1,
    ...over,
  };
}

const keptIds = (r: { kept: DetectedMoment[] }) => r.kept.map((m) => m.id);

// ── Per-edit justification ──────────────────────────────────────────────────

test("an edit whose reason is just its own type restated is dropped", () => {
  const r = decideTimeline([moment({ id: "a", startTime: 10, reason: "Zoom" })], ctx());
  assert.deepEqual(keptIds(r), []);
  assert.equal(r.rejected[0]?.rejectedReason, "no-justification");
});

test("an edit below the confidence bar is dropped — no edit beats a guess", () => {
  const r = decideTimeline([moment({ id: "a", startTime: 10, confidenceScore: 0.2 })], ctx());
  assert.deepEqual(keptIds(r), []);
  assert.equal(r.rejected[0]?.rejectedReason, "low-confidence");
});

test("a zoom with nothing in the footage behind it is dropped", () => {
  // No clicks, no scene changes, low attention → nothing grounds an emphasis edit.
  const r = decideTimeline(
    [moment({ id: "a", startTime: 10, provenance: "ai" })],
    ctx({ clickTimes: [], attentionCurve: new Array(160).fill(Math.round(0.3 * 255)) })
  );
  assert.deepEqual(keptIds(r), []);
  assert.equal(r.rejected[0]?.rejectedReason, "not-grounded");
});

test("a zoom that emphasises a boring stretch is dropped as distracting", () => {
  const r = decideTimeline(
    [moment({ id: "a", startTime: 10 })],
    ctx({ boringSections: [{ startTime: 5, endTime: 20 }] })
  );
  assert.deepEqual(keptIds(r), []);
  assert.equal(r.rejected[0]?.rejectedReason, "distracting");
});

// ── The asymmetry that makes cuts work ──────────────────────────────────────

test("a CUT over a boring stretch is KEPT — that section is why it exists", () => {
  // The mirror of the test above. Judging pacing edits by "is something
  // happening here?" would delete exactly the cuts that are doing their job.
  const r = decideTimeline(
    [moment({ id: "a", startTime: 10, effectType: "cut" as EffectType, reason: "Removes a dead stretch with no narration" })],
    ctx({ boringSections: [{ startTime: 5, endTime: 20 }] })
  );
  assert.deepEqual(keptIds(r), ["a"]);
  assert.equal(r.kept[0]?.justification, "pacing");
});

test("a cut over genuinely busy footage is dropped", () => {
  // The curve must actually VARY for "busy" to mean anything — a constant
  // curve carries no information and attention correctly abstains from it
  // (see the relative-attention tests below). Here the video is mostly quiet
  // with a busy band at 5–15s, and the cut lands right in it.
  const curve = Array.from({ length: 160 }, (_, i) =>
    Math.round((i >= 5 && i <= 15 ? 0.9 : 0.1) * 255)
  );
  const r = decideTimeline(
    [moment({ id: "a", startTime: 10, effectType: "cut" as EffectType, reason: "Removes a dead stretch with no narration" })],
    ctx({ attentionCurve: curve, attentionSampleRate: 1 })
  );
  assert.deepEqual(keptIds(r), [], "cutting away from the busiest moment is not editing");
  assert.equal(r.rejected[0]?.rejectedReason, "not-grounded");
});

// ── Q3 — best edit for this moment, or none ─────────────────────────────────

test("two edits competing for the same beat collapse to the stronger one", () => {
  const r = decideTimeline(
    [
      moment({ id: "weak", startTime: 10, confidenceScore: 0.5 }),
      moment({ id: "strong", startTime: 10.8, confidenceScore: 0.95 }),
    ],
    ctx()
  );
  assert.deepEqual(keptIds(r), ["strong"]);
  assert.equal(r.rejected[0]?.id, "weak");
  assert.equal(r.rejected[0]?.rejectedReason, "crowded");
});

// ── Q4 — whole-video rhythm and density ─────────────────────────────────────

test("a flood of per-chunk candidates is cut below the ceiling", () => {
  // 60 individually-defensible zooms, one every 2.5s — exactly the shape the
  // per-chunk engines produce today. A professional pass keeps a fraction.
  const flood = Array.from({ length: 60 }, (_, i) =>
    moment({ id: `m${i}`, startTime: i * 2.5, confidenceScore: 0.6 + (i % 10) / 50 })
  );
  const c = ctx();
  const r = decideTimeline(flood, c);
  const ceiling = editorialMaxEdits(c);
  assert.ok(r.kept.length <= ceiling, `kept ${r.kept.length}, ceiling ${ceiling}`);
  assert.ok(ceiling <= 20, `a >2min video should cap at ≤20 edits, got ${ceiling}`);
  // Deliberately NOT asserting a lower bound — see the "no floor" tests below.
  assert.ok(r.kept.length > 0, "grounded, well-spaced edits should be able to survive");
});

test("surviving edits respect whole-video spacing, not per-chunk spacing", () => {
  const flood = Array.from({ length: 60 }, (_, i) => moment({ id: `m${i}`, startTime: i * 2.5 }));
  const r = decideTimeline(flood, ctx());
  const starts = r.kept.map((m) => m.startTime).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(
      starts[i] - starts[i - 1] >= 7,
      `edits at ${starts[i - 1]}s and ${starts[i]}s are closer than the pacing profile allows`
    );
  }
});

test("edits are spread across the video, not clustered in one busy stretch", () => {
  // Every candidate is grounded, but they all sit in the first 40s. The engine
  // must not simply fill the budget from the front.
  const front = Array.from({ length: 40 }, (_, i) => moment({ id: `f${i}`, startTime: i }));
  const spread = Array.from({ length: 12 }, (_, i) => moment({ id: `s${i}`, startTime: 50 + i * 9 }));
  const r = decideTimeline([...front, ...spread], ctx());
  const late = r.kept.filter((m) => m.startTime >= 50).length;
  assert.ok(late > 0, "the back half of the video should not be left empty");
});

// ── "No edit" is a valid outcome ────────────────────────────────────────────

test("a timeline of entirely unjustifiable edits returns NO edits", () => {
  const junk = Array.from({ length: 25 }, (_, i) =>
    moment({ id: `j${i}`, startTime: i * 4, reason: "Zoom", confidenceScore: 0.9 })
  );
  const r = decideTimeline(junk, ctx());
  assert.deepEqual(keptIds(r), [], "nothing here earned a place; the engine must return none");
  assert.equal(r.rejected.length, 25);
});

// ── Never overrule a human, never double-judge ──────────────────────────────

test("a user's own edit is never touched, however unjustifiable it looks", () => {
  const r = decideTimeline(
    [moment({ id: "mine", startTime: 10, provenance: "user", reason: "x", confidenceScore: 0 })],
    ctx({ boringSections: [{ startTime: 0, endTime: 160 }] })
  );
  assert.deepEqual(keptIds(r), ["mine"]);
  assert.equal(r.rejected.length, 0);
});

test("a Director-planned edit passes through — it was already judged", () => {
  const r = decideTimeline(
    [moment({ id: "d1", startTime: 10, source: "ai-director", reason: "x", confidenceScore: 0 })],
    ctx()
  );
  assert.deepEqual(keptIds(r), ["d1"]);
});

test("captions and structural overlays are not judged by this engine", () => {
  const r = decideTimeline(
    [
      moment({ id: "cap", startTime: 5, effectType: "captions" as EffectType, reason: "x" }),
      moment({ id: "hook", startTime: 0, effectType: "hook-text" as EffectType, reason: "x" }),
    ],
    ctx()
  );
  assert.deepEqual(keptIds(r).sort(), ["cap", "hook"]);
});

// ── Every surviving edit can explain itself ─────────────────────────────────

test("every judged edit that survives carries a justification and a reason", () => {
  const flood = Array.from({ length: 40 }, (_, i) => moment({ id: `m${i}`, startTime: i * 4 }));
  const r = decideTimeline(flood, ctx());
  const judged = r.kept.filter((m) => m.provenance !== "user" && m.effectType !== "captions");
  assert.ok(judged.length > 0);
  for (const m of judged) {
    assert.ok(
      isEditorialJustification(m.justification),
      `${m.id} reached the timeline with no justification`
    );
    assert.ok(
      (m.editorialReason ?? "").length > 10,
      `${m.id} reached the timeline with no explanation`
    );
  }
});

test("every rejected edit is recoverable and says why it was cut", () => {
  const flood = Array.from({ length: 40 }, (_, i) => moment({ id: `m${i}`, startTime: i * 2 }));
  const r = decideTimeline(flood, ctx());
  assert.ok(r.rejected.length > 0);
  for (const m of r.rejected) {
    assert.equal(m.rejected, true);
    assert.ok((m.rejectedReason ?? "").length > 0, `${m.id} has no rejection tag`);
    assert.ok((m.editorialReason ?? "").length > 10, `${m.id} has no rejection explanation`);
  }
});

test("justifications come from the shared Director vocabulary", () => {
  const r = decideTimeline([moment({ id: "a", startTime: 10 })], ctx());
  assert.ok(EDITORIAL_JUSTIFICATIONS.includes(r.kept[0]!.justification!));
});

// ── The density model ───────────────────────────────────────────────────────

test("the ceiling honours the balancer's duration brackets", () => {
  assert.ok(editorialMaxEdits(ctx({ duration: 20 })) <= 6);
  assert.ok(editorialMaxEdits(ctx({ duration: 90 })) <= 12);
  assert.ok(editorialMaxEdits(ctx({ duration: 300 })) <= 20);
  // Slow pacing must never permit more than fast pacing.
  assert.ok(
    editorialMaxEdits(ctx({ pacing: "slow" })) <= editorialMaxEdits(ctx({ pacing: "fast" }))
  );
});

test("a calm video type permits fewer edits than a punchy one", () => {
  const calm = editorialMaxEdits(ctx({ videoType: "talking-tutorial" }));
  const punchy = editorialMaxEdits(ctx({ videoType: "vertical-short" }));
  assert.ok(calm <= punchy, `talking-tutorial ${calm} should be ≤ vertical-short ${punchy}`);
});

// ── Density is a CEILING — never a floor, never a target ────────────────────

test("a video justifying only two edits keeps exactly two — never padded up", () => {
  // The ceiling for this video is well above 2. Nothing may invent edits to
  // close that gap.
  const c = ctx();
  const ceiling = editorialMaxEdits(c);
  assert.ok(ceiling > 2, `precondition: ceiling ${ceiling} should exceed 2`);
  const r = decideTimeline(
    [moment({ id: "a", startTime: 20 }), moment({ id: "b", startTime: 80 })],
    c
  );
  assert.equal(r.kept.length, 2, "kept count must equal what the footage justified");
});

test("a single justified edit stays a single edit on a long video", () => {
  const r = decideTimeline([moment({ id: "only", startTime: 70 })], ctx({ duration: 600 }));
  assert.deepEqual(keptIds(r), ["only"]);
});

test("a sparse timeline is never topped up from the rejected pool", () => {
  // One good edit, plus candidates that each fail judgment. The failures must
  // stay rejected even though the video is far under its ceiling.
  const r = decideTimeline(
    [
      moment({ id: "good", startTime: 20 }),
      moment({ id: "bad1", startTime: 60, reason: "Zoom" }),
      moment({ id: "bad2", startTime: 100, confidenceScore: 0.1 }),
    ],
    ctx()
  );
  assert.deepEqual(keptIds(r), ["good"]);
  assert.equal(r.rejected.length, 2);
});

test("the ceiling never forces a minimum, even on a short video", () => {
  // The old target-based model floored short videos at 3 edits. A 25s clip
  // with one justified edit must keep one.
  const r = decideTimeline(
    [moment({ id: "a", startTime: 10 })],
    ctx({ duration: 25, clickTimes: [10], attentionCurve: new Array(25).fill(153) })
  );
  assert.equal(r.kept.length, 1);
});

test("the engine can only ever remove — output never exceeds input", () => {
  for (const n of [0, 1, 5, 30, 90]) {
    const input = Array.from({ length: n }, (_, i) => moment({ id: `m${i}`, startTime: i * 1.7 }));
    const r = decideTimeline(input, ctx());
    assert.ok(r.kept.length <= input.length, `${n} in → ${r.kept.length} out`);
    assert.equal(r.kept.length + r.rejected.length, n, "every candidate is accounted for");
  }
});

// ── Attention is judged RELATIVE to the video ───────────────────────────────
// Both regressions below were found by running the engine end-to-end against a
// real production project; neither was reachable with synthetic fixtures.

test("a low-motion video is not wiped out by an absolute attention threshold", () => {
  // Real measured shape of a talking-head video: the WHOLE curve spans
  // 0.024–0.192. An absolute "flat below 0.18" test called 99% of it dead air
  // and dropped every single camera edit — 42 candidates, 0 kept.
  const curve = Array.from({ length: 160 }, (_, i) =>
    Math.round((0.03 + (i % 20 === 0 ? 0.16 : 0.01)) * 255)
  );
  const candidates = Array.from({ length: 12 }, (_, i) =>
    moment({ id: `m${i}`, startTime: i * 20, provenance: "cv" })
  );
  const r = decideTimeline(
    candidates,
    ctx({
      attentionCurve: curve,
      attentionSampleRate: 1,
      clickTimes: [],
      sceneChanges: Array.from({ length: 12 }, (_, i) => i * 20),
    })
  );
  assert.ok(
    r.kept.length > 0,
    "a low-motion video must still be able to carry edits — attention is relative, not absolute"
  );
});

test("a featureless attention curve abstains instead of vetoing everything", () => {
  // No variation at all → the signal carries no information. It must not be
  // the thing that disqualifies an edit.
  const flat = new Array(160).fill(Math.round(0.04 * 255));
  const r = decideTimeline(
    [moment({ id: "a", startTime: 20, provenance: "event" })],
    ctx({ attentionCurve: flat, attentionSampleRate: 1, clickTimes: [], sceneChanges: [] })
  );
  assert.deepEqual(keptIds(r), ["a"]);
});

test("repeated narrative roles get independent budgets, not a shared one", () => {
  // A video routinely has several "explanation" beats. Keying the per-section
  // budget by ROLE made them share one counter: the cap was breached in one
  // section while later ones were locked out entirely.
  const narrative = [
    { startTime: 0, endTime: 40, role: "explanation" as const, label: "a" },
    { startTime: 40, endTime: 80, role: "explanation" as const, label: "b" },
    { startTime: 80, endTime: 120, role: "explanation" as const, label: "c" },
    { startTime: 120, endTime: 160, role: "explanation" as const, label: "d" },
  ];
  const candidates = Array.from({ length: 32 }, (_, i) =>
    moment({ id: `m${i}`, startTime: i * 5 })
  );
  const r = decideTimeline(candidates, ctx({ narrativeStructure: narrative }));
  const occupied = new Set(
    r.kept.map((m) => narrative.findIndex((s) => m.startTime >= s.startTime && m.startTime < s.endTime))
  );
  assert.ok(
    occupied.size >= 3,
    `edits should reach at least 3 of the 4 same-role beats, reached ${occupied.size}`
  );
  for (const d of r.log.distribution) {
    assert.ok(d.kept <= d.cap, `section ${d.label} kept ${d.kept} over its cap ${d.cap}`);
  }
});

// ── Degenerate inputs ───────────────────────────────────────────────────────

test("an empty timeline is a no-op", () => {
  const r = decideTimeline([], ctx());
  assert.deepEqual(r.kept, []);
  assert.deepEqual(r.rejected, []);
});

test("a video with no understanding signals still judges without crashing", () => {
  const r = decideTimeline(
    [moment({ id: "a", startTime: 10, provenance: "event" })],
    { duration: 60, pacing: "moderate" }
  );
  assert.equal(r.kept.length + r.rejected.length, 1);
});
