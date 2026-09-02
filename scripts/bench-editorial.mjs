/**
 * Golden Editorial Benchmark — replay tier.
 *
 *   npm run bench:editorial                 # run, compare against baseline if present
 *   npm run bench:editorial -- --save-baseline
 *
 * Replays committed signal fixtures (bench/fixtures/*.json) through the REAL
 * server-side selection pipeline — balanceTimeline → decideTimeline →
 * generateOverlayEdits → reviewComposition — per template named in
 * bench/manifest.json, then writes bench/runs/<stamp>/{results.json,report.md}.
 *
 * Deterministic by construction (no Gemini, no I/O in the pipeline), so
 * comparisons against bench/baseline.json are EXACT. The real-video tier
 * (Playwright over the standalone server, tolerance bands) is documented in
 * bench/README.md and gated on the corpus being collected.
 *
 * ACCEPTANCE GATES (exit code 1 on failure) for talking-head fixtures:
 *   clean-pro inappropriate.total < classic inappropriate.total  (every fixture)
 *   clean-pro cursorEmphasisCount === 0
 *   clean-pro cutCount >= classic cutCount   (no missed-edit regression)
 *   clean-pro zoomSpacingViolations === 0
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { balanceTimeline } = await import("../src/lib/timeline-balancer.ts");
const { decideTimeline } = await import("../src/lib/analysis/editorial-decision.ts");
const { generateOverlayEdits } = await import("../src/lib/analysis/overlay-generators.ts");
const { resolveEditRecipe } = await import("../src/lib/analysis/edit-recipe.ts");
const { contextFromSelectedVideoType } = await import("../src/lib/editorial/context.ts");
const { getTemplate } = await import("../src/lib/editorial/templates.ts");
const { resolveEditorialPolicy, overlayAllowFromPolicy } = await import(
  "../src/lib/editorial/resolve.ts"
);
const { reviewComposition, applyCompositionActions } = await import(
  "../src/lib/editorial/composition.ts"
);
const { computeBenchMetrics } = await import("../src/lib/editorial/bench-metrics.ts");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = path.join(ROOT, "bench");
const saveBaseline = process.argv.includes("--save-baseline");

const manifest = JSON.parse(readFileSync(path.join(BENCH, "manifest.json"), "utf8"));

function expandCurve(spec, duration) {
  return Array.from({ length: Math.round(duration) }, (_, i) => {
    let v = spec.baseline;
    for (const b of spec.bumps) v += spec.amp * Math.exp(-((i - b.t) ** 2) / b.w);
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  });
}

function expandCandidates(fixture) {
  return fixture.candidates.map((c) => ({
    id: c.id,
    startTime: c.t,
    endTime: c.end ?? c.t + 1.6,
    label: c.label ?? `Moment ${c.id}`,
    reason: c.reason ?? "Benchmark candidate",
    focusRegion: { x: 0.38, y: 0.3, width: 0.24, height: 0.28 },
    effectType: c.type,
    confidenceScore: c.conf,
    source: "ai",
    provenance: c.prov ?? "cv",
    ...(c.target ? { targetRegionSource: c.target } : {}),
  }));
}

function runCell(fixture, templateId) {
  const template = getTemplate(templateId);
  if (!template) throw new Error(`unknown template ${templateId}`);
  const profile = contextFromSelectedVideoType(fixture.selectedVideoType);
  const resolved = resolveEditorialPolicy({
    profile,
    template,
    signals: fixture.signals,
  });
  const duration = fixture.durationSeconds;
  const pacing = resolved.pacing ?? fixture.context.pacing;
  const candidates = expandCandidates(fixture);

  // Finalize-shaped balance: progressive candidates arrive preserved.
  const balanced = balanceTimeline({
    raw: [],
    duration,
    pacing,
    videoType: fixture.context.videoType,
    preserved: candidates,
    ...(resolved.mode === "enforce"
      ? { policy: { minTotal: resolved.balancer.minTotal } }
      : {}),
  });

  const decided = decideTimeline(balanced.moments, {
    duration,
    pacing,
    policy: resolved.decision,
    videoType: fixture.context.videoType,
    clickTimes: fixture.context.clickTimes,
    sceneChanges: fixture.context.sceneChanges,
    silenceSegments: fixture.context.silenceSegments,
    boringSections: fixture.context.boringSections,
    attentionCurve: expandCurve(fixture.context.attention, duration),
    attentionSampleRate: 1,
  });

  const plan = resolveEditRecipe({
    selectedVideoType: fixture.selectedVideoType,
    signals: fixture.signals,
  });
  const policyAllow = overlayAllowFromPolicy(resolved);
  const and = (key) => (policyAllow[key] === false ? false : true);
  const overlays = generateOverlayEdits({
    plan,
    moments: decided.kept,
    duration,
    projectTitle: fixture.title,
    hasOutputCanvas: false,
    transcript: null,
    allow: {
      hook_text: and("hook_text"),
      text_overlay: and("text_overlay"),
      smart_crop: and("smart_crop"),
      callout: and("callout"),
      transition: and("transition"),
      branding: and("branding"),
    },
    policy: resolved.overlays,
  });

  let final = [...decided.kept, ...overlays.moments].sort((a, b) => a.startTime - b.startTime);
  const composition = reviewComposition(final, resolved, { durationSeconds: duration });
  final = applyCompositionActions(final, composition);

  const metrics = computeBenchMetrics({
    moments: final,
    durationSeconds: duration,
    kind: fixture.kind,
    silenceSegments: fixture.context.silenceSegments,
    policy: resolved.mode === "enforce" ? resolved : undefined,
  });

  return {
    templateId,
    mode: resolved.mode,
    metrics,
    keptIds: final.filter((m) => m.enabled !== false).map((m) => `${m.effectType}:${m.id}`),
    disabledIds: final.filter((m) => m.enabled === false).map((m) => m.id),
    selectionDrops: decided.log,
    compositionCounts: composition.counts,
  };
}

const results = {};
for (const entry of manifest.fixtures) {
  const fixture = JSON.parse(readFileSync(path.join(BENCH, entry.file), "utf8"));
  results[fixture.id] = { kind: fixture.kind, cells: {} };
  for (const templateId of entry.templates) {
    results[fixture.id].cells[templateId] = runCell(fixture, templateId);
  }
}

/* ── Acceptance gates ─────────────────────────────────────────────────────── */
const gates = [];
for (const [fixtureId, r] of Object.entries(results)) {
  if (r.kind !== "talking-head") continue;
  const classic = Object.values(r.cells).find((c) => c.mode === "classic");
  const pro = r.cells["talking-clean-pro"];
  if (!classic || !pro) continue;
  const check = (name, ok, detail) => gates.push({ fixtureId, name, ok, detail });
  check(
    "fewer-inappropriate",
    pro.metrics.inappropriate.total < classic.metrics.inappropriate.total ||
      (classic.metrics.inappropriate.total === 0 && pro.metrics.inappropriate.total === 0),
    `${classic.metrics.inappropriate.total} → ${pro.metrics.inappropriate.total}`
  );
  check("zero-cursor-emphasis", pro.metrics.cursorEmphasisCount === 0, `${pro.metrics.cursorEmphasisCount}`);
  check(
    "no-cut-regression",
    pro.metrics.cutCount >= classic.metrics.cutCount,
    `${classic.metrics.cutCount} → ${pro.metrics.cutCount}`
  );
  check("zoom-spacing-clean", pro.metrics.zoomSpacingViolations === 0, `${pro.metrics.zoomSpacingViolations}`);
  check(
    "zero-decoration",
    pro.metrics.decorativeOverlayCount === 0,
    `${pro.metrics.decorativeOverlayCount}`
  );
}
const gatesFailed = gates.filter((g) => !g.ok);

