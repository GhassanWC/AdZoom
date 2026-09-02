/**
 * SINGLE POLICY OWNER — the structural guard for the Editorial Engine.
 *
 * Every editorial number (confidence bars, spacing, budgets, pacing tables,
 * quotas, minimums) is defined in src/lib/editorial/ and consumed through a
 * policy object. This test greps the engine sources so a constant can't
 * quietly move back — the drift it prevents is real: before Phase 1, zoom
 * spacing was 2.0s in the Gemini prompt, 2.5s in the Director planner and
 * 1.5s in the Director review, with nobody owning the number.
 *
 * DEFERRED ALLOWLIST (approved Phase-1 scope cut — migrate in Phase 4):
 *   • src/lib/director/planner.ts        — per-style budget tables
 *   • src/lib/director/editorial-judgment.ts — the Director's own bars
 *   • src/lib/director/gemini-planner.ts — prompt-embedded editorial prose
 * Each entry is asserted to STILL EXIST so the allowlist can't rot silently.
 *
 * Run with:  npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

test("the pacing + bias tables are defined ONLY in editorial/constants", () => {
  const constants = read("src/lib/editorial/constants.ts");
  assert.ok(constants.includes("PACING_PROFILES"), "canonical pacing table exists");
  assert.ok(constants.includes("VIDEO_TYPE_BIAS"), "canonical bias table exists");

  const balancer = read("src/lib/timeline-balancer.ts");
  assert.ok(
    balancer.includes('from "./editorial/constants"'),
    "balancer imports the tables"
  );
  assert.ok(
    !/ratePerMin:\s*\d/.test(balancer),
    "balancer must not define its own pacing numbers"
  );
  assert.ok(
    !/rateMult:\s*[\d.]/.test(balancer),
    "balancer must not define its own bias table"
  );

  const decision = read("src/lib/analysis/editorial-decision.ts");
  assert.ok(
    !/rateMult:\s*[\d.]/.test(decision),
    "the AI Editor must not carry a mirrored bias table"
  );
});

test("the AI Editor's bars come from the policy, not module literals", () => {
  const decision = read("src/lib/analysis/editorial-decision.ts");
  assert.ok(!decision.includes("MIN_CONFIDENCE = 0.35"), "confidence bar moved to policy");
  assert.ok(!decision.includes("CROWD_WINDOW_S = 2"), "crowd window moved to policy");
  assert.ok(!decision.includes("SAME_TYPE_STREAK_MAX = 3"), "streak cap moved to policy");
  assert.ok(!decision.includes("const MAX_MOMENTS = 24"), "global ceiling moved to policy");
  assert.ok(decision.includes("CLASSIC_DECISION"), "classic values are imported, not restated");
  assert.ok(decision.includes("policy.crowdWindowS"), "crowding reads the policy");
  assert.ok(decision.includes("policy.perType"), "per-type rules read the policy");
});

test("the overlay caps come from the policy, not slice literals", () => {
  const overlays = read("src/lib/analysis/overlay-generators.ts");
  assert.ok(overlays.includes("caps.textOverlayMax"));
  assert.ok(overlays.includes("caps.calloutMax"));
  assert.ok(overlays.includes("caps.calloutMinConfidence"));
  assert.ok(overlays.includes("caps.transitionMax"));
  assert.ok(!/\.slice\(0,\s*[345]\)/.test(overlays), "no hardcoded top-N slices remain");
});

test("the Director review's zoom backstop delegates to the shared Gate D pass", () => {
  const review = read("src/lib/director/review.ts");
  assert.ok(review.includes("zoomDensityPass"), "review delegates to the shared pass");
  assert.ok(review.includes("CLASSIC_ZOOM_COMPOSITION"), "its numbers come from constants");
  assert.ok(
    !/MIN_ZOOM_GAP_SECONDS = 1\.5/.test(review),
    "no local zoom-gap literal remains"
  );
  assert.ok(
    !/MAX_ZOOMS_PER_MINUTE = 10/.test(review),
    "no local zoom-budget literal remains"
  );
});

test("the balancer floor is a policy knob and the route passes it for enforce runs", () => {
  const balancer = read("src/lib/timeline-balancer.ts");
  assert.ok(balancer.includes("input.policy"), "the floor override exists");
  const route = read("src/app/api/projects/[id]/analyze/route.ts");
  assert.ok(route.includes("resolveEditorialPolicy"), "the route resolves ONE policy");
  assert.ok(route.includes("reviewComposition"), "the route runs Gate D");
  assert.ok(route.includes("policy: resolvedPolicy.decision"), "the AI Editor gets the policy");
  assert.ok(
    route.includes('(["camera", "cut", "speed"] as EngineLayer[])'),
    "the ranLayers cut/crop slip stays fixed"
  );
});

test("the deferred allowlist is explicit — and still real", () => {
  // These constants are ALLOWED to remain local until Phase 4. If one of these
  // assertions fails, the migration happened — delete the entry here and add
  // the file to the guards above instead of loosening anything.
  const planner = read("src/lib/director/planner.ts");
  assert.ok(
    /MIN_ZOOM_GAP\s*=/.test(planner),
    "planner zoom-gap still local (allowlisted; migrate in Phase 4)"
  );
  const judgment = read("src/lib/director/editorial-judgment.ts");
  assert.ok(
    /MIN_CONFIDENCE\s*=/.test(judgment),
    "director judgment bar still local (allowlisted; migrate in Phase 4)"
  );
});
