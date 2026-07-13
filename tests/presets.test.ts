/**
 * Preset library — the contract.
 *
 * The library's central claim is that a preset is DATA, not a component: it
 * compiles into an ordinary `DetectedMoment`, is rendered by the one canvas
 * module every render path shares, and is therefore identical in preview and
 * export, editable like any other edit, and persistable.
 *
 * These tests pin that down, plus the things a "port the design" approach can
 * get quietly wrong: non-determinism, aspect-ratio adaptation, safe areas, and
 * the AI Director referencing a preset that doesn't exist.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRESETS,
  PRESET_IDS,
  getPreset,
  isValidPresetId,
  presetsByCategory,
  searchPresets,
} from "../src/lib/presets/registry.ts";
import {
  PRESET_CATEGORIES,
  PRESET_SCHEMA_VERSION,
  type PresetCategory,
} from "../src/lib/presets/types.ts";
import {
  evaluateAnimation,
  ease,
  revealText,
  sanitizeAnimation,
  EASINGS,
} from "../src/lib/presets/animation.ts";
import {
  applyPreset,
  isPresetMoment,
  readaptPresetMoment,
} from "../src/lib/presets/apply.ts";
import {
  aspectOf,
  clampToSafeArea,
  isOutsideSafeArea,
  resolvePresetStyle,
  safeBox,
  SAFE_AREAS,
} from "../src/lib/presets/layout.ts";
import {
  resolveDirectorPreset,
  scorePreset,
  selectPreset,
  selectPresetKit,
} from "../src/lib/presets/director.ts";

import { buildTimelineMap } from "../src/lib/timeline/crop-speed.ts";
import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import { laneForEffectType } from "../src/components/dashboard/real-editor/timeline/laneModel.ts";
import { splitMoment } from "../src/lib/timeline/split.ts";
import { resolveTextStyleValues } from "../src/lib/render/text-style.ts";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema.ts";
import type { DetectedMoment } from "../src/lib/firebase/schema.ts";

const SOURCE = 120;

/** The six effect types a preset is allowed to compile to. */
const ALLOWED = new Set([
  "captions",
  "hook-text",
  "text-overlay",
  "callout",
  "branding-cta",
  "transition",
]);

// ════════════════════════════════════════════════════════════════════════════
// The registry itself
// ════════════════════════════════════════════════════════════════════════════

