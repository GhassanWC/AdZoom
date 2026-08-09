/**
 * Zoom quality — the properties that make a camera move look professional,
 * asserted as maths rather than eyeballed in a preview.
 *
 * The camera is a PURE function of source time, so every claim below is
 * testable without a canvas, a video element or a render: sample the resolver
 * densely and check what the curve does. That is also why these tests cover
 * preview AND all three export paths at once — preview, the browser exporter,
 * the desktop local export (it shells the worker CLI) and the cloud/Remotion
 * renderers all resolve through `resolveCameraFrame`, so a property proven here
 * holds on every surface by construction.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveCameraFrame,
  canvasTranslateFor,
  blendIntensity,
  cameraForMoment,
  IDENTITY_CAMERA,
  type CameraState,
} from "../src/lib/timeline/camera.ts";
import {
  MAX_ZOOM_SCALE,
  ZOOM_PRESETS,
  easeCinematic,
  resolveZoomProfile,
  subjectFitScale,
} from "../src/lib/timeline/zoom-presets.ts";
import { normalizeZoomTimeline } from "../src/lib/timeline/zoom-normalize.ts";
import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema.ts";
import type { DetectedMoment } from "../src/lib/firebase/schema.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

function zoom(over: Partial<DetectedMoment> = {}): DetectedMoment {
  return {
    id: "z1",
    startTime: 2,
    endTime: 6,
    label: "Zoom",
    reason: "test",
    focusRegion: { x: 0.3, y: 0.3, width: 0.25, height: 0.25 },
    effectType: "zoom",
    intensity: 0.8,
    source: "ai",
    ...over,
  } as DetectedMoment;
}

const OPTS = { autoZoom: DEFAULT_EFFECTS_SETTINGS.autoZoom, speed: 50 } as const;

/** Sample the camera every `step` seconds across `[from, to]`. */
function sample(
  moments: DetectedMoment[],
  from: number,
  to: number,
  step = 1 / 200,
  opts: Parameters<typeof resolveCameraFrame>[2] = OPTS
): { t: number; cam: CameraState }[] {
  const out: { t: number; cam: CameraState }[] = [];
  for (let t = from; t <= to + 1e-9; t += step) {
    out.push({ t, cam: resolveCameraFrame(moments, t, opts).camera });
  }
  return out;
}

/** Largest per-step change in scale / focal centre across a sampled run. */
function maxDelta(samples: { cam: CameraState }[]): {
  scale: number;
  cx: number;
  cy: number;
} {
  let scale = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1].cam;
    const b = samples[i].cam;
    scale = Math.max(scale, Math.abs(b.scale - a.scale));
    cx = Math.max(cx, Math.abs(b.cx - a.cx));
    cy = Math.max(cy, Math.abs(b.cy - a.cy));
  }
  return { scale, cx, cy };
}

// ── 1. The curve itself ────────────────────────────────────────────────────

test("the easing lands instead of arriving — zero velocity AND acceleration at both ends", () => {
  assert.equal(easeCinematic(0), 0);
  assert.equal(easeCinematic(1), 1);
  // Velocity at the ends: a curve that merely eases (quadratic) leaves a visible
  // acceleration step at the join; smootherstep's first AND second derivatives
  // vanish, which is what stops the frame "setting down" at the top of a ramp.
  const h = 1e-4;
  assert.ok(easeCinematic(h) / h < 1e-3, "non-zero velocity entering the ramp");
  assert.ok((1 - easeCinematic(1 - h)) / h < 1e-3, "non-zero velocity leaving the ramp");
  // Second difference ≈ acceleration.
  const accelStart = easeCinematic(2 * h) - 2 * easeCinematic(h) + easeCinematic(0);
  assert.ok(Math.abs(accelStart) < 1e-6, "non-zero acceleration entering the ramp");
});

