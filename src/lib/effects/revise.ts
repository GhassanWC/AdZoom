/**
 * Local (no-model) revisions of an effect instance's SETTINGS — "make only the
 * sparks fade faster", "make this one blue", "make the ripple bigger".
 *
 * Effect programs expose what a person is likely to revise as named params
 * (sparkDecay, rippleSpeed, gold…). This maps the words in a request onto
 * those params by their ids/labels, so a precise revision is instant, works
 * offline, and touches exactly the param it names — the model is only needed
 * when no param covers the change.
 */

import type { DetectedMoment } from "@/lib/firebase/schema";
import { resolveParams, type FxParam, type FxParamValues } from "./program";

export const COLOR_WORDS: Record<string, string> = {
  blue: "#2f7bff",
  "light blue": "#6cc4ff",
  "sky blue": "#6cc4ff",
  navy: "#1f3a93",
  red: "#ff3b3b",
  green: "#2ecc71",
  gold: "#f5c542",
  golden: "#f5c542",
  white: "#ffffff",
  silver: "#c7ced8",
  purple: "#9b5cff",
  violet: "#9b5cff",
  orange: "#ff8a00",
  pink: "#ff5fa2",
  yellow: "#ffd400",
  cyan: "#22d3ee",
  teal: "#14b8a6",
};

type Axis = { verbs: RegExp; keys: RegExp; up: RegExp; down: RegExp; inverse?: RegExp };

/** What a request can say about a number, and which param names it applies to. */
const AXES: Axis[] = [
  // Fading: a decay RATE goes up for "fade faster"; a lifetime goes down.
  { verbs: /\b(fade|fades|fading|decay|die out|disappear|vanish|linger|last)\b/, keys: /fade|decay|life|linger|duration|hold/, up: /\b(faster|quicker|sooner|more quickly)\b/, down: /\b(slower|longer|more slowly|later|linger)\b/, inverse: /life|linger|duration|hold/ },
  // Motion speed.
  { verbs: /\b(faster|slower|quicker|slow(?: \w+){0,3} down|speed(?: \w+){0,3} up)\b/, keys: /speed|rate|velocity/, up: /\b(faster|quicker|speed(?: \w+){0,3} up)\b/, down: /\b(slower|slow(?: \w+){0,3} down)\b/ },
  // Size / reach.
  { verbs: /\b(bigger|larger|smaller|wider|narrower|further|farther|reach|size)\b/, keys: /size|radius|scale|spread|reach|width|distance/, up: /\b(bigger|larger|wider|further|farther)\b/, down: /\b(smaller|narrower|shorter)\b/ },
  // Brightness.
  { verbs: /\b(brighter|dimmer|stronger|softer|glow|intense)\b/, keys: /glow|bright|intensity|opacity|alpha|strength/, up: /\b(brighter|stronger|more intense)\b/, down: /\b(dimmer|softer|subtler)\b/ },
  // Amount.
  { verbs: /\b(more|fewer|less)\b/, keys: /count|density|amount|number/, up: /\bmore\b/, down: /\b(fewer|less)\b/ },
];

function words(p: FxParam): string {
  return `${p.id.replace(/([a-z])([A-Z])/g, "$1 $2")} ${p.label}`.toLowerCase();
}

/** "sparks" ↔ "spark", "ripples" ↔ "ripple" */
function stem(w: string): string {
  return w.replace(/(es|s)$/, "");
}

const PART_STOP = new Set(["make", "only", "the", "this", "that", "one", "it", "a", "an", "bit", "much", "little", "slightly", "fade", "faster", "slower", "bigger", "smaller", "more", "less", "please", "and", "but", "keep", "effect"]);

export type EffectRevision =
  | { kind: "params"; elementId: string; params: FxParamValues; note: string }
  /** Retime the whole instance (its program timeline stretched); factor > 1 = slower. */
  | { kind: "duration"; elementId: string; factor: number; note: string }
  | { kind: "question"; question: string }
  | { kind: "none" };

/**
 * Find the instance and the params a revision names. `target` resolution is
 * the caller's (selection → recently changed → under the playhead → the only one).
 */
