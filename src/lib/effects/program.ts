/**
 * Framevo effect programs ("fxp/1") — original visual effects authored by the
 * AI (or a person) as DATA, rendered by ONE interpreter that the preview, the
 * browser exporter, the Cloud Run worker and Remotion all call through
 * `drawInCameraOverlays`. Same saved program + same settings ⇒ same pixels.
 *
 * A program is a list of LAYERS. Each layer draws `count` copies of one shape
 * (circle, ring, arc, glow, line, spark, rect, text) whose position, size,
 * colour and opacity are EXPRESSIONS (see expr.ts) of time and the inputs the
 * footage provides — e.g. a ring centred on the ball that grows and fades, and
 * 80 sparks flying outward from it. Nothing else can run: no code, no network,
 * no storage; sizes and counts are capped so a program can't stall a frame.
 *
 * Coordinates: x/y are fractions of the VIDEO frame (0..1, the footage, inside
 * the camera transform — a zoom moves the effect with the ball). Sizes (r, w,
 * h, width, glow, size) are fractions of the frame HEIGHT, so an effect looks
 * the same at 720p and 4K.
 */

import { compileExpr, ExprError, type Compiled, type Env } from "./expr";

export const FX_API = "fxp/1";

export const FX_LIMITS = {
  layers: 24,
  countPerLayer: 400,
  primitivesPerFrame: 3000,
  params: 16,
  minDuration: 0.2,
  maxDuration: 12,
  textLength: 60,
} as const;

export type FxShape = "circle" | "ring" | "arc" | "glow" | "line" | "spark" | "rect" | "text";
export const FX_SHAPES: readonly FxShape[] = ["circle", "ring", "arc", "glow", "line", "spark", "rect", "text"];

export interface FxParam {
  /** Referenced as `$id` in expressions and colours. */
  id: string;
  label: string;
  type: "number" | "color";
  default: number | string;
  min?: number;
  max?: number;
}

/** Footage-derived inputs a program can require. */
export type FxInput = "anchor" | "anchor2";

export interface FxLayer {
  id: string;
  shape: FxShape;
  /** Copies of the shape; expressions see i (0..n-1), n and k = i/(n-1). Default 1. */
  count?: number;
  /** "add" brightens (light, fire, sparks); "screen" is a softer lighten. */
  blend?: "normal" | "add" | "screen";
  /** Visible while start ≤ t < end (seconds). Expressions; default the whole effect. */
  start?: string;
  end?: string;
  x: string;
  y: string;
  /** Radius (circle, ring, arc, glow). */
  r?: string;
  /** Rect size, centred on x/y. */
  w?: string;
  h?: string;
  /** Line/spark end point. */
  x2?: string;
  y2?: string;
  /** Stroke width (ring, arc, line, spark). */
  width?: string;
  /** Radians (rect, text). */
  rotation?: string;
  /** Arc angles, radians. */
  a0?: string;
  a1?: string;
  /** 0..1. Default 1. */
  alpha?: string;
  /** "#rrggbb" / "#rgb" or "$param" naming a colour param. Default white. */
  color?: string;
  /** Optional second colour, blended by `colorMix` (0 = color, 1 = color2). */
  color2?: string;
  colorMix?: string;
  /** Soft glow radius (shadow blur), fraction of frame height. */
  glow?: string;
  /** Text shape: the literal text, and its size. */
  text?: string;
  size?: string;
}

export interface EffectProgram {
  api: typeof FX_API;
  /** Seconds. The timeline instance lasts this long. */
  duration: number;
  params: FxParam[];
  inputs: FxInput[];
  layers: FxLayer[];
}

/** Settings of ONE timeline use of a program. */
export interface FxInstanceInputs {
  /** Where the effect is anchored (e.g. the ball), fractions of the video frame. */
  anchor?: { x: number; y: number };
  anchor2?: { x: number; y: number };
  /** Optional track of the anchor over the effect (t = seconds into the effect). */
  track?: { t: number; x: number; y: number }[];
}

export type FxParamValues = Record<string, number | string>;

