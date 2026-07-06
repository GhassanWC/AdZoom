/**
 * Shared TextStyle model — the ONE styling system for every text-based edit
 * (captions, hook text, text overlays, callouts, branding CTAs). Verifies the
 * resolver layering (defaults ← legacy preset ← textStyle), preset application,
 * legacy back-compat mapping, colour helpers, and font-family stacks. Pure — no
 * canvas — so preview + export parity is exercised at the values layer.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { DetectedMoment, EffectType } from "@/lib/firebase/schema";
import {
  DEFAULT_TEXT_STYLE,
  TEXT_STYLE_PRESETS,
  applyTextStylePreset,
  resolveTextStyleValues,
  legacyTextStyle,
  fontFamilyStack,
  hexToRgb,
  rgba,
  rgbaToHexOpacity,
  clamp01,
  isTextEffectType,
} from "@/lib/render/text-style";

function moment(effectType: EffectType, extra: Partial<DetectedMoment> = {}): DetectedMoment {
  return {
    id: "m1",
    startTime: 0,
    endTime: 2,
    label: "x",
    reason: "y",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType,
    ...extra,
  };
}

// ── defaults ─────────────────────────────────────────────────────────────────

test("DEFAULT_TEXT_STYLE has every field populated", () => {
  for (const [k, v] of Object.entries(DEFAULT_TEXT_STYLE)) {
    assert.ok(v !== undefined, `default missing for ${k}`);
  }
});

// ── resolver layering ─────────────────────────────────────────────────────────

test("resolveTextStyleValues: caption with no textStyle → legacy 'clean' defaults", () => {
  const v = resolveTextStyleValues(
    moment("captions", { captions: { text: "hi", stylePreset: "clean", position: "bottom" } })
  );
  assert.equal(v.fontScale, 0.05);
  assert.equal(v.fontWeight, 600);
  assert.equal(v.background, "pill");
  assert.equal(v.backgroundColor, "#000000");
  assert.ok(Math.abs(v.backgroundOpacity - 0.55) < 1e-9);
  assert.equal(v.position, "bottom");
  assert.equal(v.color, "#ffffff");
});

test("resolveTextStyleValues: textStyle overrides win field-by-field over legacy", () => {
  const v = resolveTextStyleValues(
    moment("captions", {
      captions: { text: "hi", stylePreset: "bold_social", position: "top" },
      textStyle: { color: "#ff0000", position: "center" },
    })
  );
  // Overridden by textStyle:
  assert.equal(v.color, "#ff0000");
  assert.equal(v.position, "center");
  // Still from the legacy bold_social preset (not overridden):
  assert.equal(v.fontWeight, 800);
  assert.equal(v.uppercase, true);
});

test("resolveTextStyleValues: hook 'neon' legacy maps colour + purple shadow", () => {
  const v = resolveTextStyleValues(
    moment("hook-text", {
      hookText: { text: "wow", stylePreset: "neon", position: "center", animation: "pop" },
    })
  );
  assert.equal(v.color, "#c4b5fd");
  assert.equal(v.shadowColor, "#8b5cf6");
  assert.equal(v.uppercase, true);
  assert.equal(v.position, "center");
});

test("resolveTextStyleValues: text-overlay 9-grid position → position + align", () => {
  const v = resolveTextStyleValues(
    moment("text-overlay", {
      textOverlay: {
        text: "t",
        position: "top-right",
        size: "large",
        alignment: "right",
        backgroundStyle: "box",
        animation: "fade",
      },
    })
  );
  assert.equal(v.position, "top");
  assert.equal(v.align, "right");
  assert.equal(v.background, "box");
  assert.equal(v.fontScale, 0.06); // large
});

test("resolveTextStyleValues: text-overlay 'shadow' bg → drop shadow, no plate", () => {
  const v = resolveTextStyleValues(
    moment("text-overlay", {
      textOverlay: {
        text: "t",
        position: "center",
        size: "medium",
        alignment: "center",
        backgroundStyle: "shadow",
        animation: "none",
      },
    })
  );
  assert.equal(v.background, "none");
  assert.equal(v.shadow, true);
});

test("resolveTextStyleValues: branding-cta 'creator' → white on violet plate", () => {
  const v = resolveTextStyleValues(
    moment("branding-cta", {
      brandingCta: { ctaText: "Follow", position: "bottom-right", stylePreset: "creator" },
    })
  );
  assert.equal(v.color, "#ffffff");
  assert.equal(v.backgroundColor, "#8b5cf6");
  assert.equal(v.background, "pill");
});

test("resolveTextStyleValues: unknown/no bag → pure defaults", () => {
  const v = resolveTextStyleValues(moment("captions"));
  assert.deepEqual(v, DEFAULT_TEXT_STYLE);
});

// ── legacy mapping guardrails ──────────────────────────────────────────────────

test("legacyTextStyle: non-text effect returns empty", () => {
  assert.deepEqual(legacyTextStyle(moment("zoom")), {});
  assert.deepEqual(legacyTextStyle(moment("blur-redaction")), {});
});

test("legacyTextStyle: caption 'custom' position coerces to bottom", () => {
  const p = legacyTextStyle(
    moment("captions", { captions: { text: "x", stylePreset: "clean", position: "custom" } })
  );
  assert.equal(p.position, "bottom");
});

// ── presets ────────────────────────────────────────────────────────────────────

test("applyTextStylePreset: merges styling, records preset, preserves position/align", () => {
  const base = { position: "top" as const, align: "left" as const, color: "#111111" };
  const out = applyTextStylePreset(base, "neon");
  assert.equal(out.preset, "neon");
  assert.equal(out.color, TEXT_STYLE_PRESETS.neon.color); // preset wins over base colour
  assert.equal(out.position, "top"); // preserved
  assert.equal(out.align, "left"); // preserved
});

test("every preset exists and is a partial (no position keys)", () => {
  for (const key of ["clean", "bold", "minimal", "neon", "shadow"] as const) {
    const p = TEXT_STYLE_PRESETS[key];
    assert.ok(p, `missing preset ${key}`);
    assert.equal(p.position, undefined, `${key} should not set position`);
    assert.equal(p.customX, undefined);
    assert.equal(p.align, undefined, `${key} should not set align`);
  }
});

// ── colour helpers ──────────────────────────────────────────────────────────────

test("hexToRgb parses #rgb and #rrggbb", () => {
  assert.deepEqual(hexToRgb("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(hexToRgb("#000000"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(hexToRgb("8b5cf6"), { r: 139, g: 92, b: 246 });
  assert.deepEqual(hexToRgb("garbage"), { r: 0, g: 0, b: 0 });
});

test("rgba composes hex + opacity", () => {
  assert.equal(rgba("#8b5cf6", 0.5), "rgba(139,92,246,0.500)");
  assert.equal(rgba("#ffffff", 1), "rgba(255,255,255,1.000)");
  assert.equal(rgba("#000000", 2), "rgba(0,0,0,1.000)"); // clamped
});

test("rgbaToHexOpacity is the inverse of the legacy composite strings", () => {
  assert.deepEqual(rgbaToHexOpacity("rgba(0,0,0,0.55)"), { hex: "#000000", opacity: 0.55 });
  assert.deepEqual(rgbaToHexOpacity("rgb(139,92,246)"), { hex: "#8b5cf6", opacity: 1 });
  assert.deepEqual(rgbaToHexOpacity("not-a-color"), { hex: "#000000", opacity: 1 });
});

test("clamp01 clamps", () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(0.4), 0.4);
  assert.equal(clamp01(9), 1);
});

// ── font families ───────────────────────────────────────────────────────────────

test("fontFamilyStack: auto/sans return the script stack unchanged", () => {
  const scriptStack = `"Noto Sans", Arial`;
  assert.equal(fontFamilyStack("auto", scriptStack), scriptStack);
  assert.equal(fontFamilyStack("sans", scriptStack), scriptStack);
});

test("fontFamilyStack: serif/mono prepend a family and END in the script stack (glyph fallback)", () => {
  const scriptStack = `"Noto Sans Arabic", Tahoma`;
  const serif = fontFamilyStack("serif", scriptStack);
  const mono = fontFamilyStack("mono", scriptStack);
  assert.ok(serif.startsWith(`"Noto Serif"`));
  assert.ok(serif.endsWith(scriptStack));
  assert.ok(mono.includes(`"Noto Sans Mono"`));
  assert.ok(mono.endsWith(scriptStack));
});

// ── effect classification ────────────────────────────────────────────────────────

test("isTextEffectType covers exactly the text edits", () => {
  for (const t of ["captions", "hook-text", "text-overlay", "callout", "branding-cta"] as EffectType[]) {
    assert.equal(isTextEffectType(t), true, `${t} should be a text effect`);
  }
  for (const t of ["zoom", "cut", "blur-redaction", "transition", "smart-crop"] as EffectType[]) {
    assert.equal(isTextEffectType(t), false, `${t} should NOT be a text effect`);
  }
});
