/**
 * Rule-based findings for the admin PDF report: "what is broken, what is
 * slow, what to improve", each with the evidence that triggered it and a
 * concrete recommendation.
 *
 * Deliberately deterministic (no LLM call): the report is meant to be handed
 * TO an AI, and a finding the admin can't trace back to a number is noise.
 * Every rule reads only the already-derived `AdminReport`, so a finding can
 * never disagree with the table it cites. Thresholds are named constants so
 * the rationale is reviewable. Pure — tested in tests/admin-report.test.ts.
 */

import type { AdminReport } from "./model";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  severity: Severity;
  area: string;
  title: string;
  evidence: string;
  recommendation: string;
}

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low", "info"];

const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 25,
  high: 12,
  medium: 5,
  low: 2,
  info: 0,
};

/** Failure-rate thresholds (percent of finished jobs). */
const FAIL_HIGH_PCT = 10;
const FAIL_CRITICAL_PCT = 25;
/** Minimum finished jobs before a failure RATE is meaningful. */
const MIN_SAMPLE = 5;
/** p90 latency thresholds. */
const SLOW_EXPORT_P90_MS = 10 * 60_000;
const SLOW_ANALYSIS_P90_MS = 10 * 60_000;
/** Activation: share of new users who never created a project. */
const LOW_ACTIVATION_PCT = 50;
const LOW_CONVERSION_PCT = 2;

const mins = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;
const pct = (n: number) => `${n}%`;

function rateSeverity(ratePct: number): Severity {
  return ratePct >= FAIL_CRITICAL_PCT ? "critical" : ratePct >= FAIL_HIGH_PCT ? "high" : "medium";
}

/** 0–100, where each finding subtracts by severity. A rough triage signal. */
export function healthScore(findings: readonly Finding[]): number {
  const penalty = findings.reduce((s, f) => s + SEVERITY_PENALTY[f.severity], 0);
  return Math.max(0, 100 - penalty);
}