export function parseEffectRevision(text: string, target: DetectedMoment | null, fxCount: number): EffectRevision {
  const t = text.toLowerCase();
  const colorWord = Object.keys(COLOR_WORDS)
    .sort((a, b) => b.length - a.length)
    .find((w) => new RegExp(`\\b${w}\\b`).test(t));
  const axis = AXES.find((a) => a.verbs.test(t) && (a.up.test(t) || a.down.test(t)));
  if (!colorWord && !axis) return { kind: "none" };
  if (!/^(please\s+)?(make|let|have|turn|change|set|slow|speed|can you make|could you make)\b|\b(fade|faster|slower|bigger|smaller|brighter|slow(?: \w+){0,3} down|speed(?: \w+){0,3} up)\b/.test(t)) return { kind: "none" };
  if (!target?.fx) {
    return fxCount > 1 ? { kind: "question", question: "Which effect? Select it on the timeline (or move the playhead onto it) and ask again." } : { kind: "none" };
  }
  const fx = target.fx;
  const params = fx.program.params;
  const current = resolveParams(fx.program, fx.params);
  // Part words the user named ("sparks", "ripple"), matched against param names.
  const named = t.split(/[^a-z]+/).filter((w) => w.length > 2 && !PART_STOP.has(w)).map(stem);
  const partScore = (p: FxParam) => named.filter((w) => words(p).split(/\s+/).some((x) => stem(x) === w)).length;
  const anyPartNamed = params.some((p) => partScore(p) > 0);

  if (colorWord) {
    const colors = params.filter((p) => p.type === "color");
    if (!colors.length) return { kind: "none" };
    const targets = anyPartNamed ? colors.filter((p) => partScore(p) > 0) : colors;
    if (!targets.length) return { kind: "none" };
    const hex = COLOR_WORDS[colorWord];
    const out: FxParamValues = {};
    for (const p of targets) out[p.id] = hex;
    return { kind: "params", elementId: target.id, params: out, note: `${targets.map((p) => p.label || p.id).join(", ")} → ${colorWord}` };
  }

  const ax = axis!;
  // "Slow the drawing / the animation / the whole thing down": the WHOLE
  // effect retimes (every part, and a linked freeze follows). A specific
  // part ("the sparks") still maps to its own param below.
  const wholeWords = /\b(drawing|draw|animation|animate|strokes?|whole|entire|all of it|the effect|everything)\b/;
  if (ax.keys.test("speed") && wholeWords.test(t) && !anyPartNamed) {
    const slower = ax.down.test(t);
    const strengthW = /\b(much|a lot|way|far)\b/.test(t) ? 2 : /\b(a bit|slightly|a little|a touch)\b/.test(t) ? 1.25 : 1.5;
    return { kind: "duration", elementId: target.id, factor: slower ? strengthW : 1 / strengthW, note: slower ? "slower" : "faster" };
  }
  const candidates = params
    .filter((p) => p.type === "number" && ax.keys.test(words(p).replace(/\s+/g, "")))
    .map((p) => ({ p, score: partScore(p) }))
    .filter((c) => !anyPartNamed || c.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) return { kind: "none" };
  const p = candidates[0].p;
  const up = ax.up.test(t);
  const inverse = !!ax.inverse && ax.inverse.test(words(p).replace(/\s+/g, ""));
  const strength = /\b(much|a lot|way|far)\b/.test(t) ? 2.5 : /\b(a bit|slightly|a little|a touch)\b/.test(t) ? 1.3 : 1.8;
  const factor = up !== inverse ? strength : 1 / strength;
  const before = current[p.id] as number;
  let next = Math.round(before * factor * 1000) / 1000;
  if (p.min != null) next = Math.max(p.min, next);
  if (p.max != null) next = Math.min(p.max, next);
  if (next === before) return { kind: "question", question: `${p.label || p.id} is already at its ${up !== inverse ? "maximum" : "minimum"}.` };
  return { kind: "params", elementId: target.id, params: { [p.id]: next }, note: `${p.label || p.id} ${before} → ${next}` };
}