test("a zoom never jumps — no sudden step anywhere in its life", () => {
  const s = sample([zoom()], 0, 8);
  const d = maxDelta(s);
  // At 200Hz a legal move is a few thousandths per step. Anything an order of
  // magnitude larger is a cut, not a move.
  assert.ok(d.scale < 0.02, `scale stepped ${d.scale.toFixed(4)} in one 5ms sample`);
  assert.ok(d.cx < 0.02, `pan stepped ${d.cx.toFixed(4)} in one 5ms sample`);
});

test("it starts and ends at rest — identity outside the edit, both edges", () => {
  const m = zoom();
  assert.deepEqual(resolveCameraFrame([m], 0, OPTS).camera, IDENTITY_CAMERA);
  assert.deepEqual(resolveCameraFrame([m], 20, OPTS).camera, IDENTITY_CAMERA);
  assert.ok(Math.abs(resolveCameraFrame([m], m.startTime, OPTS).camera.scale - 1) < 1e-9);
  assert.ok(Math.abs(resolveCameraFrame([m], m.endTime, OPTS).camera.scale - 1) < 1e-9);
});

test("a short edit still reaches its framing — the ramps never eat the whole zoom", () => {
  // 1.2s is the shortest window the click pipeline produces (0.2s pre + 1.0s post).
  const m = zoom({ startTime: 1, endTime: 2.2 });
  const peak = Math.max(...sample([m], 1, 2.2).map((s) => s.cam.scale));
  const target = resolveCameraFrame([zoom({ startTime: 0, endTime: 10 })], 5, OPTS)
    .camera.scale;
  assert.ok(
    peak > 1 + (target - 1) * 0.9,
    `short edit peaked at ${peak.toFixed(3)}, target is ${target.toFixed(3)}`
  );
});

// ── 2. How far it pushes ───────────────────────────────────────────────────

test("zoom is bounded — no preset, intensity or focus box can blow past the cap", () => {
  for (const preset of ["subtle", "standard", "emphasis"] as const) {
    for (const size of [0.02, 0.05, 0.1, 0.3, 0.6, 0.95]) {
      for (const intensity of [0, 0.25, 0.5, 0.9, 1]) {
        const m = zoom({
          intensity,
          focusRegion: { x: 0.2, y: 0.2, width: size, height: size },
        });
        const peak = Math.max(
          ...sample([m], 2, 6, 1 / 60, { autoZoom: 100, preset }).map((s) => s.cam.scale)
        );
        assert.ok(
          peak <= ZOOM_PRESETS[preset].maxScale + 1e-9 && peak <= MAX_ZOOM_SCALE,
          `${preset} @ size ${size} intensity ${intensity} reached ${peak.toFixed(3)}`
        );
        assert.ok(peak >= 1, "scale below identity");
      }
    }
  }
});

test("the three presets are ordered — Subtle < Standard < Emphasis, and Standard is the default", () => {
  const scaleFor = (preset: "subtle" | "standard" | "emphasis") =>
    resolveCameraFrame([zoom()], 4, { autoZoom: 72, preset }).camera.scale;
  assert.ok(scaleFor("subtle") < scaleFor("standard"), "subtle should push less than standard");
  assert.ok(scaleFor("standard") < scaleFor("emphasis"), "emphasis should push more than standard");
  // An absent preset IS standard — that's what makes it the polished default.
  assert.equal(
    resolveCameraFrame([zoom()], 4, { autoZoom: 72 }).camera.scale,
    scaleFor("standard")
  );
  // Subtle glides, Emphasis snaps.
  assert.ok(ZOOM_PRESETS.subtle.rampInS > ZOOM_PRESETS.emphasis.rampInS);
  // Releasing is always a touch slower than pushing in — that asymmetry is what
  // makes a push read as intent and a release as relaxation.
  for (const p of Object.values(ZOOM_PRESETS)) {
    assert.ok(p.rampOutS > p.rampInS, `${p.id} releases faster than it pushes`);
  }
});

