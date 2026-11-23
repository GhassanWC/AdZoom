/**
 * A tiny, safe expression language for AI-authored effect programs.
 *
 * Effect programs are written by a model, so they are DATA interpreted here —
 * never `eval`, `new Function` or a worker running arbitrary JS. An expression
 * can only read the variables it was compiled against and call the pure math
 * functions below: no property access, no assignment, no loops, no strings, no
 * globals. Bounded size and depth, so a hostile or runaway program can't hang
 * the preview or the export worker.
 *
 *   number · variable · $param · f(a, b) · unary - ! · binary + - * / % ^
 *   comparisons < <= > >= == != (→ 1 or 0) · && || · c ? a : b · ( … )
 */

export type Env = Record<string, number>;
export type Compiled = (env: Env) => number;

export class ExprError extends Error {}

export const MAX_EXPR_LENGTH = 400;
const MAX_NODES = 160;
const MAX_DEPTH = 32;

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const fract = (x: number) => x - Math.floor(x);
/** Deterministic hash → 0..1. Same inputs give the same value in preview and export. */
export function rand(a: number, b = 0): number {
  let h = Math.imul((a * 1000003) | 0, 0x9e3779b1) ^ Math.imul((b * 999983) | 0, 0x85ebca6b);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const smooth = (x: number) => x * x * (3 - 2 * x);
/** Smooth 1-D value noise, deterministic. */
function noise(x: number, seed = 0): number {
  const i = Math.floor(x);
  return rand(i, seed) + (rand(i + 1, seed) - rand(i, seed)) * smooth(x - i);
}

/** Every function an expression may call: name → [arity range, implementation]. */
const FUNCS: Record<string, [number, number, (...a: number[]) => number]> = {
  sin: [1, 1, Math.sin],
  cos: [1, 1, Math.cos],
  tan: [1, 1, Math.tan],
  asin: [1, 1, Math.asin],
  acos: [1, 1, Math.acos],
  atan: [1, 1, Math.atan],
  atan2: [2, 2, Math.atan2],
  abs: [1, 1, Math.abs],
  sign: [1, 1, Math.sign],
  floor: [1, 1, Math.floor],
  ceil: [1, 1, Math.ceil],
  round: [1, 1, Math.round],
  fract: [1, 1, fract],
  sqrt: [1, 1, (x) => Math.sqrt(Math.max(0, x))],
  pow: [2, 2, Math.pow],
  exp: [1, 1, Math.exp],
  log: [1, 1, (x) => Math.log(Math.max(1e-9, x))],
  min: [2, 4, Math.min],
  max: [2, 4, Math.max],
  clamp: [3, 3, clamp],
  sat: [1, 1, (x) => clamp(x, 0, 1)],
  mix: [3, 3, (a, b, k) => a + (b - a) * k],
  step: [2, 2, (e, x) => (x < e ? 0 : 1)],
  smoothstep: [3, 3, (a, b, x) => smooth(clamp((x - a) / (b - a || 1e-9), 0, 1))],
  /** 1 inside [a, b), else 0. */
  within: [3, 3, (x, a, b) => (x >= a && x < b ? 1 : 0)],
  rand: [1, 2, rand],
  noise: [1, 2, noise],
  easeIn: [1, 1, (x) => clamp(x, 0, 1) ** 3],
  easeOut: [1, 1, (x) => 1 - (1 - clamp(x, 0, 1)) ** 3],
  easeInOut: [1, 1, (x) => smooth(clamp(x, 0, 1))],
  easeOutBack: [1, 1, (x) => {
    const c = 1.70158;
    const t = clamp(x, 0, 1) - 1;
    return 1 + (c + 1) * t ** 3 + c * t ** 2;
  }],
  /** Rise over [a, a+w], fall to 0 by b: a soft one-shot envelope. */
  envelope: [4, 4, (x, a, w, b) => (x < a || x > b ? 0 : Math.min(clamp((x - a) / (w || 1e-9), 0, 1), clamp((b - x) / Math.max(1e-9, (b - a) * 0.35), 0, 1)))],
};

const CONSTS: Record<string, number> = { PI: Math.PI, TAU: Math.PI * 2, E: Math.E };

export const FUNCTION_NAMES = Object.keys(FUNCS);

// ── tokenizer ───────────────────────────────────────────────────────────────

type Tok =
  | { k: "num"; v: number }
  | { k: "id"; v: string }
  | { k: "op"; v: string }
  | { k: "end" };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i))!;
      out.push({ k: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^\$?[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (!m) throw new ExprError(`Unexpected "${c}"`);
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "==", "!=", "&&", "||"].includes(two)) {
      out.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if ("+-*/%^()<>!?:,".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}"`);
  }
  out.push({ k: "end" });
  return out;
}

// ── parser → closures ───────────────────────────────────────────────────────

const BIN: Record<string, [number, (a: number, b: number) => number]> = {
  "||": [1, (a, b) => (a || b ? 1 : 0)],
  "&&": [2, (a, b) => (a && b ? 1 : 0)],
  "==": [3, (a, b) => (a === b ? 1 : 0)],
  "!=": [3, (a, b) => (a !== b ? 1 : 0)],
  "<": [4, (a, b) => (a < b ? 1 : 0)],
  "<=": [4, (a, b) => (a <= b ? 1 : 0)],
  ">": [4, (a, b) => (a > b ? 1 : 0)],
  ">=": [4, (a, b) => (a >= b ? 1 : 0)],
  "+": [5, (a, b) => a + b],
  "-": [5, (a, b) => a - b],
  "*": [6, (a, b) => a * b],
  "/": [6, (a, b) => (b === 0 ? 0 : a / b)],
  "%": [6, (a, b) => (b === 0 ? 0 : a % b)],
  "^": [8, (a, b) => a ** b],
};