/* ── Baseline compare (exact — the replay tier is deterministic) ─────────── */
const baselinePath = path.join(BENCH, "baseline.json");
let baselineDiff = null;
if (saveBaseline) {
  writeFileSync(baselinePath, JSON.stringify(results, null, 2));
} else if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const diffs = [];
  for (const [fid, r] of Object.entries(results)) {
    for (const [tid, cell] of Object.entries(r.cells)) {
      const base = baseline[fid]?.cells?.[tid];
      if (!base) {
        diffs.push(`${fid}/${tid}: new cell (no baseline)`);
        continue;
      }
      if (JSON.stringify(base.keptIds) !== JSON.stringify(cell.keptIds)) {
        diffs.push(`${fid}/${tid}: kept set changed`);
      }
    }
  }
  baselineDiff = diffs;
}

/* ── Report ───────────────────────────────────────────────────────────────── */
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(BENCH, "runs", stamp);
mkdirSync(runDir, { recursive: true });
writeFileSync(path.join(runDir, "results.json"), JSON.stringify({ results, gates }, null, 2));

const lines = [];
lines.push(`# Editorial benchmark — replay tier (${stamp})`);
lines.push("");
for (const [fid, r] of Object.entries(results)) {
  lines.push(`## ${fid} (${r.kind})`);
  lines.push("");
  lines.push(
    "| template | mode | live AI | zooms | cursor | cuts | speed | decor | spacing viol. | overlaps | clusters | disabled | inappropriate | quiet share |"
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [tid, c] of Object.entries(r.cells)) {
    const m = c.metrics;
    lines.push(
      `| ${tid} | ${c.mode} | ${m.totalLive} | ${m.zoomCount} | ${m.cursorEmphasisCount} | ${m.cutCount} | ${m.speedCount} | ${m.decorativeOverlayCount} | ${m.zoomSpacingViolations} | ${m.overlapEmphasisPairs} | ${m.clusters} | ${m.disabledCount} | ${m.inappropriate.total} | ${m.editFreeShare} |`
    );
  }
  lines.push("");
}
lines.push("## Acceptance gates (talking-head fixtures, Clean Professional vs Classic)");
lines.push("");
for (const g of gates) {
  lines.push(`- ${g.ok ? "✅" : "❌"} ${g.fixtureId} · ${g.name} (${g.detail})`);
}
if (baselineDiff) {
  lines.push("");
  lines.push(
    baselineDiff.length === 0
      ? "## Baseline: EXACT MATCH"
      : `## Baseline: ${baselineDiff.length} drift(s)\n${baselineDiff.map((d) => `- ${d}`).join("\n")}`
  );
}
writeFileSync(path.join(runDir, "report.md"), lines.join("\n"));

console.log(lines.join("\n"));
console.log(`\nWritten: bench/runs/${stamp}/`);
if (saveBaseline) console.log("Baseline saved: bench/baseline.json");
if (baselineDiff && baselineDiff.length > 0) {
  console.error("\nBASELINE DRIFT — investigate before merging.");
  process.exit(1);
}
if (gatesFailed.length > 0) {
  console.error(`\n${gatesFailed.length} ACCEPTANCE GATE(S) FAILED.`);
  process.exit(1);
}
