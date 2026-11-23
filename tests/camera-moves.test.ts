/**
 * Composed camera moves + designed graphics: beats → keyframes the existing
 * resolver animates, targeted revisions that change only what was asked, and
 * the composed-graphic drawer rendering every part in every renderer's path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { DetectedMoment, GraphicPart } from "../src/lib/firebase/schema.ts";
import {
  composeMove,
  presetForZoom,
  intensityForZoom,
  zoomForIntensity,
  slowerMove,
  holdLonger,
  framingCheck,
  framingAt,
  beatsFromKeyframes,
} from "../src/lib/edit-commands/camera.ts";
import { applyEditCommands } from "../src/lib/edit-commands/apply.ts";
import { parseEditRequest } from "../src/lib/edit-commands/parse.ts";
import type { AssistantInput } from "../src/lib/edit-commands/context.ts";
import { resolveCameraFrame } from "../src/lib/timeline/camera.ts";
import { dishLabelParts, starterGraphic } from "../src/lib/graphics/design.ts";
import { drawOutputOverlays, hasOverlayMoments } from "../src/lib/render/overlay-draw.ts";
import { buildTimelineMap } from "../src/lib/timeline/crop-speed.ts";
import { buildRenderRecipe } from "../src/lib/render/recipe.ts";
import { DEFAULT_EFFECTS_SETTINGS } from "../src/lib/firebase/schema.ts";

const DUR = 33.4;
const state = (moments: DetectedMoment[] = []) => ({ moments, sourceDuration: DUR, canvasWidth: 1920, canvasHeight: 922 });
const input = (over: Partial<AssistantInput> = {}): AssistantInput => ({
  project: { analysis: { detectedMoments: [] } as never, duration: DUR },
  moments: [], layers: {}, sourceDuration: DUR, playhead: 12, selection: {}, recentElementIds: [], ...over,
});

// The food clip at ~12s: dish image on the right, price bottom-left.
const DISH = { cx: 0.72, cy: 0.58, w: 0.42, h: 0.78 };
const PRICE = { cx: 0.11, cy: 0.815, w: 0.06, h: 0.045 };

test("beats → keyframes: preset chosen for the strongest zoom, intensities invert exactly, holds kept", () => {
  const move = composeMove(
    [
      { at: 0, x: 0.5, y: 0.5, zoom: 1 },
      { at: 1.2, x: DISH.cx, y: DISH.cy, zoom: 1.5, ease: "ease-in-out" },
      { at: 2.2, x: DISH.cx, y: DISH.cy, zoom: 1.5 }, // hold
      { at: 3.6, x: 0.3, y: PRICE.cy, zoom: 1.3 },
      { at: 5.2, x: 0.3, y: PRICE.cy, zoom: 1.3 },
    ],
    6
  );
  assert.ok(!("error" in move));
  if ("error" in move) return;
  assert.equal(move.preset, "emphasis", "1.5× needs the emphasis range");
  assert.equal(move.keyframes.length, 5);
  assert.deepEqual(move.keyframes.map((k) => k.t), [0, 0.2, 0.367, 0.6, 0.867]);
  assert.ok(move.keyframes.every((k) => k.ease), "every keyframe has an explicit ease (absent would mean linear)");
  assert.ok(Math.abs(zoomForIntensity(move.keyframes[1].scale, "emphasis") - 1.5) < 0.01);
  assert.ok(move.focusRegion.width <= 0.6 && move.focusRegion.width >= 0.12);
  // The resolver reaches the dish framing in the hold and comes back to 1× by the end.
  const m = { ...base("z", 10, 16), keyframes: move.keyframes, focusRegion: move.focusRegion, cameraMotion: { preset: move.preset } } as DetectedMoment;
  const mid = resolveCameraFrame([m], 12.3, { autoZoom: DEFAULT_EFFECTS_SETTINGS.autoZoom }).camera;
  assert.ok(mid.scale > 1.4, `dish hold scale ${mid.scale}`);
  assert.ok(mid.panXPct < -8, `camera moved right toward the dish (pan ${mid.panXPct})`);
  const end = resolveCameraFrame([m], 16.0, { autoZoom: DEFAULT_EFFECTS_SETTINGS.autoZoom }).camera;
  assert.ok(Math.abs(end.scale - 1) < 0.02, "eased back out by the end");
  for (const z of [1.1, 1.3, 1.6]) assert.ok(Math.abs(zoomForIntensity(intensityForZoom(z, presetForZoom(z)), presetForZoom(z)) - z) < 0.01);
});

test("composeMove rejects nothing-moves and too-short moves", () => {
  assert.ok("error" in composeMove([{ at: 0, x: 0.5, y: 0.5, zoom: 1 }], 4));
  assert.ok("error" in composeMove([{ at: 0, x: 0.5, y: 0.5, zoom: 1.4 }], 0.5));
});

test("framing: off-centre limits and legibility", () => {
  const price = framingAt({ cx: PRICE.cx, cy: PRICE.cy, w: PRICE.w, h: PRICE.h }, 1.3);
  assert.equal(price.centred, false, "a price at x=0.11 can't be centred under the zoom cap");
  assert.equal(price.visible, true, "…but it stays visible at the edge of the shot");
  assert.ok(price.zoomToCentre > 1.75);
  assert.equal(framingAt({ cx: 0.5, cy: 0.5 }, 1.5).centred, true);
  const f = framingCheck({ w: PRICE.w, h: PRICE.h }, 1.3);
  assert.equal(f.readable, true, "price text at 1.3× is legible");
  assert.equal(framingCheck({ w: 0.04, h: 0.02 }, 1.1).readable, false);
});

test("set_camera → update_camera revisions change only the property named; undo-able data, preview == export", () => {
  const add = applyEditCommands(state(), [{ op: "set_camera", start: 10, end: 16, beats: [
    { at: 0, x: 0.5, y: 0.5, zoom: 1 }, { at: 1.2, x: DISH.cx, y: DISH.cy, zoom: 1.5 }, { at: 2.4, x: DISH.cx, y: DISH.cy, zoom: 1.5 }, { at: 4, x: 0.3, y: PRICE.cy, zoom: 1.25 },
  ] }], "cam");
  assert.ok(add.ok);
  const z = add.moments[0];
  assert.match(add.changes[0].summary, /^Added a camera move 0:10\.0–0:16\.0 \(4 beats, up to 1\.50×\)$/);

  // "Make the push-in slower": arrival later, ramps slower, nothing else.
  const slow = applyEditCommands(state(add.moments), [{ op: "update_camera", elementId: z.id, slower: true }], "slow");
  assert.ok(slow.ok);
  const zs = slow.moments[0];
  assert.ok(zs.keyframes![1].t > z.keyframes![1].t, "arrives later");
  assert.equal(zs.cameraMotion?.speed, 25);
  assert.deepEqual([zs.startTime, zs.endTime], [z.startTime, z.endTime]);
  assert.deepEqual(zs.keyframes!.map((k) => [k.x, k.y, k.scale]), z.keyframes!.map((k) => [k.x, k.y, k.scale]), "framing and zoom untouched");

  // "Keep the price visible": longer end, beats stay at their absolute times.
  const hold = applyEditCommands(state(add.moments), [{ op: "update_camera", elementId: z.id, holdSeconds: 1.5 }], "hold");
  assert.ok(hold.ok);
  const zh = hold.moments[0];
  assert.equal(zh.endTime, 17.5);
  const absBefore = z.keyframes!.map((k) => +(10 + k.t * 6).toFixed(2));
  const absAfter = zh.keyframes!.slice(0, 4).map((k) => +(10 + k.t * 7.5).toFixed(2));
  assert.deepEqual(absAfter, absBefore);
  assert.equal(zh.keyframes![zh.keyframes!.length - 1].t, 1, "the last pose is held to the new end");
  const late = resolveCameraFrame([zh], 16.9, { autoZoom: DEFAULT_EFFECTS_SETTINGS.autoZoom }).camera;
  assert.ok(late.scale > 1.1, "still on the price near the new end");

  // Preview (timeline map) and export (recipe) agree — same moments array.
  const recipe = buildRenderRecipe({ sourceWidth: 1920, sourceHeight: 922, fps: 30, resolution: "1080p", format: "Source", sourceDuration: DUR, moments: hold.moments, effects: DEFAULT_EFFECTS_SETTINGS, sourceCrop: null, applyWatermark: false } as never);
  assert.equal(recipe.timelineMap.outputDuration, buildTimelineMap(hold.moments, DUR).outputDuration);
  assert.deepEqual(recipe.moments[0].keyframes, zh.keyframes, "export receives the same keyframes");
});

test("local revisions parse to targeted camera commands", () => {
  const add = applyEditCommands(state(), [{ op: "set_camera", start: 10, end: 16, beats: [{ at: 0, x: 0.5, y: 0.5, zoom: 1 }, { at: 1.5, x: DISH.cx, y: DISH.cy, zoom: 1.5 }] }], "cam");
  assert.ok(add.ok);
  const ctx = input({ moments: add.moments, recentElementIds: [add.moments[0].id] });
  assert.deepEqual((parseEditRequest("Make the push-in slower", ctx) as { commands: unknown[] }).commands, [{ op: "update_camera", elementId: add.moments[0].id, slower: true }]);
  const hold = parseEditRequest("keep the price visible", ctx) as { commands: { op: string; holdSeconds: number }[] };
  assert.equal(hold.commands[0].op, "update_camera");
  assert.equal(hold.commands[0].holdSeconds, 1.5);
  assert.equal((parseEditRequest("hold on it for 3 seconds longer", ctx) as { commands: { holdSeconds: number }[] }).commands[0].holdSeconds, 3);
});

test("a dish label is parts with a staggered entrance; 'remove the line but keep the title' removes only the line", () => {
  const parts = dishLabelParts("Chicken Tikka", "Rs 380", { tone: "premium" });
  assert.deepEqual(parts.map((p) => p.kind), ["line", "text", "text"]);
  assert.ok(parts[0].delay! < parts[1].delay! && parts[1].delay! < parts[2].delay!, "accent → title → price");
  assert.equal(parts[1].kind === "text" && parts[1].style?.fontFamily, "serif");

  const add = applyEditCommands(state(), [{ op: "compose_graphic", start: 12, duration: 4, label: { title: "Chicken Tikka", sub: "Rs 380" } }], "g");
  assert.ok(add.ok);
  const g = add.moments[0];
  assert.equal(g.effectType, "graphic");
  assert.equal(g.graphic!.parts.length, 3);
  assert.match(add.changes[0].summary, /^Added a graphic "Chicken Tikka" \(line \+ text\) at 0:12\.0$/);

  const parsed = parseEditRequest("remove the line but keep the title", input({ moments: add.moments, recentElementIds: [g.id] }));
  assert.deepEqual((parsed as { commands: unknown[] }).commands, [{ op: "update_graphic", elementId: g.id, removeParts: ["line"] }]);
  const rev = applyEditCommands(state(add.moments), (parsed as { commands: never[] }).commands, "g2");
  assert.ok(rev.ok);
  const g2 = rev.moments[0];
  assert.deepEqual(g2.graphic!.parts.map((p) => p.kind), ["text", "text"]);
  assert.equal(g2.graphic!.parts[0].kind === "text" && g2.graphic!.parts[0].text, "Chicken Tikka", "title kept, untouched");
  assert.deepEqual([g2.startTime, g2.endTime], [g.startTime, g.endTime]);

  // "add a label saying …" composes the same design locally.
  const local = parseEditRequest('add a premium label saying "Chicken Tikka, Rs 380"', input());
  assert.deepEqual((local as { commands: unknown[] }).commands, [{ op: "compose_graphic", start: 12, label: { title: "Chicken Tikka", sub: "Rs 380", tone: "premium" } }]);
});

/** A recording canvas context: enough of the 2D API for the overlay drawer. */
function fakeCtx() {
  const calls: { op: string; args: unknown[] }[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, font: "", fillStyle: "", strokeStyle: "", lineWidth: 1 };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (prop in state) return state[prop];
      if (prop === "measureText") return (s: string) => ({ width: s.length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (prop === "getTransform") return () => ({ a: 1, d: 1 });
      return (...args: unknown[]) => { calls.push({ op: prop, args }); };
    },
    set(_t, prop: string, value) { state[prop] = value; calls.push({ op: `set:${prop}`, args: [value] }); return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

test("the shared drawer renders every graphic part, in z-order, honouring per-part delays", () => {
  const g = { ...base("g", 12, 16), effectType: "graphic" as const, graphic: { parts: dishLabelParts("Chicken Tikka", "Rs 380") } } as DetectedMoment;
  assert.equal(hasOverlayMoments([g]), true);
  const layout = { canvasW: 1920, canvasH: 922 };
  // At the very start only the accent line has entered (title delay 0.18s, price 0.42s).
  const early = fakeCtx();
  drawOutputOverlays(early.ctx, [g], 12.05, layout);
  assert.ok(early.calls.some((c) => c.op === "stroke"), "line drawn");
  assert.ok(!early.calls.some((c) => c.op === "fillText"), "text not entered yet");
  // Mid-way every part is on screen: line stroked, both texts filled.
  const mid = fakeCtx();
  drawOutputOverlays(mid.ctx, [g], 14, layout);
  const texts = mid.calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
  assert.ok(texts.some((t) => t.includes("Chicken")) && texts.some((t) => t.includes("380")), `texts drawn: ${texts.join("|")}`);
  const order = mid.calls.filter((c) => c.op === "stroke" || c.op === "fillText").map((c) => c.op);
  assert.equal(order[0], "stroke", "lower z (line) drawn before text");
  // Outside its window nothing is drawn.
  const after = fakeCtx();
  drawOutputOverlays(after.ctx, [g], 16.5, layout);
  assert.equal(after.calls.filter((c) => c.op === "fillText" || c.op === "stroke").length, 0);
  // A rect part draws a rounded plate.
  const rect: GraphicPart = { id: "plate", kind: "rect", x: 0.05, y: 0.7, w: 0.3, h: 0.12, color: "#000000", radius: 0.2, z: 0 };
  const withRect = fakeCtx();
  drawOutputOverlays(withRect.ctx, [{ ...g, graphic: { parts: [rect, ...g.graphic!.parts] } }], 14, layout);
  assert.ok(withRect.calls.some((c) => c.op === "fill"), "rect filled");
  assert.ok(starterGraphic().parts.length >= 2);
});

function base(id: string, start: number, end: number): DetectedMoment {
  return { id, startTime: start, endTime: end, label: id, reason: "t", focusRegion: { x: 0, y: 0, width: 1, height: 1 }, effectType: "zoom", enabled: true, source: "user" } as DetectedMoment;
}

test("survey merge: adjacent beats of the same dish become one stretch; different dishes stay apart", async () => {
  const { mergeSurveyShots } = await import("../src/lib/edit-commands/survey.ts");
  const merged = mergeSurveyShots([
    { start: 9.5, end: 10.8, description: "Shawarma section appears", subjects: ["website", "Chicken Shawarma", "price"] },
    { start: 10.8, end: 11.6, description: "scrolls within the shawarma section", subjects: ["website", "scrolling", "Chicken Shawarma photo", "add to cart button"] },
    { start: 11.6, end: 12.9, description: "Chicken Tikka section", subjects: ["website", "Chicken Tikka", "price"] },
    { start: 12.9, end: 14, description: "Kabab roll", subjects: ["website", "Kabab Roll Paratha"] },
  ]);
  assert.deepEqual(merged.map((s) => [s.start, s.end]), [[9.5, 11.6], [11.6, 12.9], [12.9, 14]]);
  assert.ok(merged[0].subjects.includes("Chicken Shawarma photo"));
});

test("'remove the line' after working on a move resolves to the graphic PAIRED with that move", () => {
  const two = applyEditCommands(state(), [
    { op: "set_camera", start: 4, end: 7, beats: [{ at: 0, x: 0.5, y: 0.5, zoom: 1 }, { at: 1, x: 0.7, y: 0.5, zoom: 1.4 }] },
    { op: "compose_graphic", start: 5, duration: 2, label: { title: "Zinger Burger", sub: "Rs 450" } },
    { op: "set_camera", start: 11, end: 13, beats: [{ at: 0, x: 0.5, y: 0.5, zoom: 1 }, { at: 1, x: 0.7, y: 0.5, zoom: 1.4 }] },
    { op: "compose_graphic", start: 11.2, duration: 2, label: { title: "Chicken Tikka", sub: "Rs 380" } },
  ], "pair");
  assert.ok(two.ok);
  const firstMove = two.moments.find((m) => m.effectType === "zoom" && m.startTime === 4)!;
  const firstLabel = two.moments.find((m) => m.effectType === "graphic" && m.startTime === 5)!;
  // Playhead at the move's start (where the chat jumps after an edit), label not under it.
  const parsed = parseEditRequest("Remove the line but keep the title", input({ moments: two.moments, recentElementIds: [firstMove.id], playhead: 4 }));
  assert.deepEqual((parsed as { commands: unknown[] }).commands, [{ op: "update_graphic", elementId: firstLabel.id, removeParts: ["line"] }]);
  // With no recent element and the playhead away from both, it asks rather than guesses.
  assert.equal(parseEditRequest("Remove the line but keep the title", input({ moments: two.moments, playhead: 20 })).kind, "question");
});