export function deriveFindings(r: AdminReport): Finding[] {
  const out: Finding[] = [];
  const add = (f: Finding) => out.push(f);

  // ── Export reliability ────────────────────────────────────────────────────
  for (const p of r.exports.pipelines) {
    if (p.pipeline === "all") continue;
    const finished = p.ready + p.failed;
    if (finished >= MIN_SAMPLE && p.failureRatePct >= 5) {
      const top = r.exports.failureGroups.find((g) => g.kind === `${p.pipeline} export`);
      add({
        severity: rateSeverity(p.failureRatePct),
        area: "Exports",
        title: `${p.pipeline} export failure rate is ${pct(p.failureRatePct)}`,
        evidence: `${p.failed} of ${finished} finished ${p.pipeline} exports failed.${
          top ? ` Most common: "${top.signature}" (${top.count}x, ${top.affectedUsers} users).` : ""
        }`,
        recommendation:
          "Fix the top failure signature first (see the Exports > failure groups table); add a regression test for that input, and confirm the automatic backup path covers it.",
      });
    }
    if (p.turnaroundMs && p.turnaroundMs.count >= MIN_SAMPLE && p.turnaroundMs.p90 > SLOW_EXPORT_P90_MS) {
      add({
        severity: "medium",
        area: "Performance",
        title: `Slow ${p.pipeline} exports (p90 ${mins(p.turnaroundMs.p90)})`,
        evidence: `Median ${mins(p.turnaroundMs.median)}, p90 ${mins(p.turnaroundMs.p90)}, max ${mins(p.turnaroundMs.max)} over ${p.turnaroundMs.count} ready exports (turnaround = queue + render).`,
        recommendation:
          "Separate queue time from render time in the job record, then check worker concurrency/capacity and render settings for the slowest jobs.",
      });
    }
  }

  if (r.exports.stuck.length > 0) {
    add({
      severity: r.exports.stuck.length >= 5 ? "high" : "medium",
      area: "Exports",
      title: `${r.exports.stuck.length} export(s) stuck in a non-terminal state`,
      evidence: `Queued/processing for over an hour: ${r.exports.stuck
        .slice(0, 5)
        .map((s) => `${s.kind} "${s.status}"`)
        .join(", ")}.`,
      recommendation:
        "Add a reconcile sweep that times out abandoned jobs (mark failed with a stage) so users get feedback and quotas are released.",
    });
  }

  // ── Analysis reliability ─────────────────────────────────────────────────
  const a = r.analysis;
  const aFinished = a.byStatus
    .filter((s) => s.label === "complete" || s.label === "failed")
    .reduce((s, x) => s + x.value, 0);
  if (a.failureRatePct != null && aFinished >= MIN_SAMPLE && a.failureRatePct >= 5) {
    const top = a.failureGroups[0];
    add({
      severity: rateSeverity(a.failureRatePct),
      area: "AI analysis",
      title: `Chunked analysis failure rate is ${pct(a.failureRatePct)}`,
      evidence: `${pct(a.failureRatePct)} of ${aFinished} finished analysis jobs failed.${
        top ? ` Top cause: "${top.signature}" (${top.count}x).` : ""
      }`,
      recommendation: "Inspect the top analysis failure signature; add retry/backoff for transient model/API errors per chunk.",
    });
  }
  if (a.stuck.length > 0) {
    add({
      severity: a.stuck.length >= 3 ? "high" : "medium",
      area: "AI analysis",
      title: `${a.stuck.length} analysis job(s) stuck running/queued`,
      evidence: `Jobs started more than an hour ago without finishing (oldest ${mins(
        Math.max(...a.stuck.map((s) => s.ageMs))
      )}).`,
      recommendation:
        "The orchestrator is client-side: a closed tab abandons the job. Add a heartbeat + server-side timeout that marks abandoned jobs failed or cancelled, and let users resume.",
    });
  }
  if (a.processingMs && a.processingMs.count >= MIN_SAMPLE && a.processingMs.p90 > SLOW_ANALYSIS_P90_MS) {
    add({
      severity: "medium",
      area: "Performance",
      title: `Slow analysis (p90 ${mins(a.processingMs.p90)})`,
      evidence: `Median ${mins(a.processingMs.median)}, p90 ${mins(a.processingMs.p90)} over ${a.processingMs.count} completed jobs; average source video ${
        a.videoSeconds ? `${Math.round(a.videoSeconds.avg)}s` : "unknown"
      }.`,
      recommendation: "Increase chunk parallelism or reduce frames sent per chunk; show users an ETA based on video length.",
    });
  }
  if (a.failedChunksTotal > 0) {
    add({
      severity: "low",
      area: "AI analysis",
      title: `${a.failedChunksTotal} failed analysis chunk(s)`,
      evidence: "Individual chunks failed inside otherwise-running jobs; those parts of the video got no AI edits.",
      recommendation: "Retry failed chunks automatically and surface partial-analysis state in the editor.",
    });
  }

  // ── Projects ─────────────────────────────────────────────────────────────
  const pr = r.projects;
  if (pr.stuck.length > 0) {
    add({
      severity: pr.stuck.length >= 5 ? "high" : "medium",
      area: "Projects",
      title: `${pr.stuck.length} project(s) stuck mid-pipeline`,
      evidence: `In-flight statuses for over an hour: ${[...new Set(pr.stuck.map((s) => s.status))].join(", ")}.`,
      recommendation: "Time out in-flight project statuses and move them to a recoverable state with a retry action.",
    });
  }
  if (pr.inRange >= MIN_SAMPLE && pr.neverAnalyzed / pr.inRange >= 0.4) {
    add({
      severity: "medium",
      area: "Activation",
      title: `${Math.round((pr.neverAnalyzed / pr.inRange) * 100)}% of new projects were never analyzed`,
      evidence: `${pr.neverAnalyzed} of ${pr.inRange} projects in range never reached analysis.`,
      recommendation: "Auto-start analysis after upload (or make the call-to-action unmissable) and check for upload drop-off.",
    });
  }
  const readyExports = r.exports.pipelines.find((p) => p.pipeline === "all")?.ready ?? 0;
  if (readyExports > 0 && pr.statusExported === 0) {
    add({
      severity: "low",
      area: "Data consistency",
      title: 'Projects never reach status "exported"',
      evidence: `${readyExports} exports finished in range but 0 projects have status "exported".`,
      recommendation:
        "Either update the project status when an export completes, or stop showing \"exported\" counts derived from project status (the Overview card currently reads 0).",
    });
  }

  // ── Failures overall ─────────────────────────────────────────────────────
  const topGroup = r.failures.groups[0];
  if (topGroup && topGroup.count >= 3) {
    add({
      severity: topGroup.affectedUsers >= 3 ? "high" : "medium",
      area: "Errors",
      title: `Most frequent failure: ${topGroup.signature}`,
      evidence: `${topGroup.count} occurrences (${topGroup.kind}), ${topGroup.affectedUsers} users affected. Sample: "${topGroup.sampleMessage.slice(0, 180)}".`,
      recommendation: "Reproduce with an affected project and fix the root cause; this single fix removes the largest share of failures.",
    });
  }

  // ── Client signals ───────────────────────────────────────────────────────
  for (const l of r.clientSignals.lifecycles) {
    const finished = l.completed + l.failed;
    if (finished >= MIN_SAMPLE && l.successRatePct != null && l.successRatePct < 90) {
      add({
        severity: rateSeverity(100 - l.successRatePct),
        area: "Client reliability",
        title: `${l.flow}: ${pct(l.successRatePct)} success reported by clients`,
        evidence: `${l.started} started, ${l.completed} completed, ${l.failed} failed, ${l.cancelled} cancelled.`,
        recommendation: "See 'Client-reported failure reasons' for the dominant reason and fix it.",
      });
    }
    if (l.started >= MIN_SAMPLE && l.unaccounted / l.started >= 0.25) {
      add({
        severity: "medium",
        area: "Client reliability",
        title: `${l.flow}: ${l.unaccounted} of ${l.started} runs never reported an outcome`,
        evidence: "Started events without a matching completed/failed/cancelled event — users likely closed the tab, or the flow crashed silently.",
        recommendation: "Emit a terminal event on every exit path (including unload) and add client error capture (error_occurred has no producer today).",
      });
    }
  }
  const unsupportedTotal = r.clientSignals.unsupported.reduce((s, x) => s + x.value, 0);
  if (unsupportedTotal > 0) {
    add({
      severity: unsupportedTotal >= 10 ? "medium" : "low",
      area: "Compatibility",
      title: `${unsupportedTotal} 'unsupported' events (browser or edit not supported)`,
      evidence: r.clientSignals.unsupported
        .slice(0, 4)
        .map((s) => `${s.label} (${s.value})`)
        .join("; "),
      recommendation: "Close the most common gap or route those users to the cloud/desktop path automatically.",
    });
  }

  // ── Growth & activation ──────────────────────────────────────────────────
  const act = r.users.activation;
  if (act.cohort >= MIN_SAMPLE && act.createdProjectPct < LOW_ACTIVATION_PCT) {
    add({
      severity: "high",
      area: "Activation",
      title: `Only ${pct(act.createdProjectPct)} of new users created a project`,
      evidence: `Of ${act.cohort} sign-ups in range: ${act.createdProject} created a project, ${act.analyzed} got an AI analysis, ${act.exported} exported a video.`,
      recommendation:
        "Shorten time-to-first-project: a sample project, record/upload straight from onboarding, and a reminder email for sign-ups with no project.",
    });
  } else if (act.createdProject >= MIN_SAMPLE && act.exportedPct < act.createdProjectPct / 3) {
    add({
      severity: "medium",
      area: "Activation",
      title: "Users create projects but rarely export",
      evidence: `${act.createdProjectPct}% of new users created a project but only ${act.exportedPct}% exported.`,
      recommendation: "Find the drop between editor and export (analysis wait? export failures? paywall?) using the funnel and failure sections.",
    });
  }
  if (r.users.total >= 50 && r.users.conversionPct < LOW_CONVERSION_PCT) {
    add({
      severity: "medium",
      area: "Revenue",
      title: `Low paid conversion (${pct(r.users.conversionPct)})`,
      evidence: `${r.users.paid} paid of ${r.users.total} users.`,
      recommendation: "Review the upgrade moments (export limits, watermark, caption minutes) and the pricing page funnel (upgrade_clicked -> checkout_started -> checkout_completed).",
    });
  }
  if (r.users.paidWithoutActivity > 0 && r.users.paid > 0) {
    add({
      severity: "low",
      area: "Retention",
      title: `${r.users.paidWithoutActivity} paid user(s) had no activity in range`,
      evidence: "Paid plan, but no production analytics event in the report window — churn risk.",
      recommendation: "Re-engagement email or in-app nudge for inactive paying users.",
    });
  }

  // ── Billing ──────────────────────────────────────────────────────────────
  const b = r.billing;
  if (b.pastDue > 0) {
    add({
      severity: "medium",
      area: "Revenue",
      title: `${b.pastDue} subscription(s) past due`,
      evidence: "Payment failed; access is still granted during the dunning window.",
      recommendation: "Verify dunning emails are sent and the billing page shows a clear 'update payment method' action.",
    });
  }
  if (b.entitlementGap !== 0) {
    add({
      severity: "low",
      area: "Data consistency",
      title: "Paid-plan users and active subscriptions disagree",
      evidence: `${b.paidPlanUsers} users have a paid plan on their user doc, but ${b.active} subscriptions grant access (gap ${b.entitlementGap}).`,
      recommendation:
        "Check for manual/comp grants, missed cancellation webhooks, or downgrades not written back to users.plan; reconcile from the billing provider.",
    });
  }

  // ── Data quality ─────────────────────────────────────────────────────────
  if (r.dataQuality.anyTruncated) {
    add({
      severity: "info",
      area: "Data quality",
      title: "Some sources hit the scan cap",
      evidence: r.dataQuality.sources
        .filter((s) => s.truncated)
        .map((s) => `${s.source} (${s.scanned} docs)`)
        .join(", "),
      recommendation: "Totals for these sources are floors. Narrow the date range for exact numbers.",
    });
  }
  if (r.dataQuality.skippedDocs > 0) {
    add({
      severity: "low",
      area: "Data quality",
      title: `${r.dataQuality.skippedDocs} malformed document(s) skipped`,
      evidence: "Documents that could not be parsed were dropped from every count.",
      recommendation: "Check server logs for [admin/validate] lines to find the schema drift.",
    });
  }
  if (r.usage.otherEnvironmentEvents > r.usage.productionEvents && r.usage.otherEnvironmentEvents > 0) {
    add({
      severity: "info",
      area: "Data quality",
      title: "More non-production than production analytics events",
      evidence: `${r.usage.otherEnvironmentEvents} non-production vs ${r.usage.productionEvents} production events in the analytics collection.`,
      recommendation: "Point development builds at the dev Firebase project so test traffic never lands in production analytics.",
    });
  }
  add({
    severity: "info",
    area: "Observability",
    title: "Uncaught client errors are not captured",
    evidence: "The 'error_occurred' event is declared but has no producer; JS exceptions and crashes never reach this report.",
    recommendation: "Add a global error/unhandledrejection handler (or an error-tracking service) that records error_occurred with a stack signature.",
  });

  return out.sort(
    (x, y) => SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity)
  );
}