/** How much of `box` the camera window actually shows, 0..1. */
function visibleFraction(
  cam: CameraState,
  box: { x: number; y: number; width: number; height: number }
): number {
  const half = 1 / (2 * cam.scale);
  const w = Math.max(
    0,
    Math.min(box.x + box.width, cam.cx + half) - Math.max(box.x, cam.cx - half)
  );
  const h = Math.max(
    0,
    Math.min(box.y + box.height, cam.cy + half) - Math.max(box.y, cam.cy - half)
  );
  return (w * h) / (box.width * box.height);
}

test("the subject stays inside the frame, with padding, at every instant", () => {
  const boxes = [
    { x: 0, y: 0, width: 0.18, height: 0.18 }, // hard against the top-left corner
    { x: 0.82, y: 0.82, width: 0.18, height: 0.18 }, // bottom-right corner
    { x: 0.45, y: 0, width: 0.1, height: 0.1 }, // top edge
    { x: 0.1, y: 0.4, width: 0.7, height: 0.5 }, // big region
    { x: 0.9, y: 0.45, width: 0.1, height: 0.1 }, // flush against the right edge
  ];
  for (const focusRegion of boxes) {
    for (const { t, cam } of sample([zoom({ focusRegion })], 2, 6, 1 / 60)) {
      const half = 1 / (2 * cam.scale);
      // The visible window never leaks outside the source frame — that's what
      // would show as a black bar down the side of the export.
      assert.ok(
        cam.cx - half >= -1e-9 && cam.cx + half <= 1 + 1e-9,
        "window peeked off frame horizontally"
      );
      assert.ok(
        cam.cy - half >= -1e-9 && cam.cy + half <= 1 + 1e-9,
        "window peeked off frame vertically"
      );
      // A subject flush with the frame edge must lose SOMETHING the moment you
      // zoom at all — that's geometry, not a bug. The real claim is that the
      // camera never crops the subject harder than it crops the frame: the
      // visible share of the subject stays at or above the visible share of the
      // whole frame (1/scale² by area).
      const seen = visibleFraction(cam, focusRegion);
      assert.ok(
        seen >= 1 / (cam.scale * cam.scale) - 1e-9,
        `subject ${(seen * 100).toFixed(1)}% visible at t=${t.toFixed(2)}, worse than the frame itself at scale ${cam.scale.toFixed(3)}`
      );
    }
    // And once the camera has settled, ALL of it is in shot — no exceptions.
    const held = resolveCameraFrame([zoom({ focusRegion })], 4, OPTS).camera;
    assert.ok(
      visibleFraction(held, focusRegion) > 1 - 1e-9,
      `subject clipped at the hold (scale ${held.scale.toFixed(3)})`
    );
  }
});

test("a big subject caps the zoom rather than cropping it", () => {
  // A region covering 70% of the frame cannot be pushed to 1.38× without losing
  // its edges, so the fit cap must win over the preset's window.
  const cap = subjectFitScale(0.7, 0.7, ZOOM_PRESETS.standard.safePadding);
  assert.ok(cap < ZOOM_PRESETS.standard.maxScale);
  const cam = resolveCameraFrame(
    [zoom({ intensity: 1, focusRegion: { x: 0.15, y: 0.15, width: 0.7, height: 0.7 } })],
    4,
    { autoZoom: 100 }
  ).camera;
  assert.ok(cam.scale <= cap + 1e-9, `${cam.scale} exceeded the subject-fit cap ${cap}`);
});

// ── 3. Consecutive zooms ───────────────────────────────────────────────────