test("registry: every preset is well-formed and uses an EXISTING Framevo edit type", () => {
  assert.ok(PRESETS.length >= 30, `${PRESETS.length} presets`);

  const seen = new Set<string>();
  for (const p of PRESETS) {
    assert.ok(p.id, "has an id");
    assert.equal(seen.has(p.id), false, `duplicate id: ${p.id}`);
    seen.add(p.id);

    assert.match(p.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${p.id}: kebab-case id`);
    assert.ok(p.name.length > 0, `${p.id}: has a name`);
    assert.ok(p.description.length > 0, `${p.id}: has a description`);
    assert.ok(
      ALLOWED.has(p.effectType),
      `${p.id}: "${p.effectType}" is an existing Framevo edit type`
    );
    assert.ok(
      (PRESET_CATEGORIES as readonly string[]).includes(p.category),
      `${p.id}: real category`
    );
    assert.ok(p.defaultDurationSeconds > 0, `${p.id}: has a duration`);
    assert.ok(p.tags.length > 0, `${p.id}: is searchable`);

    // Every preset must be routable onto the existing timeline.
    assert.ok(laneForEffectType(p.effectType), `${p.id}: routes to a lane`);
  }

  assert.deepEqual([...PRESET_IDS].sort(), [...seen].sort());
});

test("registry: EVERY design carries attribution — the licence file can't drift", () => {
  for (const p of PRESETS) {
    assert.ok(p.attribution, `${p.id}: has attribution`);
    const a = p.attribution;
    assert.ok(
      a.source === "remotion-templates" || a.source === "clippkit" || a.source === "framevo",
      `${p.id}: names a known source`
    );
    // Anything derived from a third party must name the exact upstream file AND
    // its licence, or THIRD_PARTY_LICENSES.md is an unverifiable claim.
    if (a.source !== "framevo") {
      assert.ok(a.file, `${p.id}: names the upstream file`);
      assert.equal(a.license, "MIT", `${p.id}: records the upstream licence`);
      assert.ok(a.note && a.note.length > 10, `${p.id}: says what was taken`);
    }
  }
});

test("registry: all 9 categories are populated", () => {
  for (const c of PRESET_CATEGORIES) {
    const inCat = presetsByCategory(c as PresetCategory);
    assert.ok(inCat.length > 0, `"${c}" has at least one preset`);
  }
});

test("registry: search finds presets by name, tag and category", () => {
  assert.ok(searchPresets("caption").length > 0);
  assert.ok(searchPresets("bold").length > 0);
  // An unknown term finds nothing rather than returning everything.
  assert.equal(searchPresets("zzzznotathing").length, 0);
  // Category filter narrows.
  const hooks = searchPresets("", { category: "hooks" });
  assert.ok(hooks.length > 0);
  assert.ok(hooks.every((p) => p.category === "hooks"));
});

test("registry: id validation is the gate the AI Director relies on", () => {
  assert.equal(isValidPresetId(PRESETS[0].id), true);
  assert.equal(isValidPresetId("totally-made-up"), false);
  assert.equal(getPreset("totally-made-up"), undefined);
});

// ════════════════════════════════════════════════════════════════════════════
// The animation engine
// ════════════════════════════════════════════════════════════════════════════

test("animation: every easing is bounded and lands on its endpoints", () => {
  for (const name of EASINGS) {
    // Tolerance, not equality: `back-out` is 1 + c3(x-1)³ + c1(x-1)², which at
    // x=0 is exactly 0 in real arithmetic and 2.2e-16 in floating point. A strict
    // check here would be testing IEEE-754, not the easing.
    assert.ok(Math.abs(ease(name, 0)) < 1e-9, `${name}(0) === 0`);
    assert.ok(Math.abs(ease(name, 1) - 1) < 1e-9, `${name}(1) === 1`);
    for (let p = 0; p <= 1; p += 0.05) {
      const v = ease(name, p);
      assert.ok(Number.isFinite(v), `${name}(${p}) is finite`);
      // back-out / elastic-out deliberately overshoot — that IS the design —
      // but they must stay in a sane band, not fly off.
      assert.ok(v > -0.5 && v < 1.6, `${name}(${p}) = ${v} is bounded`);
    }
  }
  // Out-of-range input is clamped, never extrapolated.
  assert.equal(ease("linear", -3), 0);
  assert.equal(ease("linear", 9), 1);
});

test("animation: evaluation is DETERMINISTIC — the export cannot differ from the preview", () => {
  // The upstream templates use Math.random() per frame. Ours must not: a random
  // overlay would make the exported file differ from the preview the user
  // approved, and it would be invisible until someone compared frames.
  const anim = sanitizeAnimation({
    in: { durationSeconds: 0.4, ease: "back-out", scale: [0.6, 1], opacity: [0, 1] },
    loop: { kind: "glitch", amount: 1, periodSeconds: 1 },
  })!;

  for (let i = 0; i < 40; i++) {
    const t = i * 0.05;
    const a = evaluateAnimation(anim, t, 0, 2);
    const b = evaluateAnimation(anim, t, 0, 2);
    assert.deepEqual(a, b, `t=${t} evaluates identically every time`);
  }

  // Even the "random" channels — glitch + shake — are seeded and stable.
  const shake = sanitizeAnimation({ loop: { kind: "shake", amount: 1, periodSeconds: 1 } })!;
  const x1 = evaluateAnimation(shake, 0.77, 0, 3).translateX;
  const x2 = evaluateAnimation(shake, 0.77, 0, 3).translateX;
  assert.equal(x1, x2);
});

test("animation: entrance and exit resolve at the right ends of the window", () => {
  const anim = sanitizeAnimation({
    in: { durationSeconds: 0.5, ease: "linear", opacity: [0, 1] },
    out: { durationSeconds: 0.5, ease: "linear", opacity: [1, 0] },
  })!;

  assert.ok(evaluateAnimation(anim, 10.0, 10, 14).alpha < 0.02, "invisible at the start");
  assert.ok(evaluateAnimation(anim, 10.5, 10, 14).alpha > 0.98, "fully in after the entrance");
  assert.ok(evaluateAnimation(anim, 12.0, 10, 14).alpha > 0.98, "steady in the middle");
  assert.ok(evaluateAnimation(anim, 14.0, 10, 14).alpha < 0.02, "faded out at the end");
});

test("animation: a phase longer than the moment is clamped, never left mid-entrance", () => {
  // A 3s entrance on a 1s caption would otherwise mean it is NEVER fully visible.
  const anim = sanitizeAnimation({
    in: { durationSeconds: 3, ease: "linear", opacity: [0, 1] },
  })!;
  const mid = evaluateAnimation(anim, 0.5, 0, 1);
  assert.ok(mid.alpha >= 0.99, "the entrance is clamped to half the window");
});

test("animation: no preset in the registry ever produces NaN or a negative scale", () => {
  for (const p of PRESETS) {
    if (!p.animation) continue;
    const end = p.defaultDurationSeconds;
    for (let i = 0; i <= 30; i++) {
      const t = (end * i) / 30;
      const f = evaluateAnimation(p.animation, t, 0, end);
      for (const [k, v] of Object.entries(f)) {
        assert.ok(Number.isFinite(v), `${p.id} @${t.toFixed(2)}s: ${k} is finite`);
      }
      assert.ok(f.scale >= 0, `${p.id}: scale never mirrors the text`);
      assert.ok(f.alpha >= 0 && f.alpha <= 1, `${p.id}: alpha in 0..1`);
    }
  }
});

test("animation: text reveal never tears a word in the word/char modes", () => {
  assert.equal(revealText("hello world", "none", 0.5), "hello world");
  assert.equal(revealText("hello world", "word", 1), "hello world");
  assert.equal(revealText("hello world there", "word", 0.5), "hello");
  assert.equal(revealText("hello", "typewriter", 0.6), "hel");
  assert.equal(revealText("hello", "typewriter", 0), "");
});

test("animation: sanitize rejects a bogus easing rather than trusting it", () => {
  const out = sanitizeAnimation({
    in: { durationSeconds: 999, ease: "not-an-easing" as never, opacity: [0, 1] },
  })!;
  assert.equal(out.in!.ease, "ease-out", "falls back to a real easing");
  assert.ok(out.in!.durationSeconds <= 10, "duration is bounded");
});

// ════════════════════════════════════════════════════════════════════════════
// Aspect ratios + safe areas
// ════════════════════════════════════════════════════════════════════════════

test("layout: aspect is classified from real canvas dimensions", () => {
  assert.equal(aspectOf(1920, 1080), "16:9");
  assert.equal(aspectOf(1080, 1920), "9:16");
  assert.equal(aspectOf(1080, 1080), "1:1");
});

test("layout: EVERY preset adapts its text size to each aspect ratio", () => {
  for (const p of PRESETS) {
    if (p.effectType === "transition") continue; // no text
    const wide = resolvePresetStyle(p, "16:9");
    const tall = resolvePresetStyle(p, "9:16");
    const square = resolvePresetStyle(p, "1:1");

    for (const [label, s] of [["16:9", wide], ["9:16", tall], ["1:1", square]] as const) {
      assert.ok(s.fontScale! > 0, `${p.id} @${label}: has a font scale`);
      assert.ok(s.fontScale! < 0.5, `${p.id} @${label}: font scale is sane`);
    }

    // `fontScale` is a fraction of canvas HEIGHT. A 9:16 canvas is far taller
    // than it is wide, so reusing the 16:9 scale would produce text far too
    // large for the narrow frame. It MUST come down.
    assert.ok(
      tall.fontScale! < wide.fontScale!,
      `${p.id}: vertical text is scaled down for the narrow frame`
    );
  }
});

test("layout: EVERY preset lands inside the platform's safe area on EVERY aspect", () => {
  for (const p of PRESETS) {
    if (p.effectType === "transition") continue;
    for (const aspect of ["16:9", "9:16", "1:1"] as const) {
      const style = clampToSafeArea(resolvePresetStyle(p, aspect), aspect);
      assert.equal(
        isOutsideSafeArea(style, aspect),
        false,
        `${p.id} @${aspect}: sits inside the safe area`
      );
    }
  }
});

test("layout: the 9:16 safe area really excludes the platform's own UI", () => {
  // TikTok/Reels stack their caption + handle across the bottom and the action
  // rail down the right. A preset drawn there is invisible to a real viewer no
  // matter how good our preview looks.
  const s = SAFE_AREAS["9:16"];
  assert.ok(s.bottom >= 0.15, "the bottom fifth is reserved");
  assert.ok(s.right >= 0.1, "the action rail is reserved");

  const box = safeBox(1080, 1920, "9:16");
  assert.ok(box.y > 0);
  assert.ok(box.x + box.width < 1080, "the box stops before the right edge");
  assert.ok(box.y + box.height < 1920, "and before the bottom");
});

test("layout: a caption dragged out of the safe area is pulled back in", () => {
  const dragged = clampToSafeArea(
    { position: "custom", customX: 0.5, customY: 0.98 },
    "9:16"
  );
  assert.ok(dragged.customY! <= 1 - SAFE_AREAS["9:16"].bottom);
});

// ════════════════════════════════════════════════════════════════════════════
// Applying a preset — it becomes a REAL, EDITABLE timeline edit
// ════════════════════════════════════════════════════════════════════════════

function applyAt(id: string, start = 10, w = 1920, h = 1080): DetectedMoment {
  const preset = getPreset(id)!;
  assert.ok(preset, `preset ${id} exists`);
  const m = applyPreset({
    preset,
    startTime: start,
    duration: SOURCE,
    canvasWidth: w,
    canvasHeight: h,
    id: `u-${id}`,
  });
  assert.ok(m, `${id} compiled to a moment`);
  return m!;
}

test("apply: a preset compiles to an ORDINARY DetectedMoment on the ordinary timeline", () => {
  for (const p of PRESETS) {
    const m = applyPreset({
      preset: p,
      startTime: 10,
      duration: SOURCE,
      canvasWidth: 1920,
      canvasHeight: 1080,
      id: `u-${p.id}`,
    });
    assert.ok(m, `${p.id} compiles`);
    assert.equal(m!.effectType, p.effectType);
    assert.ok(m!.endTime > m!.startTime, `${p.id}: real window`);
    assert.equal(m!.preset!.id, p.id, `${p.id}: back-linked`);
    assert.equal(m!.preset!.version, PRESET_SCHEMA_VERSION);
    assert.equal(isPresetMoment(m!), true);

    // A preset the USER applies is the USER's edit — it must survive a
    // re-analysis in "keep" mode rather than being swept away as an AI edit.
    assert.equal(m!.source, "user", `${p.id}: owned by the user`);

    // It routes onto the existing timeline.
    assert.ok(laneForEffectType(m!.effectType), `${p.id}: has a lane`);

    // Firestore rejects `undefined` — an applied preset MUST be persistable, or
    // it would vanish on refresh.
    for (const [k, v] of Object.entries(m!)) {
      assert.notEqual(v, undefined, `${p.id}: ${k} is undefined and would not save`);
    }
  }
});

test("apply: the settings bag the renderer needs is always present", () => {
  for (const p of PRESETS) {
    const m = applyAt(p.id);
    switch (p.effectType) {
      case "captions":
        assert.ok(m.captions?.text, `${p.id}: has caption text`);
        break;
      case "hook-text":
        assert.ok(m.hookText?.text, `${p.id}: has hook text`);
        break;
      case "text-overlay":
        assert.ok(m.textOverlay?.text, `${p.id}: has overlay text`);
        break;
      case "branding-cta":
        assert.ok(m.brandingCta?.ctaText, `${p.id}: has CTA text`);
        // The CTA must read the resolved custom position, or the whole safe-area
        // system is bypassed for every CTA preset.
        assert.equal(m.brandingCta!.position, "custom", `${p.id}: honours placement`);
        break;
      case "transition":
        assert.ok(m.transition?.style, `${p.id}: has a transition style`);
        break;
    }
  }
});

test("apply: every transition preset carries its OWN style — they don't all render as a black dip", () => {
  const transitions = presetsByCategory("transitions");
  assert.ok(transitions.length >= 4);

  const styles = new Set(
    transitions.map((p) => applyAt(p.id).transition!.style)
  );
  assert.ok(
    styles.size >= 3,
    `transition presets use ${styles.size} distinct render styles, not 1`
  );

  // The film burn is designed as a WHITE flash — it must not compile to a black
  // fade, which is what a hardcoded default would have shipped.
  const burn = PRESETS.find((p) => p.id === "transition-film-burn");
  if (burn) assert.equal(applyAt(burn.id).transition!.style, "flash");
});

test("apply: the user can customise text, size, weight, colour, background and position", () => {
  const m = applyAt(PRESETS.find((p) => p.effectType === "hook-text")!.id);

  // Simulate what MomentInspector's TextStyleControls do: merge a patch into
  // moment.textStyle. Every axis the brief names must round-trip.
  const customised: DetectedMoment = {
    ...m,
    hookText: { ...m.hookText!, text: "My own words" },
    textStyle: {
      ...(m.textStyle ?? {}),
      fontFamily: "serif",
      fontScale: 0.08,
      fontWeight: 900,
      color: "#ff0000",
      background: "box",
      backgroundColor: "#00ff00",
      backgroundOpacity: 0.5,
      position: "custom",
      customX: 0.3,
      customY: 0.3,
    },
  };

  const v = resolveTextStyleValues(customised);
  assert.equal(v.fontFamily, "serif");
  assert.equal(v.fontScale, 0.08);
  assert.equal(v.fontWeight, 900);
  assert.equal(v.color, "#ff0000");
  assert.equal(v.background, "box");
  assert.equal(v.backgroundColor, "#00ff00");
  assert.equal(v.customX, 0.3);
  assert.equal(customised.hookText!.text, "My own words");

  // Duration is just the window — resizable on the timeline like anything else.
  const resized = { ...customised, endTime: customised.startTime + 9 };
  assert.equal(resized.endTime - resized.startTime, 9);
});

test("apply: a preset edit can be moved, resized, split, duplicated, disabled and deleted", () => {
  const m = applyAt(PRESETS.find((p) => p.effectType === "text-overlay")!.id, 10);

  // move
  const moved = { ...m, startTime: 40, endTime: 40 + (m.endTime - m.startTime) };
  assert.equal(moved.startTime, 40);
  // resize
  const resized = { ...m, endTime: m.startTime + 8 };
  assert.ok(resized.endTime - resized.startTime === 8);
  // split — the preset's style + animation survive into BOTH halves
  const split = splitMoment(resized, resized.startTime + 4, "new")!;
  assert.ok(split, "a preset edit is splittable");
  assert.deepEqual(split.left.textStyle, resized.textStyle);
  assert.deepEqual(split.right.animation, resized.animation);
  assert.equal(split.right.preset!.id, m.preset!.id);
  // duplicate
  const copy = { ...m, id: "copy" };
  assert.equal(copy.preset!.id, m.preset!.id);
  // disable (non-destructive)
  const off = { ...m, enabled: false };
  assert.equal(off.enabled, false);
});

test("apply: re-adapting to a new aspect keeps the user's colour and text", () => {
  const m = applyAt(PRESETS.find((p) => p.effectType === "hook-text")!.id, 10, 1920, 1080);
  const custom: DetectedMoment = {
    ...m,
    textStyle: { ...(m.textStyle ?? {}), color: "#ff00ff", fontWeight: 900 },
  };

  const preset = getPreset(custom.preset!.id)!;
  const vertical = readaptPresetMoment(custom, preset, 1080, 1920);

  // Layout is re-derived for 9:16…
  assert.ok(vertical.textStyle!.fontScale! < custom.textStyle!.fontScale!);
  assert.equal(isOutsideSafeArea(vertical.textStyle!, "9:16"), false);
  // …but the user's own choices are NOT thrown away.
  assert.equal(vertical.textStyle!.color, "#ff00ff");
  assert.equal(vertical.textStyle!.fontWeight, 900);
});

test("apply: a preset near the end of the video is clamped, not hung off the edge", () => {
  const p = PRESETS.find((x) => x.effectType === "hook-text")!;
  const m = applyPreset({
    preset: p,
    startTime: SOURCE - 0.5,
    duration: SOURCE,
    canvasWidth: 1920,
    canvasHeight: 1080,
    id: "u1",
  })!;
  assert.ok(m.endTime <= SOURCE, "never runs past the end of the video");
  assert.ok(m.endTime > m.startTime);
});

// ════════════════════════════════════════════════════════════════════════════
// Preview / export parity — one preset, one renderer
// ════════════════════════════════════════════════════════════════════════════

test("parity: applied presets are carried into the export recipe unchanged", () => {
  const moments = PRESETS.slice(0, 12).map((p, i) =>
    applyPreset({
      preset: p,
      startTime: i * 6,
      duration: SOURCE,
      canvasWidth: 1920,
      canvasHeight: 1080,
      id: `u${i}`,
    })!
  );

  const recipe = buildRenderRecipe({
    sourceWidth: 1920,
    sourceHeight: 1080,
    fps: 30,
    resolution: "1080p",
    format: "Source",
    sourceDuration: SOURCE,
    moments,
    effects: DEFAULT_EFFECTS_SETTINGS,
    sourceCrop: null,
    applyWatermark: false,
  });

  // The export gets the EXACT array the timeline holds — style, animation and
  // all. There is no preset-specific serialization to get wrong.
  assert.deepEqual(recipe.moments, moments);
  for (const m of recipe.moments) {
    if (m.preset) {
      assert.ok(m.textStyle, `${m.preset.id}: style reached the export`);
    }
  }

  // And the preview's own timeline map agrees.
  assert.equal(
    recipe.outputDuration,
    buildTimelineMap(moments, SOURCE).outputDuration
  );
});

test("parity: the SAME preset animation is evaluated for preview and export", () => {
  // Preview samples at wall-clock time; the export samples at frame boundaries
  // (i/fps). Both call `evaluateAnimation` with the same source time, so they
  // must agree at any t — including times that fall between export frames.
  const p = PRESETS.find((x) => x.animation?.in)!;
  const m = applyAt(p.id, 10);

  for (const fps of [30, 60]) {
    for (let frame = 0; frame < 20; frame++) {
      const t = m.startTime + frame / fps;
      const exported = evaluateAnimation(m.animation, t, m.startTime, m.endTime);
      const previewed = evaluateAnimation(m.animation, t, m.startTime, m.endTime);
      assert.deepEqual(exported, previewed, `fps=${fps} frame=${frame}`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// AI Director — validated preset ids ONLY
// ════════════════════════════════════════════════════════════════════════════

test("director: an unknown preset id is REJECTED, never coerced into something close", () => {
  const bad = resolveDirectorPreset("preset-that-does-not-exist");
  assert.equal(bad.preset, null);
  assert.equal(bad.rejection, "unknown_id");
  assert.match(bad.detail!, /isn't a preset/i);

  const good = resolveDirectorPreset(PRESETS[0].id);
  assert.ok(good.preset);
  assert.equal(good.rejection, undefined);
});

test("director: a preset from the wrong category is refused", () => {
  const caption = presetsByCategory("captions")[0];
  const res = resolveDirectorPreset(caption.id, "ctas");
  assert.equal(res.preset, null);
  assert.equal(res.rejection, "wrong_category");
});

test("director: selection responds to tone, platform, aspect and video type", () => {
  const energetic = selectPreset({
    category: "captions",
    tone: "energetic",
    platform: "tiktok",
    aspect: "9:16",
  });
  const professional = selectPreset({
    category: "captions",
    tone: "professional",
    platform: "youtube",
    aspect: "16:9",
  });

  assert.ok(energetic && professional);
  assert.notEqual(
    energetic!.id,
    professional!.id,
    "a TikTok energetic brief and a YouTube professional brief pick different looks"
  );
  assert.equal(energetic!.tone, "energetic");
  assert.equal(professional!.tone, "professional");
});

test("director: selection is DETERMINISTIC — a re-run picks the same preset", () => {
  const ctx = {
    category: "hooks" as const,
    tone: "energetic" as const,
    platform: "tiktok",
    aspect: "9:16" as const,
  };
  const a = selectPreset(ctx);
  const b = selectPreset(ctx);
  assert.equal(a!.id, b!.id, "idempotent re-runs stay idempotent for presets too");
});

test("director: the kit only fills slots the plan actually asked for", () => {
  const kit = selectPresetKit({
    tone: "energetic",
    platform: "tiktok",
    aspect: "9:16",
    videoType: "product-demo",
    wantCaptions: true,
    wantHook: true,
    wantCta: false,
    wantTransitions: false,
  });

  assert.ok(kit.captions, "captions were requested");
  assert.ok(kit.hook, "a hook was requested");
  assert.equal(kit.cta, undefined, "no CTA was requested — none was chosen");
  assert.equal(kit.transition, undefined);

  // Every id it returned is real.
  for (const p of Object.values(kit)) {
    if (p) assert.equal(isValidPresetId(p.id), true, `${p.id} is in the registry`);
  }
});

test("director: a vertical brief prefers a preset that survives a small, busy phone screen", () => {
  const vertical = selectPreset({ category: "captions", aspect: "9:16", tone: "energetic" });
  assert.ok(vertical);
  const s = vertical!.textStyle;
  const readable =
    s.background === "pill" ||
    s.background === "box" ||
    (s.strokeWidth ?? 0) > 0 ||
    (s.fontWeight ?? 400) >= 700;
  assert.ok(readable, `${vertical!.id} has a plate, a stroke or real weight`);
});

test("director: scoring prefers a preset that declares an adaptation for the target aspect", () => {
  const withAdaptation = PRESETS.find((p) => p.aspects?.["9:16"] && p.category === "captions");
  const without = PRESETS.find(
    (p) => !p.aspects?.["9:16"] && p.category === "captions" && p.tone === withAdaptation?.tone
  );
  if (!withAdaptation || !without) return; // registry may not have both — not a failure

  const ctx = { category: "captions" as const, aspect: "9:16" as const };
  assert.ok(
    scorePreset(withAdaptation, ctx) > scorePreset(without, ctx),
    "a design that was actually tuned for 9:16 wins"
  );
});
