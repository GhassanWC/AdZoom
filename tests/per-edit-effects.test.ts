/**
 * Per-edit effects — the settings that moved OFF the global Effects panel and
 * ONTO the selected timeline edit.
 *
 * Two invariants matter more than the features themselves:
 *
 *   1. NO SILENT RE-RENDER. Every existing project has moments with no
 *      `cameraMotion` and no `clickHighlight`. They must render byte-for-byte as
 *      before — adding a field must never quietly change a video the user already
 *      finished and exported.
 *   2. ONE RESOLUTION, FOUR ENGINES. Preview, browser export, the Cloud Run
 *      worker and Remotion all resolve a click's look through
 *      `resolveClickHighlight`, and all four resolve the camera through
 *      `cameraForMoment`. These test those single sources of truth, which is what
 *      makes preview/export parity structural instead of hoped-for.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cameraForMoment,
  rampSeconds,
  CAMERA_SPEED_DEFAULT,
} from "../src/lib/timeline/camera.ts";
import { resolveClickHighlight } from "../src/lib/render/click-highlight.ts";
import type { DetectedMoment, EffectsSettings } from "../src/lib/firebase/schema.ts";

function moment(over: Partial<DetectedMoment> = {}): DetectedMoment {
  return {
    id: "m1",
    startTime: 2,
    endTime: 6,
    label: "Zoom",
    reason: "test",
    focusRegion: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
    effectType: "zoom",
    ...over,
  } as DetectedMoment;
}

const DEFAULTS: Parameters<typeof resolveClickHighlight>[1] = {
  clickHighlights: true,
  clickHighlightStyle: "ring",
  clickHighlightSize: 60,
};

// ── 1. The ramp ────────────────────────────────────────────────────────────

test("no cameraMotion renders EXACTLY as before — the default is a no-op", () => {
  for (const dur of [0.3, 1, 4, 30]) {
    assert.equal(
      rampSeconds(dur, undefined),
      rampSeconds(dur, CAMERA_SPEED_DEFAULT),
      `speed ${CAMERA_SPEED_DEFAULT} must equal "unset" at duration ${dur}`
    );
  }
});

test("an untouched slider changes not one pixel of the camera", () => {
  const plain = moment();
  const defaulted = moment({ cameraMotion: { speed: CAMERA_SPEED_DEFAULT } });
  for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    assert.deepEqual(
      cameraForMoment(defaulted, 0.8, p),
      cameraForMoment(plain, 0.8, p),
      `camera diverged at local progress ${p}`
    );
  }
});

test("higher speed = shorter ramp, lower speed = longer ramp (monotonic)", () => {
  const dur = 4;
  const speeds = [0, 20, 40, 50, 60, 80, 100];
  const ramps = speeds.map((s) => rampSeconds(dur, s));
  for (let i = 1; i < ramps.length; i++) {
    assert.ok(
      ramps[i] < ramps[i - 1],
      `ramp must shrink as speed rises: speed ${speeds[i]} gave ${ramps[i]}, speed ${speeds[i - 1]} gave ${ramps[i - 1]}`
    );
  }
});

test("the ramp is never zero — a hard cut would flicker", () => {
  for (const dur of [0.2, 1, 10]) {
    for (const speed of [0, 50, 100]) {
      assert.ok(rampSeconds(dur, speed) > 0, `zero ramp at dur=${dur} speed=${speed}`);
    }
  }
});

test("a snappy edit reaches full zoom sooner than a slow one", () => {
  // Same moment, same instant (10% in). The snappier camera must already be
  // deeper into its zoom than the cinematic one — that IS the feature.
  const at = 0.1;
  const snappy = cameraForMoment(moment({ cameraMotion: { speed: 100 } }), 0.8, at);
  const slow = cameraForMoment(moment({ cameraMotion: { speed: 0 } }), 0.8, at);
  assert.ok(
    snappy.scale > slow.scale,
    `snappy=${snappy.scale} should exceed slow=${slow.scale} at ${at * 100}% in`
  );
});

test("every speed still lands on the SAME framing mid-edit — speed is the ramp, not the target", () => {
  const mid = 0.5;
  const target = cameraForMoment(moment(), 0.8, mid);
  for (const speed of [0, 25, 75, 100]) {
    const c = cameraForMoment(moment({ cameraMotion: { speed } }), 0.8, mid);
    assert.ok(
      Math.abs(c.scale - target.scale) < 1e-9,
      `speed ${speed} changed the held framing (${c.scale} vs ${target.scale})`
    );
  }
});

// ── 2. The click highlight ─────────────────────────────────────────────────

test("a click with no override wears the project's look", () => {
  const r = resolveClickHighlight(moment({ effectType: "click-highlight" }), DEFAULTS);
  assert.deepEqual(r, { style: "ring", sizePct: 60 });
});

test("a click's own style and size beat the project's", () => {
  const r = resolveClickHighlight(
    moment({ effectType: "click-highlight", clickHighlight: { style: "burst", size: 90 } }),
    DEFAULTS
  );
  assert.deepEqual(r, { style: "burst", sizePct: 90 });
});

test("a partial override falls back per-field, not all-or-nothing", () => {
  const r = resolveClickHighlight(
    moment({ effectType: "click-highlight", clickHighlight: { style: "pulse" } }),
    DEFAULTS
  );
  assert.deepEqual(r, { style: "pulse", sizePct: 60 }, "size should still be the project's");
});

test("hiding ONE click hides only that click", () => {
  const hidden = resolveClickHighlight(
    moment({ effectType: "click-highlight", enabled: false }),
    DEFAULTS
  );
  const shown = resolveClickHighlight(
    moment({ effectType: "click-highlight", enabled: true }),
    DEFAULTS
  );
  assert.equal(hidden, null);
  assert.ok(shown);
});

test("absent `enabled` means shown — older docs never carried the flag", () => {
  assert.ok(resolveClickHighlight(moment({ effectType: "click-highlight" }), DEFAULTS));
});

test("the project switch still turns every click off", () => {
  const r = resolveClickHighlight(
    moment({ effectType: "click-highlight", clickHighlight: { style: "burst" } }),
    { ...DEFAULTS, clickHighlights: false }
  );
  assert.equal(r, null, "a per-edit style must not resurrect a globally-disabled highlight");
});

test("nothing is drawn for a moment that isn't a click", () => {
  assert.equal(resolveClickHighlight(moment({ effectType: "zoom" }), DEFAULTS), null);
  assert.equal(resolveClickHighlight(null, DEFAULTS), null);
});

// ── 3. The types still describe what Firestore holds ───────────────────────

test("EffectsSettings remains the fallback a Look writes", () => {
  // The globals were not deleted — they became the DEFAULTS that per-edit
  // settings resolve against, which is what keeps Looks meaningful.
  const look: Pick<
    EffectsSettings,
    "clickHighlights" | "clickHighlightStyle" | "clickHighlightSize"
  > = { clickHighlights: true, clickHighlightStyle: "burst", clickHighlightSize: 85 };
  const r = resolveClickHighlight(moment({ effectType: "click-highlight" }), look);
  assert.deepEqual(r, { style: "burst", sizePct: 85 }, "an untouched click follows the Look");
});