test("back-to-back zooms keep their momentum — the camera never bounces through identity", () => {
  // The click-heavy case: two targets, a fifth of a second apart.
  const a = zoom({ id: "a", startTime: 1, endTime: 3 });
  const b = zoom({
    id: "b",
    startTime: 3.2,
    endTime: 5.2,
    focusRegion: { x: 0.6, y: 0.55, width: 0.25, height: 0.25 },
  });
  const mid = sample([a, b], 2.2, 4.2);
  const lowest = Math.min(...mid.map((s) => s.cam.scale));
  assert.ok(
    lowest > 1.02,
    `camera released to ${lowest.toFixed(3)} between two adjacent zooms — that flutter is the bug`
  );
  const d = maxDelta(mid);
  assert.ok(d.scale < 0.02 && d.cx < 0.02, "the hand-over stepped instead of gliding");
  // It really did travel to the second target — as far right as it can go
  // without letting the window off the frame, with the subject fully in shot.
  const end = resolveCameraFrame([a, b], 4.2, OPTS).camera;
  assert.ok(end.cx > 0.58, `never travelled toward the second subject (cx ${end.cx})`);
  assert.ok(
    visibleFraction(end, b.focusRegion) > 1 - 1e-9,
    "the second subject isn't fully framed"
  );
});

test("zooms far apart DO release — momentum is for neighbours, not for the whole video", () => {
  const a = zoom({ id: "a", startTime: 1, endTime: 3 });
  const b = zoom({ id: "b", startTime: 6, endTime: 8 });
  const between = sample([a, b], 3.5, 5.5, 1 / 60);
  assert.ok(
    between.every((s) => Math.abs(s.cam.scale - 1) < 1e-9),
    "the camera should sit at rest across a 3-second gap"
  );
});

test("a run of clicks reads as one continuous move, not six", () => {
  // Six clicks in ten seconds — the pattern that used to shake.
  const clicks = Array.from({ length: 6 }, (_, i) =>
    zoom({
      id: `c${i}`,
      startTime: 1 + i * 1.5,
      endTime: 1 + i * 1.5 + 1.3,
      focusRegion: { x: 0.15 + i * 0.1, y: 0.3, width: 0.2, height: 0.2 },
    })
  );
  const s = sample(clicks, 0, 12);
  const d = maxDelta(s);
  assert.ok(d.scale < 0.02, `stepped ${d.scale.toFixed(4)} between two 5ms samples`);
  assert.ok(d.cx < 0.02, `panned ${d.cx.toFixed(4)} between two 5ms samples`);
  // Count how often the camera crosses back to rest: with linking it should
  // settle once at the end, not between every pair.
  let releases = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i - 1].cam.scale > 1.02 && s[i].cam.scale <= 1.02) releases++;
  }
  assert.ok(releases <= 1, `camera released ${releases} times mid-sequence`);
});

test("overlapping zooms never fight — one owner per instant, no ping-pong", () => {
  const wide = zoom({ id: "wide", startTime: 1, endTime: 9 });
  const inner = zoom({
    id: "inner",
    startTime: 4,
    endTime: 6,
    source: "user",
    focusRegion: { x: 0.65, y: 0.2, width: 0.2, height: 0.2 },
  });
  const s = sample([wide, inner], 0, 10);
  const d = maxDelta(s);
  assert.ok(d.scale < 0.02 && d.cx < 0.02, "hand-over between overlapping edits stepped");
  // The user's edit owns its window: the camera is framing THEIR subject, not
  // the AI zoom's, and framing all of it.
  const at5 = resolveCameraFrame([wide, inner], 5, OPTS).camera;
  assert.equal(resolveCameraFrame([wide, inner], 5, OPTS).moment?.id, "inner");
  assert.ok(at5.cx > 0.58, `camera didn't move to the user's subject (cx ${at5.cx})`);
  assert.ok(visibleFraction(at5, inner.focusRegion) > 1 - 1e-9, "user subject clipped");
});

test("a sliver edit is ignored by the camera instead of flashing", () => {
  const flash = zoom({ startTime: 3, endTime: 3.12 });
  const s = sample([flash], 2.8, 3.4);
  assert.ok(
    s.every((x) => Math.abs(x.cam.scale - 1) < 1e-9),
    "a 120ms zoom should not move the camera at all"
  );
  // It's still the active edit for overlay purposes — camera ownership and
  // overlay visibility are different questions.
  assert.equal(resolveCameraFrame([flash], 3.05, OPTS).moment?.id, "z1");
});

