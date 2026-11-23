/**
 * The documented graphics interface the AI writes effect programs against.
 * One source: the assistant's system prompt embeds it, and it lists exactly
 * what program.ts / expr.ts accept (shapes, variables, functions, limits).
 */

import { FUNCTION_NAMES } from "./expr";
import { FX_API, FX_LIMITS, FX_SHAPES } from "./program";

const EXAMPLE = {
  api: FX_API,
  duration: 1.8,
  inputs: ["anchor"],
  params: [
    { id: "tint", label: "Colour", type: "color", default: "#4fd1ff" },
    { id: "spread", label: "Spread", type: "number", default: 0.22, min: 0.05, max: 0.5 },
    { id: "fade", label: "Fade speed", type: "number", default: 2.2, min: 0.5, max: 8 },
  ],
  layers: [
    { id: "flash", shape: "glow", blend: "add", x: "ax", y: "ay", r: "0.05 + 0.12*easeOut(p*3)", alpha: "1 - easeOut(p*2.5)", color: "$tint" },
    {
      id: "confetti",
      shape: "rect",
      count: 60,
      start: "0.05*rand(i)",
      x: "ax + cos(rand(i,1)*TAU) * $spread * easeOut(t*1.4) / aspect",
      y: "ay + sin(rand(i,1)*TAU) * $spread * easeOut(t*1.4) + 0.08*t*t",
      w: "0.012",
      h: "0.006",
      rotation: "t*8*(rand(i,2)-0.5)",
      alpha: "exp(-t*$fade)",
      color: "$tint",
      color2: "#ffffff",
      colorMix: "rand(i,3)",
    },
  ],
};

export const FX_DOCS = `EFFECT PROGRAMS (${FX_API}) — original effects you author as JSON, validated and test-rendered before they reach the timeline.
A program: {"api":"${FX_API}","duration":seconds (${FX_LIMITS.minDuration}–${FX_LIMITS.maxDuration}),"inputs":["anchor"] (or [] / ["anchor","anchor2"]),"params":[…],"layers":[…]}
Layer: {"id","shape","count"(1–${FX_LIMITS.countPerLayer}),"blend":"normal"|"add"|"screen","start","end","x","y", shape fields…, "alpha","color","color2","colorMix","glow"}
Shapes (${FX_SHAPES.join(", ")}):
- circle: x,y,r (filled) · ring: x,y,r,width (outline) · arc: x,y,r,width,a0,a1 (radians) · glow: x,y,r (soft radial light)
- line / spark: x,y → x2,y2, width (spark = round glowing streak) · rect: x,y (centre), w,h, rotation · text: text (literal), x,y, size, rotation
Every numeric field is an EXPRESSION string. Positions x,y are fractions of the VIDEO frame (0..1, the footage — it moves with any camera zoom). Sizes r,w,h,width,glow,size are fractions of the frame HEIGHT; divide horizontal offsets by aspect to keep circles round.
Variables: t (seconds since the effect started), p = t/d, d (duration), i (copy index), n (copies), k = i/(n-1), ax,ay (anchor — e.g. where the ball is), bx,by (anchor2), aspect (frame width/height), and $paramId for each number param.
Functions: ${FUNCTION_NAMES.join(", ")}. Constants PI, TAU, E. Operators + - * / % ^ < <= > >= == != && || ?: .
rand(i, seed) is a deterministic 0..1 hash — use it for per-copy variety (never anything time-random). envelope(x, start, rise, end) is a soft one-shot.
Colours: "#rrggbb" or "$paramId" of a color param. alpha ≤ 0 skips a copy; a layer shows while start ≤ t < end.
Limits: ${FX_LIMITS.layers} layers, ${FX_LIMITS.countPerLayer} copies per layer, ${FX_LIMITS.primitivesPerFrame} shapes per frame, expressions ≤ 400 chars.
PARAMS are what the user can change later without regenerating the effect ("make the sparks fade faster", "make it blue"). Expose every property a person is likely to revise — each colour, each fade/decay rate, speeds, sizes, counts-as-spread, delays — with descriptive ids (sparkDecay, rippleSpeed, goldColor) and sensible min/max. Use separate params for separate parts so revising one part leaves the others untouched.
Craft: anchored effects start AT the anchor (ax, ay) at t≈0. Layer light with blend "add" and glow. Ease motion (easeOut for bursts, exp(-t*rate) for decay). Stagger copies with start = small rand(i) offsets. Keep it inside the frame.
Example (a confetti pop — for reference, do not reuse its look):
${JSON.stringify(EXAMPLE)}`;