// ── compile ─────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];
type ColorRef = { kind: "lit"; rgb: Rgb } | { kind: "param"; id: string };

interface CompiledLayer {
  id: string;
  shape: FxShape;
  count: number;
  blend: GlobalCompositeOperation;
  start: Compiled | null;
  end: Compiled | null;
  x: Compiled;
  y: Compiled;
  r: Compiled | null;
  w: Compiled | null;
  h: Compiled | null;
  x2: Compiled | null;
  y2: Compiled | null;
  width: Compiled | null;
  rotation: Compiled | null;
  a0: Compiled | null;
  a1: Compiled | null;
  alpha: Compiled | null;
  color: ColorRef;
  color2: ColorRef | null;
  colorMix: Compiled | null;
  glow: Compiled | null;
  text: string;
  size: Compiled | null;
}

export interface CompiledProgram {
  program: EffectProgram;
  layers: CompiledLayer[];
}

export interface FxIssue {
  /** Where: "layers[2].alpha", "params[0]", "duration". */
  path: string;
  message: string;
}

const BASE_VARS = ["t", "p", "d", "i", "n", "k", "ax", "ay", "bx", "by", "aspect"];

export function parseHex(s: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const ID = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/**
 * Compile and statically validate a program. Returns every problem at once so
 * a model can fix them all in one retry.
 */
export function compileProgram(input: unknown): { ok: true; compiled: CompiledProgram } | { ok: false; issues: FxIssue[] } {
  const issues: FxIssue[] = [];
  const bad = (path: string, message: string) => issues.push({ path, message });
  const p = input as Partial<EffectProgram> | null;
  if (!p || typeof p !== "object") return { ok: false, issues: [{ path: "", message: "Program must be an object." }] };
  if (p.api !== FX_API) bad("api", `Must be "${FX_API}".`);
  if (typeof p.duration !== "number" || !(p.duration >= FX_LIMITS.minDuration && p.duration <= FX_LIMITS.maxDuration)) {
    bad("duration", `Seconds, between ${FX_LIMITS.minDuration} and ${FX_LIMITS.maxDuration}.`);
  }
  const params = Array.isArray(p.params) ? p.params : [];
  if (!Array.isArray(p.params)) bad("params", "Must be an array (may be empty).");
  if (params.length > FX_LIMITS.params) bad("params", `At most ${FX_LIMITS.params} params.`);
  const numberParams = new Set<string>();
  const colorParams = new Set<string>();
  params.forEach((q, i) => {
    const path = `params[${i}]`;
    if (!q || typeof q !== "object" || !ID.test(String(q.id))) return bad(path, "Needs an id (letters, digits, _).");
    if (numberParams.has(q.id) || colorParams.has(q.id)) return bad(path, `Duplicate param id "${q.id}".`);
    if (q.type === "number") {
      if (typeof q.default !== "number" || !Number.isFinite(q.default)) return bad(path, "A number param needs a numeric default.");
      if (q.min != null && q.max != null && !(q.min <= q.max)) return bad(path, "min must be ≤ max.");
      numberParams.add(q.id);
    } else if (q.type === "color") {
      if (typeof q.default !== "string" || !parseHex(q.default)) return bad(path, 'A color param needs a "#rrggbb" default.');
      colorParams.add(q.id);
    } else bad(path, 'type must be "number" or "color".');
  });
  const inputs = Array.isArray(p.inputs) ? p.inputs : [];
  for (const inp of inputs) if (inp !== "anchor" && inp !== "anchor2") bad("inputs", `Unknown input "${String(inp)}" (anchor, anchor2).`);

  const vars = new Set([...BASE_VARS, ...[...numberParams].map((id) => `$${id}`)]);
  const layers = Array.isArray(p.layers) ? p.layers : [];
  if (!layers.length) bad("layers", "At least one layer.");
  if (layers.length > FX_LIMITS.layers) bad("layers", `At most ${FX_LIMITS.layers} layers.`);

  const colorRef = (v: unknown, path: string, fallback: Rgb | null): ColorRef | null => {
    if (v == null || v === "") return fallback ? { kind: "lit", rgb: fallback } : null;
    if (typeof v !== "string") {
      bad(path, 'A colour is "#rrggbb" or "$param".');
      return null;
    }
    if (v.startsWith("$")) {
      const id = v.slice(1);
      if (!colorParams.has(id)) {
        bad(path, `"${v}" is not a declared color param.`);
        return null;
      }
      return { kind: "param", id };
    }
    const rgb = parseHex(v);
    if (!rgb) {
      bad(path, 'A colour is "#rrggbb" or "$param".');
      return null;
    }
    return { kind: "lit", rgb };
  };

  const compiled: CompiledLayer[] = [];
  layers.slice(0, FX_LIMITS.layers).forEach((l, li) => {
    const lp = `layers[${li}]`;
    if (!l || typeof l !== "object") return bad(lp, "Must be an object.");
    if (!FX_SHAPES.includes(l.shape as FxShape)) return bad(`${lp}.shape`, `One of ${FX_SHAPES.join(", ")}.`);
    const count = l.count == null ? 1 : Number(l.count);
    if (!Number.isInteger(count) || count < 1 || count > FX_LIMITS.countPerLayer) bad(`${lp}.count`, `Integer 1..${FX_LIMITS.countPerLayer}.`);
    const ex = (key: keyof FxLayer, required: boolean): Compiled | null => {
      const src = l[key];
      if (src == null || src === "") {
        if (required) bad(`${lp}.${key}`, `Required for a ${l.shape}.`);
        return null;
      }
      const s = typeof src === "number" ? String(src) : src;
      if (typeof s !== "string") {
        bad(`${lp}.${key}`, "Must be an expression string.");
        return null;
      }
      try {
        return compileExpr(s, vars);
      } catch (err) {
        bad(`${lp}.${key}`, err instanceof ExprError ? err.message : "Invalid expression.");
        return null;
      }
    };
    const shape = l.shape as FxShape;
    const needsR = shape === "circle" || shape === "ring" || shape === "arc" || shape === "glow";
    const needsEnd = shape === "line" || shape === "spark";
    const layer: CompiledLayer = {
      id: typeof l.id === "string" && l.id ? l.id.slice(0, 40) : `layer${li}`,
      shape,
      count: Number.isInteger(count) ? Math.min(FX_LIMITS.countPerLayer, Math.max(1, count)) : 1,
      blend: l.blend === "add" ? "lighter" : l.blend === "screen" ? "screen" : "source-over",
      start: ex("start", false),
      end: ex("end", false),
      x: ex("x", true) ?? (() => 0.5),
      y: ex("y", true) ?? (() => 0.5),
      r: ex("r", needsR),
      w: ex("w", shape === "rect"),
      h: ex("h", shape === "rect"),
      x2: ex("x2", needsEnd),
      y2: ex("y2", needsEnd),
      width: ex("width", false),
      rotation: ex("rotation", false),
      a0: ex("a0", shape === "arc"),
      a1: ex("a1", shape === "arc"),
      alpha: ex("alpha", false),
      color: colorRef(l.color, `${lp}.color`, [255, 255, 255]) ?? { kind: "lit", rgb: [255, 255, 255] },
      color2: colorRef(l.color2, `${lp}.color2`, null),
      colorMix: ex("colorMix", false),
      glow: ex("glow", false),
      text: shape === "text" ? String(l.text ?? "").slice(0, FX_LIMITS.textLength) : "",
      size: ex("size", shape === "text"),
    };
    if (shape === "text" && !layer.text.trim()) bad(`${lp}.text`, "A text layer needs text.");
    compiled.push(layer);
  });

  if (issues.length) return { ok: false, issues };
  return { ok: true, compiled: { program: p as EffectProgram, layers: compiled } };
}

const cache = new WeakMap<object, CompiledProgram | null>();

/** Compile once per program object (programs are immutable once saved). */
export function compiledFor(program: EffectProgram): CompiledProgram | null {
  const hit = cache.get(program);
  if (hit !== undefined) return hit;
  const r = compileProgram(program);
  const out = r.ok ? r.compiled : null;
  cache.set(program, out);
  return out;
}

/** Defaults overlaid with an instance's own values (unknown keys ignored, numbers clamped). */
export function resolveParams(program: EffectProgram, values: FxParamValues | undefined): FxParamValues {
  const out: FxParamValues = {};
  for (const q of program.params ?? []) {
    const v = values?.[q.id];
    if (q.type === "number") {
      let n = typeof v === "number" && Number.isFinite(v) ? v : (q.default as number);
      if (q.min != null) n = Math.max(q.min, n);
      if (q.max != null) n = Math.min(q.max, n);
      out[q.id] = n;
    } else {
      out[q.id] = typeof v === "string" && parseHex(v) ? v : (q.default as string);
    }
  }
  return out;
}

// ── render ──────────────────────────────────────────────────────────────────

/** Where the video frame is on the canvas. */
export interface FxFrame {
  /** Canvas px of the video frame's top-left. */
  ox: number;
  oy: number;
  /** Video frame size on the canvas, px. */
  W: number;
  H: number;
}

/**
 * The subset of CanvasRenderingContext2D the interpreter uses. The real canvas
 * (browser, @napi-rs/canvas) satisfies it; the validator passes a recorder.
 */
export type FxContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "arc"
  | "moveTo"
  | "lineTo"
  | "closePath"
  | "fill"
  | "stroke"
  | "fillText"
  | "translate"
  | "rotate"
  | "createRadialGradient"
  | "fillRect"
> & {
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  lineWidth: number;
  lineCap: CanvasLineCap;
  shadowBlur: number;
  shadowColor: string;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

function anchorAt(inputs: FxInstanceInputs, t: number): { x: number; y: number } {
  const tr = inputs.track;
  if (tr && tr.length) {
    if (t <= tr[0].t) return tr[0];
    for (let j = 1; j < tr.length; j++) {
      if (t <= tr[j].t) {
        const a = tr[j - 1];
        const b = tr[j];
        const k = (t - a.t) / (b.t - a.t || 1);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
    }
    return tr[tr.length - 1];
  }
  return inputs.anchor ?? { x: 0.5, y: 0.5 };
}

const finite = (v: number) => Number.isFinite(v);

/**
 * Draw one instance of a program at `t` seconds into it. Returns the number of
 * primitives drawn (the validator's budget check reads it).
 */
export function drawEffectProgram(
  ctx: FxContext,
  compiled: CompiledProgram,
  settings: { params?: FxParamValues; inputs: FxInstanceInputs },
  t: number,
  frame: FxFrame
): number {
  const prog = compiled.program;
  const d = prog.duration;
  if (t < 0 || t > d) return 0;
  const params = resolveParams(prog, settings.params);
  const a = anchorAt(settings.inputs, t);
  const b = settings.inputs.anchor2 ?? a;
  const env: Env = { t, p: t / d, d, i: 0, n: 1, k: 0, ax: a.x, ay: a.y, bx: b.x, by: b.y, aspect: frame.W / (frame.H || 1) };
  for (const q of prog.params ?? []) if (q.type === "number") env[`$${q.id}`] = params[q.id] as number;
  const colorOf = (c: ColorRef): Rgb => (c.kind === "lit" ? c.rgb : parseHex(params[c.id] as string) ?? [255, 255, 255]);

  const X = (nx: number) => frame.ox + nx * frame.W;
  const Y = (ny: number) => frame.oy + ny * frame.H;
  const U = frame.H;
  let drawn = 0;

  for (const L of compiled.layers) {
    ctx.save();
    ctx.globalCompositeOperation = L.blend;
    const c1 = colorOf(L.color);
    const c2 = L.color2 ? colorOf(L.color2) : null;
    env.n = L.count;
    for (let i = 0; i < L.count; i++) {
      if (drawn >= FX_LIMITS.primitivesPerFrame) break;
      env.i = i;
      env.k = L.count > 1 ? i / (L.count - 1) : 0;
      if (L.start && t < L.start(env)) continue;
      if (L.end && t >= L.end(env)) continue;
      const alpha = L.alpha ? L.alpha(env) : 1;
      if (!(alpha > 0.002) || !finite(alpha)) continue;
      const x = L.x(env);
      const y = L.y(env);
      if (!finite(x) || !finite(y)) continue;
      let rgb = c1;
      if (c2 && L.colorMix) {
        const m = Math.min(1, Math.max(0, L.colorMix(env) || 0));
        rgb = [c1[0] + (c2[0] - c1[0]) * m, c1[1] + (c2[1] - c1[1]) * m, c1[2] + (c2[2] - c1[2]) * m];
      }
      const css = `rgb(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0})`;
      ctx.globalAlpha = Math.min(1, alpha);
      const glow = L.glow ? Math.max(0, Math.min(0.08, L.glow(env))) * U : 0;
      ctx.shadowBlur = finite(glow) ? glow : 0;
      ctx.shadowColor = glow > 0 ? css : "transparent";

      switch (L.shape) {
        case "circle":
        case "ring":
        case "arc": {
          const r = Math.max(0, L.r!(env)) * U;
          if (!finite(r) || r <= 0) continue;
          ctx.beginPath();
          const a0 = L.shape === "arc" ? L.a0!(env) : 0;
          const a1 = L.shape === "arc" ? L.a1!(env) : Math.PI * 2;
          if (!finite(a0) || !finite(a1)) continue;
          ctx.arc(X(x), Y(y), r, a0, a1);
          if (L.shape === "circle") {
            ctx.fillStyle = css;
            ctx.fill();
          } else {
            ctx.strokeStyle = css;
            ctx.lineWidth = Math.max(0.5, (L.width ? L.width(env) : 0.006) * U);
            ctx.lineCap = "round";
            ctx.stroke();
          }
          break;
        }
        case "glow": {
          const r = Math.max(0, L.r!(env)) * U;
          if (!finite(r) || r <= 0) continue;
          const g = ctx.createRadialGradient(X(x), Y(y), 0, X(x), Y(y), r);
          g.addColorStop(0, `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},1)`);
          g.addColorStop(1, `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(X(x), Y(y), r, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case "line":
        case "spark": {
          const x2 = L.x2!(env);
          const y2 = L.y2!(env);
          if (!finite(x2) || !finite(y2)) continue;
          ctx.strokeStyle = css;
          ctx.lineWidth = Math.max(0.5, (L.width ? L.width(env) : L.shape === "spark" ? 0.004 : 0.003) * U);
          ctx.lineCap = L.shape === "spark" ? "round" : "butt";
          ctx.beginPath();
          ctx.moveTo(X(x), Y(y));
          ctx.lineTo(X(x2), Y(y2));
          ctx.stroke();
          break;
        }
        case "rect": {
          const w = L.w!(env) * U;
          const h = L.h!(env) * U;
          const rot = L.rotation ? L.rotation(env) : 0;
          if (!finite(w) || !finite(h) || !finite(rot) || w <= 0 || h <= 0) continue;
          ctx.save();
          ctx.translate(X(x), Y(y));
          if (rot) ctx.rotate(rot);
          ctx.fillStyle = css;
          ctx.fillRect(-w / 2, -h / 2, w, h);
          ctx.restore();
          break;
        }
        case "text": {
          const size = Math.max(4, (L.size ? L.size(env) : 0.06) * U);
          const rot = L.rotation ? L.rotation(env) : 0;
          if (!finite(size) || !finite(rot)) continue;
          ctx.save();
          ctx.translate(X(x), Y(y));
          if (rot) ctx.rotate(rot);
          ctx.font = `800 ${Math.round(size)}px Inter, Arial, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = css;
          ctx.fillText(L.text, 0, 0);
          ctx.restore();
          break;
        }
      }
      drawn++;
    }
    ctx.restore();
  }
  return drawn;
}