/**
 * Compile `src` against the allowed variable names. Throws ExprError with a
 * message a model can act on ("Unknown variable \"ballX\" — use ax/ay").
 */
export function compileExpr(src: string, vars: ReadonlySet<string>): Compiled {
  if (typeof src !== "string") throw new ExprError("Expression must be a string.");
  if (src.length > MAX_EXPR_LENGTH) throw new ExprError(`Expression longer than ${MAX_EXPR_LENGTH} characters.`);
  const toks = tokenize(src);
  let pos = 0;
  let nodes = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expectOp = (v: string) => {
    const t = next();
    if (t.k !== "op" || t.v !== v) throw new ExprError(`Expected "${v}"`);
  };
  const count = (depth: number) => {
    if (++nodes > MAX_NODES) throw new ExprError("Expression too complex.");
    if (depth > MAX_DEPTH) throw new ExprError("Expression nested too deeply.");
  };

  function primary(depth: number): Compiled {
    count(depth);
    const t = next();
    if (t.k === "num") {
      const v = t.v;
      return () => v;
    }
    if (t.k === "op" && t.v === "(") {
      const e = ternary(depth + 1);
      expectOp(")");
      return e;
    }
    if (t.k === "op" && (t.v === "-" || t.v === "!" || t.v === "+")) {
      const e = unaryPow(depth + 1);
      return t.v === "-" ? (env) => -e(env) : t.v === "!" ? (env) => (e(env) ? 0 : 1) : e;
    }
    if (t.k === "id") {
      const name = t.v;
      const p = peek();
      if (p.k === "op" && p.v === "(") {
        next();
        // Own properties only — "constructor", "__proto__" etc. must not resolve.
        const fn = Object.prototype.hasOwnProperty.call(FUNCS, name) ? FUNCS[name] : undefined;
        if (!fn) throw new ExprError(`Unknown function "${name}". Available: ${FUNCTION_NAMES.join(", ")}.`);
        const args: Compiled[] = [];
        const close = peek();
        if (!(close.k === "op" && close.v === ")")) {
          for (;;) {
            args.push(ternary(depth + 1));
            const s = next();
            if (s.k === "op" && s.v === ")") break;
            if (!(s.k === "op" && s.v === ",")) throw new ExprError(`Expected "," or ")" in ${name}(…)`);
          }
        } else next();
        if (args.length < fn[0] || args.length > fn[1]) throw new ExprError(`${name}() takes ${fn[0] === fn[1] ? fn[0] : `${fn[0]}–${fn[1]}`} arguments.`);
        const f = fn[2];
        if (args.length === 1) {
          const [a] = args;
          return (env) => f(a(env));
        }
        if (args.length === 2) {
          const [a, b] = args;
          return (env) => f(a(env), b(env));
        }
        if (args.length === 3) {
          const [a, b, c] = args;
          return (env) => f(a(env), b(env), c(env));
        }
        return (env) => f(...args.map((a) => a(env)));
      }
      if (Object.prototype.hasOwnProperty.call(CONSTS, name)) {
        const v = CONSTS[name];
        return () => v;
      }
      if (!vars.has(name)) {
        throw new ExprError(
          name.startsWith("$")
            ? `Unknown parameter "${name}" — declare it in params.`
            : `Unknown variable "${name}". Available: ${[...vars].filter((v) => !v.startsWith("$")).join(", ")}.`
        );
      }
      return (env) => {
        const v = env[name];
        return typeof v === "number" ? v : 0;
      };
    }
    throw new ExprError(t.k === "end" ? "Unexpected end of expression." : `Unexpected "${(t as { v: unknown }).v}".`);
  }

  // Unary binds looser than ^ (so -x^2 = -(x^2)), tighter than * /.
  function unaryPow(depth: number): Compiled {
    const base = primary(depth);
    const p = peek();
    if (p.k === "op" && p.v === "^") {
      next();
      const exp = unaryPow(depth + 1);
      return (env) => base(env) ** exp(env);
    }
    return base;
  }

  function binary(minPrec: number, depth: number): Compiled {
    let left = unaryPow(depth);
    for (;;) {
      const p = peek();
      if (p.k !== "op" || !(p.v in BIN) || p.v === "^") break;
      const [prec, f] = BIN[p.v];
      if (prec < minPrec) break;
      next();
      const right = binary(prec + 1, depth + 1);
      const l = left;
      left = (env) => f(l(env), right(env));
      count(depth);
    }
    return left;
  }

  function ternary(depth: number): Compiled {
    const cond = binary(1, depth);
    const p = peek();
    if (p.k === "op" && p.v === "?") {
      next();
      const a = ternary(depth + 1);
      expectOp(":");
      const b = ternary(depth + 1);
      return (env) => (cond(env) ? a(env) : b(env));
    }
    return cond;
  }

  const fn = ternary(0);
  if (peek().k !== "end") throw new ExprError(`Unexpected "${(peek() as { v: unknown }).v}" after the expression.`);
  return fn;
}