// ── 4. Holding ─────────────────────────────────────────────────────────────

test("a very long zoom relaxes instead of staring — and never snaps back", () => {
  const long = zoom({ startTime: 0, endTime: 40 });
  const early = resolveCameraFrame([long], 3, OPTS).camera.scale;
  const late = resolveCameraFrame([long], 30, OPTS).camera.scale;
  assert.ok(late < early, "a 40-second zoom should ease off its peak");
  assert.ok(late > 1.02, "…but it must keep the framing, not release entirely");
  const d = maxDelta(sample([long], 0, 40, 1 / 120));
  assert.ok(d.scale < 0.02, "the settle stepped instead of easing");
});

// ── 5. Speed is the ramp, never the framing ────────────────────────────────

test("project camera speed changes the ramp, not where the camera lands", () => {
  const m = zoom({ startTime: 0, endTime: 10 });
  const held = [0, 25, 50, 75, 100].map(
    (speed) => resolveCameraFrame([m], 5, { autoZoom: 72, speed }).camera
  );
  for (const c of held) {
    assert.ok(Math.abs(c.scale - held[0].scale) < 1e-9, "speed moved the held framing");
  }
  // Snappier really is snappier early on.
  const fast = resolveCameraFrame([m], 0.3, { autoZoom: 72, speed: 100 }).camera.scale;
  const slow = resolveCameraFrame([m], 0.3, { autoZoom: 72, speed: 0 }).camera.scale;
  assert.ok(fast > slow, `speed 100 (${fast}) should be ahead of speed 0 (${slow})`);
});

test("a per-edit override beats the project setting; absent means follow the project", () => {
  const own = zoom({ cameraMotion: { preset: "emphasis" } });
  const inherited = zoom();
  const projectSubtle = { autoZoom: 72, preset: "subtle" as const };
  assert.ok(
    resolveCameraFrame([own], 4, projectSubtle).camera.scale >
      resolveCameraFrame([inherited], 4, projectSubtle).camera.scale,
    "the edit's own preset must win over the project's"
  );
  assert.equal(
    resolveCameraFrame([inherited], 4, projectSubtle).camera.scale,
    resolveCameraFrame([zoom({ cameraMotion: { preset: "subtle" } })], 4, projectSubtle).camera
      .scale,
    "an edit with no preset must render exactly as the project's preset"
  );
});

// ── 6. Independent of frame rate, resolution and aspect ────────────────────

test("the camera is identical at 24, 30, 60 and 120 fps — it's a function of TIME", () => {
  const m = zoom();
  for (const t of [2.1, 2.37, 3, 4.5, 5.9]) {
    const values = [24, 30, 60, 120].map(() => resolveCameraFrame([m], t, OPTS).camera);
    for (const v of values) assert.deepEqual(v, values[0]);
  }
  // And sampling ON a frame grid hits the same values the continuous curve has.
  for (const fps of [24, 30, 60, 120]) {
    const frame = Math.round(3.5 * fps);
    assert.deepEqual(
      resolveCameraFrame([m], frame / fps, OPTS).camera,
      resolveCameraFrame([m], 3.5, OPTS).camera
    );
  }
});

test("resolution and aspect only scale the projection — the framing decision is unitless", () => {
  const m = zoom();
  const cam = resolveCameraFrame([m], 4, OPTS).camera;
  // 720p / 1080p / 4K of the same aspect, then a vertical canvas.
  const sizes = [
    [1280, 720],
    [1920, 1080],
    [3840, 2160],
    [1080, 1920],
  ] as const;
  for (const [w, h] of sizes) {
    const { tx, ty } = canvasTranslateFor(cam, w, h);
    assert.ok(Math.abs(tx / w - (0.5 - cam.cx)) < 1e-12, "tx must be a pure fraction of drawW");
    assert.ok(Math.abs(ty / h - (0.5 - cam.cy)) < 1e-12, "ty must be a pure fraction of drawH");
  }
});

