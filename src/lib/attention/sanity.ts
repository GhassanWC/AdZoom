/**
 * Invariant-3 guard: the attention curve lives in exactly one place.
 *
 * If any code outside `src/lib/attention/` defines a function or exported
 * symbol whose name starts with `attention` or `importance`, this script
 * fails the lint. The CV pipeline's internal `buildAttentionCurve` in
 * `src/lib/cv/resample.ts` is grandfathered in as it produces only the
 * CV-only sub-signal that feeds into the canonical curve; nothing outside
 * the attention module should expose a parallel "importance" API.
 *
 * Invoked from `npm run lint` via `node` (this file is plain JS at runtime).
 * Returns process exit code 0 (clean) or 1 (offenders found).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(process.cwd(), "src");
const ATTENTION_DIR = join("lib", "attention");
const ALLOWLIST = new Set([
  // CV-only baseline; intentionally produces a sub-signal, not the canonical curve.
  join("lib", "cv", "resample.ts"),
  // Schema field declarations are types, not runtime importance APIs.
  join("lib", "firebase", "schema.ts"),
  // The balancer reads attention scores from moments; doesn't compute its own.
  join("lib", "timeline-balancer.ts"),
  // Fusion samples attention from moments + CV; does not redefine the curve.
  join("lib", "cv", "fusion.ts"),
]);

const FORBIDDEN = /\b(function|const|let|var|class)\s+(attention|importance)\w*/i;
const FORBIDDEN_EXPORT = /\bexport\s+(function|const|let|var|class|type|interface)\s+(attention|importance)\w*/i;

interface Offender {
  file: string;
  line: number;
  match: string;
}

function walk(dir: string, acc: string[]) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(full);
    }
  }
}

export function findAttentionInvariantOffenders(): Offender[] {
  const files: string[] = [];
  walk(ROOT, files);

  const offenders: Offender[] = [];
  for (const abs of files) {
    const rel = relative(ROOT, abs);
    // Allow anything under the attention module.
    if (rel.startsWith(ATTENTION_DIR + sep) || rel === ATTENTION_DIR + ".ts") continue;
    if (ALLOWLIST.has(rel)) continue;

    const text = readFileSync(abs, "utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (FORBIDDEN.test(line) || FORBIDDEN_EXPORT.test(line)) {
        const m = line.match(FORBIDDEN) ?? line.match(FORBIDDEN_EXPORT);
        offenders.push({ file: rel, line: i + 1, match: m?.[0] ?? line.trim() });
      }
    }
  }
  return offenders;
}

// Allow running as a script: `node --import tsx src/lib/attention/sanity.ts`
// or wired via `npm run lint:attention`.
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("sanity.ts")
) {
  const offenders = findAttentionInvariantOffenders();
  if (offenders.length === 0) {
    console.log("[attention sanity] ✓ no parallel attention/importance APIs found");
    process.exit(0);
  } else {
    console.error("[attention sanity] FAIL — parallel importance APIs found:");
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  ${o.match}`);
    }
    console.error(
      "\nInvariant 3: the attention curve lives only in src/lib/attention/.\n" +
        "Move the offending function there, or add it to ALLOWLIST in sanity.ts\n" +
        "with a comment explaining why it's not a parallel importance signal."
    );
    process.exit(1);
  }
}
