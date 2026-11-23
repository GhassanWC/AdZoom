/**
 * Effect programs (src/lib/effects): the safe expression language, the
 * compiler/validator, the shared renderer, the library's idempotent records,
 * the assistant's effect tools, and the timeline commands that use them.
 *
 * The GOLD_RIPPLE fixture below is a hand-written test program — the shape an
 * AI-authored program takes — used to exercise the pipeline deterministically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { compileExpr, ExprError, rand } from "../src/lib/effects/expr.ts";
import { compileProgram, drawEffectProgram, resolveParams, type EffectProgram, type FxContext } from "../src/lib/effects/program.ts";
import { testRenderProgram } from "../src/lib/effects/validate.ts";
import { addVersion, bakeDefaults, effectIdFor, fingerprint, newEntry, type EffectLibraryEntry } from "../src/lib/effects/library.ts";
import { handleFxTool, type FxToolContext } from "../src/lib/effects/assistant-tools.ts";
import { applyEditCommands } from "../src/lib/edit-commands/apply.ts";
import { audioLockFromMessage, isAudioLocked, mergeMemory } from "../src/lib/edit-commands/memory.ts";
import { activeOverlays, drawInCameraOverlays, hasOverlayMoments } from "../src/lib/render/overlay-draw.ts";
import type { DetectedMoment } from "../src/lib/firebase/schema.ts";

const GOLD_RIPPLE: EffectProgram = {
  api: "fxp/1",
  duration: 2.4,
  inputs: ["anchor"],
  params: [
    { id: "gold", label: "Gold", type: "color", default: "#f5c542" },
    { id: "rippleSpeed", label: "Ripple speed", type: "number", default: 1, min: 0.3, max: 3 },
    { id: "sparkDecay", label: "Spark fade", type: "number", default: 1.6, min: 0.3, max: 10 },
  ],
  layers: [
    { id: "ripple", shape: "ring", count: 3, blend: "add", start: "i*0.12", x: "ax", y: "ay", r: "0.02 + 0.22*easeOut((t - i*0.12)*$rippleSpeed)", width: "0.008*(1-p)", alpha: "1 - easeOut((t - i*0.12)*$rippleSpeed*0.9)", color: "$gold", glow: "0.01" },
    { id: "sparks", shape: "spark", count: 70, blend: "add", start: "0.35", x: "ax + cos(rand(i,1)*TAU)*0.3*easeOut(t-0.35)/aspect", y: "ay + sin(rand(i,1)*TAU)*0.3*easeOut(t-0.35)", x2: "ax + cos(rand(i,1)*TAU)*0.3*easeOut(t-0.4)/aspect", y2: "ay + sin(rand(i,1)*TAU)*0.3*easeOut(t-0.4)", alpha: "exp(-(t-0.35)*$sparkDecay)", color: "$gold", color2: "#ffffff", colorMix: "rand(i,2)*0.6" },
  ],
};

// ── expressions ─────────────────────────────────────────────────────────────

test("expressions: arithmetic, precedence, functions, ternary", () => {
  const vars = new Set(["t", "i", "$k"]);
  assert.equal(compileExpr("1 + 2 * 3", vars)({}), 7);
  assert.equal(compileExpr("-2^2", vars)({}), -4);
  assert.equal(compileExpr("2^3^2", vars)({}), 512, "right-associative");
  assert.equal(compileExpr("t > 1 ? 10 : 20", vars)({ t: 2 }), 10);
  assert.equal(compileExpr("clamp(t, 0, 1) + $k", vars)({ t: 5, $k: 2 }), 3);
  assert.equal(compileExpr("1/0", vars)({}), 0, "division by zero is 0, not Infinity");
  assert.equal(compileExpr("rand(3, 1)", vars)({}), rand(3, 1));
  assert.ok(rand(3, 1) >= 0 && rand(3, 1) < 1);
});

test("expressions are sandboxed: no unknown names, no property access, bounded size", () => {
  const vars = new Set(["t"]);
  assert.throws(() => compileExpr("window", vars), ExprError);
  assert.throws(() => compileExpr("constructor", vars), ExprError);
  assert.throws(() => compileExpr("t.constructor", vars), ExprError);
  assert.throws(() => compileExpr("fetch(1)", vars), /Unknown function/);
  assert.throws(() => compileExpr("$nope", vars), /Unknown parameter/);
  assert.throws(() => compileExpr("t;1", vars), ExprError);
  assert.throws(() => compileExpr("1+".repeat(300) + "1", vars), ExprError);
  assert.throws(() => compileExpr("(".repeat(40) + "1" + ")".repeat(40), vars), /nested|complex/);
});

// ── compile + render ────────────────────────────────────────────────────────

test("compileProgram reports every problem with a path", () => {
  const r = compileProgram({ api: "fxp/1", duration: 99, params: [{ id: "c", type: "color", default: "gold" }], inputs: ["ball"], layers: [{ shape: "blob", x: "1", y: "1" }, { shape: "ring", x: "ax", y: "ay", alpha: "$missing" }] });
  assert.equal(r.ok, false);
  const paths = (r as { issues: { path: string }[] }).issues.map((i) => i.path);
  for (const p of ["duration", "params[0]", "inputs", "layers[0].shape", "layers[1].r", "layers[1].alpha"]) assert.ok(paths.includes(p), `missing issue at ${p}: ${paths.join(", ")}`);
});

class CountingCtx {
  globalAlpha = 1; globalCompositeOperation = "source-over"; fillStyle: unknown = ""; strokeStyle: unknown = ""; lineWidth = 1; lineCap = "butt"; shadowBlur = 0; shadowColor = ""; font = ""; textAlign = "left"; textBaseline = "alphabetic";
  arcs: { x: number; y: number; r: number }[] = []; lines = 0; strokes: string[] = [];
  save() {} restore() {} beginPath() {} closePath() {} fill() {} translate() {} rotate() {} fillRect() {} fillText() {}
  stroke() { this.strokes.push(String(this.strokeStyle)); }
  arc(x: number, y: number, r: number) { this.arcs.push({ x, y, r }); }
  moveTo() { this.lines++; } lineTo() {}
  createRadialGradient() { return { addColorStop() {} }; }
}

test("the renderer draws an anchored ripple at the anchor, in frame pixels, and sparks later", () => {
  const c = compileProgram(GOLD_RIPPLE);
  assert.ok(c.ok);
  const compiled = (c as { compiled: Parameters<typeof drawEffectProgram>[1] }).compiled;
  const early = new CountingCtx();
  drawEffectProgram(early as unknown as FxContext, compiled, { inputs: { anchor: { x: 0.25, y: 0.75 } } }, 0.05, { ox: 100, oy: 50, W: 1000, H: 500 });
  assert.ok(early.arcs.length >= 1);
  assert.deepEqual([early.arcs[0].x, early.arcs[0].y], [100 + 250, 50 + 375], "ripple centred on the anchor");
  assert.equal(early.lines, 0, "no sparks before 0.35s");
  const later = new CountingCtx();
  const drawn = drawEffectProgram(later as unknown as FxContext, compiled, { inputs: { anchor: { x: 0.25, y: 0.75 } } }, 0.8, { ox: 0, oy: 0, W: 1000, H: 500 });
  assert.ok(later.lines >= 60, "sparks burst out");
  assert.ok(drawn > 60);
  assert.ok(later.strokes.some((s) => s.startsWith("rgb(245,197,66)")), "gold comes from the colour param");
});

test("params: an instance's values override defaults, are clamped, and only change what they name", () => {
  const p = resolveParams(GOLD_RIPPLE, { sparkDecay: 99, gold: "#3366ff", bogus: 1 });
  assert.deepEqual(p, { gold: "#3366ff", rippleSpeed: 1, sparkDecay: 10 });
  // Faster spark decay changes spark alpha only; ripple geometry is identical.
  const c = compileProgram(GOLD_RIPPLE);
  const compiled = (c as { compiled: Parameters<typeof drawEffectProgram>[1] }).compiled;
  const at = (params: Record<string, number>) => {
    const ctx = new CountingCtx();
    const alphas: number[] = [];
    const orig = ctx.stroke.bind(ctx);
    ctx.stroke = () => { alphas.push(ctx.globalAlpha); orig(); };
    drawEffectProgram(ctx as unknown as FxContext, compiled, { params, inputs: { anchor: { x: 0.5, y: 0.5 } } }, 1.0, { ox: 0, oy: 0, W: 1920, H: 1080 });
    return { arcs: ctx.arcs, alphas };
  };
  const slow = at({ sparkDecay: 1.6 });
  const fast = at({ sparkDecay: 6 });
  assert.deepEqual(fast.arcs, slow.arcs, "ripple rings unchanged");
  const sparkAlpha = (x: { alphas: number[] }) => x.alphas[x.alphas.length - 1];
  assert.ok(sparkAlpha(fast) < sparkAlpha(slow) / 5, "sparks fade much faster");
});

test("test-render: a good program passes with stats + an SVG preview; broken ones explain why", () => {
  const ok = testRenderProgram(GOLD_RIPPLE, { inputs: { anchor: { x: 0.6, y: 0.4 } } });
  assert.equal(ok.ok, true, JSON.stringify(ok.issues));
  assert.ok(ok.stats!.visibleFrames > 20);
  assert.ok(ok.stats!.startDistanceFromAnchor! < 0.05, "starts at the anchor");
  assert.match(ok.preview!, /^data:image\/svg\+xml;base64,/);
  const invisible = testRenderProgram({ ...GOLD_RIPPLE, layers: [{ ...GOLD_RIPPLE.layers[0], alpha: "0" }] });
  assert.equal(invisible.ok, false);
  assert.match(invisible.issues[0].message, /Nothing visible/);
  const offscreen = testRenderProgram({ ...GOLD_RIPPLE, layers: [{ ...GOLD_RIPPLE.layers[0], x: "ax + 5" }] });
  assert.equal(offscreen.ok, false);
  const far = testRenderProgram({ ...GOLD_RIPPLE, layers: [{ ...GOLD_RIPPLE.layers[0], x: "0.95", y: "0.1" }] }, { inputs: { anchor: { x: 0.1, y: 0.9 } } });
  assert.ok(far.warnings.some((w) => /away from the anchor/.test(w)));
});

// ── library ─────────────────────────────────────────────────────────────────

test("library: ids and versions are idempotent per request; saved looks bake current settings", () => {
  assert.equal(effectIdFor("req1", "create:1"), effectIdFor("req1", "create:1"));
  assert.notEqual(effectIdFor("req1", "create:1"), effectIdFor("req2", "create:1"));
  const e = newEntry({ id: "fx_a", name: "Gold Ripple", description: "", program: GOLD_RIPPLE, requestId: "r1", preview: null, origin: "created", note: "created", now: 1 });
  const v2 = addVersion(e, { program: GOLD_RIPPLE, note: "faster", requestId: "r2", preview: null, now: 2 });
  assert.equal(v2.version, 2);
  const retry = addVersion(v2.entry, { program: GOLD_RIPPLE, note: "faster", requestId: "r2", preview: null, now: 3 });
  assert.equal(retry.version, 2, "a retry of r2 replaces its version");
  assert.equal(retry.entry.versions.length, 2);
  const baked = bakeDefaults(GOLD_RIPPLE, { sparkDecay: 4.5 });
  assert.equal(baked.params.find((p) => p.id === "sparkDecay")!.default, 4.5);
  assert.equal(fingerprint(baked), fingerprint(GOLD_RIPPLE), "same design, different defaults");
});

// ── assistant tools → commands → timeline ───────────────────────────────────

function ctxFor(moments: () => DetectedMoment[], library: EffectLibraryEntry[] = []): FxToolContext {
  return { requestId: "req-A", library, writes: new Map(), momentsNow: moments, sourceDuration: 120, memory: [], memoryWrites: [], now: 1000, seq: { create: 0 } };
}
const STATE = { moments: [] as DetectedMoment[], sourceDuration: 120, canvasWidth: 1920, canvasHeight: 1080 };

test("create → revise one param → save as a named look → reuse on another moment", async () => {
  let moments: DetectedMoment[] = [];
  const ctx = ctxFor(() => moments);

  // 1. Create (validated + staged; library write only once accepted).
  const created = await handleFxTool("create_effect", { name: "Gold Ripple Sparks", description: "Gold ripple that breaks into sparks", program_json: JSON.stringify(GOLD_RIPPLE), at: 26.2, anchor_x: 0.62, anchor_y: 0.41 }, ctx);
  assert.equal(created.kind, "command");
  assert.equal(ctx.writes.size, 0, "not persisted before acceptance");
  (created as { stage: () => void }).stage();
  assert.equal(ctx.writes.size, 1);
  const r1 = applyEditCommands(STATE, [(created as { cmd: never }).cmd], "req-A");
  assert.ok(r1.ok);
  moments = (r1 as { moments: DetectedMoment[] }).moments;
  const inst = moments.find((m) => m.effectType === "fx")!;
  assert.equal(inst.startTime, 26.2);
  assert.equal(inst.endTime, 28.6);
  assert.deepEqual(inst.fx!.inputs.anchor, { x: 0.62, y: 0.41 });

  // 2. "Make only the sparks fade faster" — one param, nothing else.
  const upd = await handleFxTool("update_effect", { element_id: inst.id, params_json: JSON.stringify({ sparkDecay: 5 }) }, { ...ctx, requestId: "req-B" });
  const r2 = applyEditCommands({ ...STATE, moments }, [(upd as { cmd: never }).cmd], "req-B");
  assert.ok(r2.ok);
  const after = (r2 as { moments: DetectedMoment[] }).moments.find((m) => m.id === inst.id)!;
  assert.deepEqual(after.fx!.params, { sparkDecay: 5 });
  assert.equal(after.startTime, inst.startTime);
  assert.deepEqual(after.fx!.inputs, inst.fx!.inputs);
  assert.equal(after.fx!.program, inst.fx!.program, "program untouched (same version)");
  assert.match((r2 as { changes: { summary: string }[] }).changes[0].summary, /Spark fade 1\.6 → 5/);
  moments = (r2 as { moments: DetectedMoment[] }).moments;

  // 3. "Save this look as Matchday Gold" + reuse at the second goal.
  const ctx3 = { ...ctx, requestId: "req-C", writes: new Map<string, EffectLibraryEntry>() };
  const saved = await handleFxTool("save_effect", { element_id: inst.id, name: "Matchday Gold" }, ctx3);
  assert.equal(saved.kind, "read");
  const mg = [...ctx3.writes.values()][0];
  assert.equal(mg.name, "Matchday Gold");
  assert.equal(mg.origin, "saved");
  assert.equal(mg.versions[0].program.params.find((p) => p.id === "sparkDecay")!.default, 5, "current settings become the defaults");
  const reuse = await handleFxTool("apply_effect", { effect: "Matchday Gold", at: 52.4, anchor_x: 0.3, anchor_y: 0.55 }, ctx3);
  assert.equal(reuse.kind, "command");
  const r3 = applyEditCommands({ ...STATE, moments }, [(reuse as { cmd: never }).cmd], "req-C");
  assert.ok(r3.ok);
  const all = (r3 as { moments: DetectedMoment[] }).moments.filter((m) => m.effectType === "fx");
  assert.equal(all.length, 2);
  const second = all.find((m) => m.id !== inst.id)!;
  assert.deepEqual(second.fx!.ref, { effectId: mg.id, version: 1, name: "Matchday Gold" }, "came from the library");
  assert.equal(second.startTime, 52.4);
  const first = all.find((m) => m.id === inst.id)!;
  assert.deepEqual(first.fx!.params, { sparkDecay: 5 }, "first use keeps its own settings");
  assert.equal(first.fx!.ref.name, "Gold Ripple Sparks");
});

test("create_effect rejects a program that fails the test render, and 'something new' must differ", async () => {
  const ctx = ctxFor(() => []);
  const bad = await handleFxTool("create_effect", { name: "x", description: "", program_json: JSON.stringify({ ...GOLD_RIPPLE, layers: [{ ...GOLD_RIPPLE.layers[0], alpha: "0" }] }), at: 5, anchor_x: 0.5, anchor_y: 0.5 }, ctx);
  assert.equal(bad.kind, "error");
  assert.match((bad as { message: string }).message, /Test render failed/);
  const lib = [newEntry({ id: "fx_x", name: "Gold Ripple", description: "", program: GOLD_RIPPLE, requestId: "r0", preview: null, origin: "created", note: "", now: 0 })];
  const same = await handleFxTool("create_effect", { name: "y", description: "", program_json: JSON.stringify(GOLD_RIPPLE), at: 5, anchor_x: 0.5, anchor_y: 0.5, distinct: true }, ctxFor(() => [], lib));
  assert.equal(same.kind, "error");
  assert.match((same as { message: string }).message, /same design/);
});

test("update_effect rejects settings the effect doesn't have (no silent no-op)", () => {
  const r = applyEditCommands(STATE, [{ op: "add_effect", at: 1, fx: { ref: { effectId: "e", version: 1, name: "G" }, program: GOLD_RIPPLE, params: {}, inputs: { anchor: { x: 0.5, y: 0.5 } } } }], "rq");
  const id = (r as { moments: DetectedMoment[] }).moments[0].id;
  const bad = applyEditCommands({ ...STATE, moments: (r as { moments: DetectedMoment[] }).moments }, [{ op: "update_effect", elementId: id, params: { glowiness: 3 } }], "rq2");
  assert.equal(bad.ok, false);
  assert.match((bad as { errors: { message: string }[] }).errors[0].message, /no setting "glowiness".*sparkDecay/);
});

// ── memory + audio lock ─────────────────────────────────────────────────────

test("'keep the commentary' locks the soundtrack: cuts/speed are refused, effects are not", () => {
  const lock = audioLockFromMessage("Keep the commentary. When the ball crosses the line, create a gold ripple");
  assert.ok(lock);
  assert.equal(lock!.lock, "audio");
  assert.equal(isAudioLocked([lock!]), true);
  assert.equal(audioLockFromMessage("add a ripple when the ball crosses the line"), null);
  const locked = { ...STATE, audioLocked: true };
  const cut = applyEditCommands(locked, [{ op: "remove_range", start: 1, end: 3 }], "c1");
  assert.equal(cut.ok, false);
  assert.equal((cut as { errors: { code: string }[] }).errors[0].code, "locked");
  const fx = applyEditCommands(locked, [{ op: "add_effect", at: 1, fx: { ref: { effectId: "e", version: 1, name: "G" }, program: GOLD_RIPPLE, params: {}, inputs: { anchor: { x: 0.5, y: 0.5 } } } }], "c2");
  assert.ok(fx.ok);
  const mem = mergeMemory([lock!], [{ kind: "approved", text: "the ripple motion", at: 2 }, { ...lock!, at: 3 }]);
  assert.equal(mem.filter((m) => m.lock === "audio").length, 1, "no duplicate lock");
});

// ── shared renderer wiring ──────────────────────────────────────────────────

test("fx instances render in the in-camera pass (the same call preview and export make)", () => {
  const r = applyEditCommands(STATE, [{ op: "add_effect", at: 10, fx: { ref: { effectId: "e", version: 1, name: "G" }, program: GOLD_RIPPLE, params: {}, inputs: { anchor: { x: 0.5, y: 0.5 } } } }], "w1");
  const moments = (r as { moments: DetectedMoment[] }).moments;
  assert.equal(hasOverlayMoments(moments), true);
  assert.equal(activeOverlays(moments, 11).inCamera.length, 1);
  assert.equal(activeOverlays(moments, 13).inCamera.length, 0, "ends with the program");
  const ctx = new CountingCtx();
  drawInCameraOverlays(ctx as unknown as CanvasRenderingContext2D, moments, 10.05, 1920, 1080);
  assert.ok(ctx.arcs.length >= 1);
  assert.deepEqual([ctx.arcs[0].x, ctx.arcs[0].y], [0, 0], "anchor 0.5,0.5 = placement centre (origin)");
  const broken = moments.map((m) => ({ ...m, fx: { ...m.fx!, program: { ...m.fx!.program, layers: [{ shape: "nope" }] } as never } }));
  assert.doesNotThrow(() => drawInCameraOverlays(new CountingCtx() as unknown as CanvasRenderingContext2D, broken, 10.05, 1920, 1080), "an invalid saved program draws nothing");
});

test("prototype names never resolve (constructor, __proto__, toString)", () => {
  const vars = new Set(["t"]);
  for (const src of ["constructor", "constructor(1)", "__proto__", "toString()", "hasOwnProperty(1)", "valueOf"]) {
    assert.throws(() => compileExpr(src, vars), ExprError, src);
  }
});

// ── local revisions (no model) ──────────────────────────────────────────────

import { parseEditRequest } from "../src/lib/edit-commands/parse.ts";
const fxMoment = (id: string, start: number): DetectedMoment =>
  ({ id, startTime: start, endTime: start + 2.4, effectType: "fx", label: "Gold", reason: "", fx: { ref: { effectId: "e", version: 1, name: "Gold Ripple Sparks" }, program: GOLD_RIPPLE, params: {}, inputs: { anchor: { x: 0.5, y: 0.5 } } } }) as DetectedMoment;
const parseInput = (moments: DetectedMoment[], extra: Record<string, unknown> = {}) =>
  ({ project: { analysis: { detectedMoments: moments } }, moments, layers: {}, sourceDuration: 120, playhead: 0, selection: {}, recentElementIds: [], ...extra }) as never;

test("'I like the ripple. Make only the sparks fade faster.' changes only the spark decay, locally", () => {
  const out = parseEditRequest("I like the ripple. Make only the sparks fade faster.", parseInput([fxMoment("fx1", 26)]));
  assert.equal(out.kind, "commands");
  const c = (out as { commands: { op: string; params: Record<string, number> }[] }).commands;
  assert.equal(c.length, 1);
  assert.equal(c[0].op, "update_effect");
  assert.deepEqual(Object.keys(c[0].params), ["sparkDecay"]);
  assert.ok(c[0].params.sparkDecay > 1.6);
  assert.deepEqual((out as { approvals: string[] }).approvals, ["ripple"]);
});

test("'make this one blue' recolours the instance; two effects + no target asks which", () => {
  const out = parseEditRequest("Make this one blue", parseInput([fxMoment("fx1", 26)]));
  assert.deepEqual((out as { commands: unknown[] }).commands, [{ op: "update_effect", elementId: "fx1", params: { gold: "#2f7bff" } }]);
  const two = parseEditRequest("Make this one blue", parseInput([fxMoment("fx1", 26), fxMoment("fx2", 52)], { playhead: 40 }));
  assert.equal(two.kind, "question");
  const sel = parseEditRequest("Make this one blue", parseInput([fxMoment("fx1", 26), fxMoment("fx2", 52)], { selection: { elementId: "fx2" } }));
  assert.equal((sel as { commands: { elementId: string }[] }).commands[0].elementId, "fx2");
});

test("'Save this look as Matchday Gold …' is not hijacked by the Looks panel", () => {
  const out = parseEditRequest("Save this look as Matchday Gold and use it on the second goal.", parseInput([fxMoment("fx1", 26)]));
  assert.equal(out.kind, "none", "goes to the model (needs the library + the second goal)");
  const ui = parseEditRequest("open the looks", parseInput([]));
  assert.equal(ui.kind, "ui");
});