// ── 7. Preview / export parity ─────────────────────────────────────────────

test("what the preview shows is what every export bakes", () => {
  const moments = [
    zoom({ id: "a", startTime: 1, endTime: 3 }),
    zoom({ id: "b", startTime: 3.3, endTime: 6, focusRegion: { x: 0.6, y: 0.5, width: 0.2, height: 0.2 } }),
  ];
  const effects = { ...DEFAULT_EFFECTS_SETTINGS, zoomPreset: "emphasis" as const, zoomSpeed: 70 };

  // The recipe is what the browser exporter, the Cloud Run worker, the desktop
  // CLI and the Remotion renderer all composite from. If the camera feel didn't
  // survive serialisation, the cloud would silently render the default.
  const recipe = buildRenderRecipe({
    sourceWidth: 1920,
    sourceHeight: 1080,
    fps: 30,
    resolution: "1080p",
    format: "YouTube 16:9",
    sourceDuration: 10,
    moments,
    effects,
    applyWatermark: false,
  });
  assert.equal(recipe.effects.zoomPreset, "emphasis");
  assert.equal(recipe.effects.zoomSpeed, 70);

  for (let t = 0; t <= 8; t += 1 / 30) {
    // Preview: the editor's rAF loop writes translate(panX%, panY%) scale(s).
    const preview = resolveCameraFrame(moments, t, {
      autoZoom: effects.autoZoom,
      preset: effects.zoomPreset,
      speed: effects.zoomSpeed,
    }).camera;
    // Export: composeFrame resolves the same way, then projects to pixels.
    const exported = resolveCameraFrame(moments, t, {
      autoZoom: recipe.effects.autoZoom,
      preset: recipe.effects.zoomPreset,
      speed: recipe.effects.zoomSpeed,
    }).camera;
    assert.deepEqual(exported, preview, `preview ≠ export at t=${t.toFixed(3)}`);

    // The CSS percentage and the canvas pixel translate are the same number in
    // different units — this is the identity that keeps the two surfaces honest.
    const { tx } = canvasTranslateFor(exported, recipe.base.drawW, recipe.base.drawH);
    assert.ok(Math.abs(tx - (preview.panXPct / 100) * recipe.base.drawW) < 1e-9);
  }
});

test("the single-moment helper agrees with the full resolver", () => {
  const m = zoom();
  for (const p of [0, 0.1, 0.3, 0.5, 0.8, 1]) {
    const viaResolver = resolveCameraFrame([m], m.startTime + p * (m.endTime - m.startTime), {
      autoZoom: 72,
    }).camera;
    const direct = cameraForMoment(m, blendIntensity(m, 72), p);
    assert.ok(
      Math.abs(direct.scale - viaResolver.scale) < 1e-9 &&
        Math.abs(direct.cx - viaResolver.cx) < 1e-9,
      `diverged at progress ${p}`
    );
  }
});

// ── 8. What must NOT move the camera ───────────────────────────────────────

test("disabled, cut and overlay edits leave the camera alone", () => {
  const off = zoom({ enabled: false });
  assert.deepEqual(resolveCameraFrame([off], 4, OPTS).camera, IDENTITY_CAMERA);

  const caption = zoom({ effectType: "captions" });
  assert.deepEqual(resolveCameraFrame([caption], 4, OPTS).camera, IDENTITY_CAMERA);

  const speed = zoom({ effectType: "speed-up" });
  assert.deepEqual(resolveCameraFrame([speed], 4, OPTS).camera, IDENTITY_CAMERA);

  // A zoom entirely inside removed time never happens.
  const cut: DetectedMoment = {
    ...zoom({ id: "cut", startTime: 0, endTime: 10 }),
    effectType: "cut",
    cut: { active: true },
  };
  assert.deepEqual(resolveCameraFrame([cut, zoom()], 4, OPTS).camera, IDENTITY_CAMERA);
});

// ── 9. Timeline hygiene ────────────────────────────────────────────────────

test("duplicate pushes on the same target collapse into one zoom", () => {
  const target = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
  const r = normalizeZoomTimeline(
    [
      zoom({ id: "a", startTime: 1, endTime: 2.4, focusRegion: target }),
      zoom({ id: "b", startTime: 2.5, endTime: 3.9, focusRegion: { ...target, x: 0.41 } }),
    ],
    { duration: 30 }
  );
  assert.equal(r.moments.length, 1, "two pushes on one target should be one zoom");
  assert.ok(r.merged >= 1);
});

test("zooms on DIFFERENT targets stay separate", () => {
  const r = normalizeZoomTimeline(
    [
      zoom({ id: "a", startTime: 1, endTime: 2.4 }),
      zoom({
        id: "b",
        startTime: 2.5,
        endTime: 3.9,
        focusRegion: { x: 0.7, y: 0.7, width: 0.2, height: 0.2 },
      }),
    ],
    { duration: 30 }
  );
  assert.equal(r.moments.length, 2);
});

test("a forty-second zoom is pulled back into the preset's window", () => {
  const r = normalizeZoomTimeline([zoom({ startTime: 2, endTime: 42 })], { duration: 60 });
  const m = r.moments[0];
  assert.ok(
    m.endTime - m.startTime <= ZOOM_PRESETS.standard.maxDurationS + 1e-9,
    `still ${(m.endTime - m.startTime).toFixed(1)}s long`
  );
  assert.equal(r.clamped, 1);
});

test("hygiene never reshapes an edit the user placed by hand", () => {
  const mine = zoom({ id: "mine", source: "user", startTime: 1, endTime: 25 });
  const r = normalizeZoomTimeline([mine], { duration: 60 });
  assert.deepEqual(r.moments, [mine]);
  assert.equal(r.clamped, 0);
  assert.equal(r.merged, 0);
});

test("hygiene leaves crops, cuts and overlays untouched", () => {
  const others: DetectedMoment[] = [
    zoom({ id: "crop", effectType: "crop", startTime: 0, endTime: 30 }),
    zoom({ id: "cut", effectType: "cut", startTime: 0, endTime: 20 }),
    zoom({ id: "caps", effectType: "captions", startTime: 0, endTime: 25 }),
  ];
  const r = normalizeZoomTimeline(others, { duration: 60 });
  assert.deepEqual(r.moments, others);
});

test("after hygiene, no two generated zooms overlap", () => {
  const messy = [
    zoom({ id: "a", startTime: 1, endTime: 9 }),
    zoom({ id: "b", startTime: 3, endTime: 11, focusRegion: { x: 0.7, y: 0.1, width: 0.2, height: 0.2 } }),
    zoom({ id: "c", startTime: 5, endTime: 14, focusRegion: { x: 0.1, y: 0.7, width: 0.2, height: 0.2 } }),
  ];
  const r = normalizeZoomTimeline(messy, { duration: 60 });
  for (let i = 1; i < r.moments.length; i++) {
    assert.ok(
      r.moments[i].startTime >= r.moments[i - 1].endTime - 1e-9,
      `zoom ${r.moments[i].id} still overlaps ${r.moments[i - 1].id}`
    );
  }
});

// ── 10. The profile table itself ───────────────────────────────────────────

test("every profile keeps a real ramp at every speed — a zero ramp is a cut", () => {
  for (const preset of ["subtle", "standard", "emphasis"] as const) {
    for (const speed of [0, 25, 50, 75, 100]) {
      const p = resolveZoomProfile(preset, speed);
      assert.ok(p.rampIn > 0.1 && p.rampOut > 0.1, `${preset}@${speed} ramp collapsed`);
      assert.ok(p.rampIn <= 2 && p.rampOut <= 2, `${preset}@${speed} ramp is absurdly long`);
    }
  }
});
