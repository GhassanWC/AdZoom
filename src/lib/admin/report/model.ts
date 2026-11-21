/**
 * The admin PDF report — data model and the PURE summarizer.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The admin can download one PDF that describes the whole app for a window:
 * users, growth, activation, projects, the AI-analysis pipeline, both export
 * pipelines, every recorded failure, client-reported failures and timings,
 * feature usage, billing, a day-by-day timeline, and the data-quality caveats.
 * It is written to be handed to an AI assistant (or a teammate) so it can say
 * what is broken and what to improve — hence the rule-based `findings` and
 * the plain-language "how to read this" preamble the PDF renders.
 *
 * THE ONE-SCAN RULE STILL APPLIES
 * -------------------------------
 * `collect.ts` reads each collection ONCE into the normalized row arrays of
 * `ReportInput`; every number below is derived from those arrays here. No
 * separate `.count()` sits next to a derived chart (except the explicitly
 * labelled `allTime` strip — the same contract as the Overview route).
 *
 * Pure: no Firestore, no Next. Tested in tests/admin-report.test.ts.
 */

import {
  tally,
  toSlices,
  countWhere,
  averageOf,
  medianOf,
  percentileOf,
  bucketByDay,
  percent,
  type Slice,
  type DayPoint,
} from "../aggregate";
import { dayKey } from "../serialize";
import { errorLabel, errorSignature } from "../errors";
import { isActiveStatus, PLAN_IDS, PLAN_MONTHLY_USD, type PlanId } from "../pricing";
import { NORMALIZED_EXPORT_STATUSES, type NormalizedExportStatus } from "../export-status";
import { deriveFindings, healthScore, type Finding } from "./findings";

// ── Normalized input rows (built by collect.ts) ─────────────────────────────

export interface ReportUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  plan: PlanId;
  createdAt: number;
  updatedAt: number;
}

export interface ReportProject {
  id: string;
  uid: string;
  title: string;
  status: string;
  analysisStatus: string | null;
  /** Source video length, seconds. */
  duration: number | null;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReportAnalysisJob {
  id: string;
  uid: string;
  projectId: string;
  projectTitle: string;
  status: string;
  engine: string;
  chunkMode: string;
  chunkCount: number;
  failedChunks: number;
  /** Whole-video length in seconds — NOT processing time. */
  videoSeconds: number;
  startedAt: number;
  completedAt: number | null;
  errorMessage: string | null;
}

export interface ReportExport {
  id: string;
  uid: string;
  pipeline: "browser" | "cloud";
  projectId: string;
  projectTitle: string;
  format: string;
  resolution: string;
  status: NormalizedExportStatus;
  rawStatus: string;
  stage: string | null;
  watermarked: boolean;
  fileSize: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  exportMinutes: number | null;
  plan: string | null;
  backend: string | null;
  createdAt: number;
  completedAt: number | null;
}

/** Scalar metadata only — free-form objects are dropped by collect.ts. */
export type EventMeta = Record<string, string | number | boolean>;

export interface ReportEvent {
  name: string;
  userId: string;
  plan: string | null;
  environment: string;
  projectId: string | null;
  timestamp: number;
  meta: EventMeta;
}

export interface ReportSubscription {
  uid: string;
  plan: PlanId;
  status: string;
  monthlyUsd: number;
  renewsAt: number | null;
  endsAt: number | null;
  lastPaymentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SourceScan {
  source: string;
  scanned: number;
  truncated: boolean;
  skipped: number;
}

export interface ReportInput {
  /** ALL users (unbounded — the account base is not range-scoped). */
  users: ReportUser[];
  /** Range-scoped. */
  projects: ReportProject[];
  analysisJobs: ReportAnalysisJob[];
  exports: ReportExport[];
  /** Range-scoped, ALL environments (the summarizer filters to production). */
  events: ReportEvent[];
  /** ALL subscriptions. */
  subscriptions: ReportSubscription[];
  allTime: { users: number | null; projects: number | null; exports: number | null };
  scans: SourceScan[];
  window: { fromMs: number; toMs: number; rangeKey: string };
  now: number;
  generatedBy: string;
  includeEmails: boolean;
}

// ── Output model ────────────────────────────────────────────────────────────

export interface Distribution {
  count: number;
  avg: number;
  median: number;
  p90: number;
  max: number;
}

export interface FailureGroup {
  signature: string;
  count: number;
  kind: string;
  affectedUsers: number;
  sampleMessage: string;
  lastSeenAt: number;
}

export interface FailureItem {
  at: number;
  kind: string;
  user: string;
  project: string;
  code: string | null;
  message: string;
  context: string;
}

export interface StuckItem {
  kind: string;
  id: string;
  user: string;
  title: string;
  status: string;
  ageMs: number;
}

export interface PipelineStats {
  pipeline: string;
  total: number;
  ready: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  failureRatePct: number;
  turnaroundMs: Distribution | null;
}

export interface Lifecycle {
  flow: string;
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** completed / (completed + failed), or null when nothing finished. */
  successRatePct: number | null;
  /** Started but neither completed, failed nor cancelled — abandoned/lost. */
  unaccounted: number;
}

export interface PerfMetric {
  event: string;
  field: string;
  unit: "ms" | "s" | "bytes" | "count";
  stats: Distribution;
}

export interface UserActivity {
  user: string;
  plan: string;
  signedUpAt: number;
  lastSeenAt: number;
  events: number;
  projects: number;
  analyses: number;
  exports: number;
  failures: number;
}

export interface FeatureAdoption {
  feature: string;
  users: number;
  events: number;
  pctOfActive: number;
}

export interface DailyRow {
  day: string;
  signups: number;
  projects: number;
  analysisJobs: number;
  exports: number;
  failures: number;
  events: number;
  activeUsers: number;
}

export interface AdminReport {
  meta: {
    app: string;
    generatedAt: number;
    generatedBy: string;
    window: { fromMs: number; toMs: number; rangeKey: string; label: string };
    includeEmails: boolean;
    reportVersion: number;
  };
  headline: {
    healthScore: number;
    totalUsers: number;
    newUsers: number;
    activeUsers: number;
    paidUsers: number;
    conversionPct: number;
    projects: number;
    analysisJobs: number;
    exports: number;
    exportSuccessPct: number | null;
    failures: number;
    stuckItems: number;
    listPriceMrr: number;
  };
  allTime: ReportInput["allTime"];
  users: {
    total: number;
    byPlan: Slice[];
    newInRange: number;
    activeInRange: number;
    returningActive: number;
    paid: number;
    conversionPct: number;
    paidWithoutActivity: number;
    signupsPerDay: DayPoint[];
    activation: {
      cohort: number;
      createdProject: number;
      analyzed: number;
      exported: number;
      createdProjectPct: number;
      analyzedPct: number;
      exportedPct: number;
    };
    topUsers: UserActivity[];
    usersWithFailures: UserActivity[];
  };
  projects: {
    inRange: number;
    byStatus: Slice[];
    byAnalysisStatus: Slice[];
    byMimeType: Slice[];
    durationSec: Distribution | null;
    fileSizeBytes: Distribution | null;
    totalBytes: number;
    neverAnalyzed: number;
    failed: number;
    statusExported: number;
    stuck: StuckItem[];
  };
  analysis: {
    inRange: number;
    byStatus: Slice[];
    failureRatePct: number | null;
    byEngine: Slice[];
    byChunkMode: Slice[];
    processingMs: Distribution | null;
    videoSeconds: Distribution | null;
    avgChunksPerJob: number | null;
    failedChunksTotal: number;
    stuck: StuckItem[];
    failureGroups: FailureGroup[];
  };
  exports: {
    inRange: number;
    byStatus: Slice[];
    pipelines: PipelineStats[];
    byFormat: Slice[];
    byResolution: Slice[];
    byRawStatus: Slice[];
    failedByStage: Slice[];
    byErrorCode: Slice[];
    watermarked: number;
    totalBytes: number;
    cloudMinutes: number;
    stuck: StuckItem[];
    failureGroups: FailureGroup[];
  };
  failures: {
    total: number;
    byKind: Slice[];
    affectedUsers: number;
    groups: FailureGroup[];
    recent: FailureItem[];
    perDay: DayPoint[];
  };
  clientSignals: {
    lifecycles: Lifecycle[];
    failureGroups: FailureGroup[];
    perf: PerfMetric[];
    unsupported: Slice[];
  };
  usage: {
    productionEvents: number;
    otherEnvironmentEvents: number;
    uniqueUsers: number;
    byEnvironment: Slice[];
    topEvents: Slice[];
    byPlan: Slice[];
    features: FeatureAdoption[];
    desktopFunnel: Slice[];
  };
  billing: {
    subscriptions: number;
    byStatus: Slice[];
    activeByPlan: Slice[];
    active: number;
    trialing: number;
    pastDue: number;
    cancelled: number;
    newInRange: number;
    listPriceMrr: number;
    listPriceArr: number;
    planMonthlyUsd: Record<string, number>;
    paidPlanUsers: number;
    entitlementGap: number;
    atRisk: { user: string; plan: string; status: string; renewsAt: number | null; endsAt: number | null }[];
  };
  daily: DailyRow[];
  dataQuality: {
    sources: SourceScan[];
    anyTruncated: boolean;
    skippedDocs: number;
    notes: string[];
  };
  findings: Finding[];
}

// ── Tunables ────────────────────────────────────────────────────────────────

/** Anything non-terminal for longer than this is reported as stuck. */
export const STUCK_AFTER_MS = 60 * 60_000;
const LIST_LIMIT = 40;

const PROJECT_IN_FLIGHT = new Set([
  "uploading",
  "scanning_frames",
  "preparing",
  "uploading_to_gemini",
  "extracting_frames",
  "analyzing",
  "generating_timeline",
  "generating_presets",
  "exporting",
]);
const ANALYZED_PROJECT_STATUSES = new Set(["analyzed", "completed", "exporting", "exported"]);
const ANALYSIS_JOB_STATUSES = ["queued", "running", "complete", "failed", "cancelled"];

/** Event-name prefixes that follow a started/completed/failed/cancelled lifecycle. */
const LIFECYCLE_FLOWS: { flow: string; prefix: string }[] = [
  { flow: "AI analysis", prefix: "analysis" },
  { flow: "Chunked analysis (>90s videos)", prefix: "chunked_analysis" },
  { flow: "Export (cloud/legacy pipeline)", prefix: "export" },
  { flow: "In-browser export (Editframe)", prefix: "editframe_export" },
  { flow: "Smart clip generation", prefix: "clips_generation" },
  { flow: "Caption transcription", prefix: "caption_transcription" },
  { flow: "Video upload", prefix: "video_upload" },
  { flow: "Recording", prefix: "recording" },
];

const FEATURES: { feature: string; events: string[] }[] = [
  { feature: "Upload a video", events: ["video_upload_completed", "video_upload_started"] },
  { feature: "Record in app", events: ["recording_started", "recording_completed"] },
  { feature: "Run AI analysis", events: ["analysis_started", "chunked_analysis_started"] },
  { feature: "Export a video", events: ["export_started", "editframe_export_started"] },
  { feature: "Download an export", events: ["export_downloaded"] },
  { feature: "Smart clips", events: ["clips_generate_clicked", "clips_generation_started"] },
  { feature: "AI Director pushback", events: ["director_pushback"] },
  { feature: "Upgrade / checkout", events: ["upgrade_clicked", "checkout_started"] },
  { feature: "Desktop app", events: ["desktop_app_opened"] },
];

const DESKTOP_FUNNEL = [
  "desktop_download_page_viewed",
  "desktop_download_clicked",
  "desktop_deep_link_attempted",
  "desktop_deep_link_failed",
  "desktop_gate_shown",
  "desktop_mobile_notice_shown",
  "desktop_app_installed",
  "desktop_app_opened",
  "desktop_deep_link_opened",
];

/** Metadata keys on a *_failed event that carry the failure reason, best first. */
const REASON_KEYS = ["code", "message", "reason", "kind", "stage", "error"];

// ── Small pure helpers ──────────────────────────────────────────────────────

export function distribution(values: readonly (number | null | undefined)[]): Distribution | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (xs.length === 0) return null;
  const id = (v: number) => v;
  return {
    count: xs.length,
    avg: averageOf(xs, id) ?? 0,
    median: medianOf(xs, id) ?? 0,
    p90: percentileOf(xs, id, 90) ?? 0,
    max: Math.max(...xs),
  };
}

/** "ghassan@gmail.com" → "gh***@gmail.com". Keeps the domain (useful signal). */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string" || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

function shortUid(uid: string): string {
  return uid ? `uid:${uid.slice(0, 8)}` : "unknown";
}

function windowLabel(w: ReportInput["window"]): string {
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if (!w.fromMs && !w.toMs) return "All time";
  const from = w.fromMs ? d(w.fromMs) : "beginning";
  const to = w.toMs ? d(w.toMs) : "now";
  const preset =
    w.rangeKey === "today" ? "Today" : w.rangeKey === "7d" ? "Last 7 days" : w.rangeKey === "30d" ? "Last 30 days" : "";
  return preset && !w.toMs ? `${preset} (${from} → ${to})` : `${from} → ${to}`;
}

function inWindow(ms: number, w: ReportInput["window"]): boolean {
  return ms > 0 && (!w.fromMs || ms >= w.fromMs) && (!w.toMs || ms <= w.toMs);
}

/** A scalar reason string from a failed event's metadata. */
export function eventReason(meta: EventMeta): string {
  for (const k of REASON_KEYS) {
    const v = meta[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "no reason recorded";
}

function groupFailures<T>(
  rows: readonly T[],
  sig: (r: T) => string,
  pick: (r: T) => { kind: string; uid: string; message: string; at: number },
  topN = 15
): FailureGroup[] {
  const groups = new Map<string, { count: number; users: Set<string>; kind: string; sample: string; last: number }>();
  for (const r of rows) {
    const key = sig(r);
    const info = pick(r);
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      if (info.uid) g.users.add(info.uid);
      if (info.at > g.last) {
        g.last = info.at;
        g.sample = info.message;
      }
    } else {
      groups.set(key, {
        count: 1,
        users: new Set(info.uid ? [info.uid] : []),
        kind: info.kind,
        sample: info.message,
        last: info.at,
      });
    }
  }
  return [...groups.entries()]
    .map(([signature, g]) => ({
      signature,
      count: g.count,
      kind: g.kind,
      affectedUsers: g.users.size,
      sampleMessage: g.sample,
      lastSeenAt: g.last,
    }))
    .sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt)
    .slice(0, topN);
}

function unitFor(field: string): PerfMetric["unit"] | null {
  if (/ms$/i.test(field)) return "ms";
  if (/(sec|seconds)$/i.test(field)) return "s";
  if (/bytes$/i.test(field)) return "bytes";
  if (/(count|chunks)$/i.test(field)) return "count";
  return null;
}

// ── The summarizer ──────────────────────────────────────────────────────────

export function buildAdminReport(input: ReportInput): AdminReport {
  const { window: w, now } = input;
  const userLabel = (uid: string, email?: string | null): string => {
    if (input.includeEmails && email) return email;
    return maskEmail(email) ?? shortUid(uid);
  };
  const emailByUid = new Map(input.users.map((u) => [u.uid, u.email]));
  const who = (uid: string) => userLabel(uid, emailByUid.get(uid));

  const prodEvents = input.events.filter((e) => e.environment === "production");

  // ── Users ────────────────────────────────────────────────────────────────
  const byPlanCounts = tally(input.users, (u) => u.plan, PLAN_IDS);
  const paid = byPlanCounts.pro + byPlanCounts.creator;
  const newUsers = input.users.filter((u) => inWindow(u.createdAt, w));
  const activeUids = new Set(prodEvents.map((e) => e.userId).filter(Boolean));
  const newUids = new Set(newUsers.map((u) => u.uid));
  const returningActive = [...activeUids].filter((uid) => !newUids.has(uid)).length;
  const paidWithoutActivity = countWhere(
    input.users,
    (u) => u.plan !== "free" && !activeUids.has(u.uid)
  );

  const projectUids = new Set(input.projects.map((p) => p.uid));
  const analyzedUids = new Set([
    ...input.projects
      .filter((p) => p.analysisStatus === "complete" || ANALYZED_PROJECT_STATUSES.has(p.status))
      .map((p) => p.uid),
    ...input.analysisJobs.filter((j) => j.status === "complete").map((j) => j.uid),
  ]);
  const exportedUids = new Set(input.exports.filter((e) => e.status === "ready").map((e) => e.uid));
  const cohort = newUsers.length;
  const createdProject = countWhere(newUsers, (u) => projectUids.has(u.uid));
  const analyzed = countWhere(newUsers, (u) => analyzedUids.has(u.uid));
  const exported = countWhere(newUsers, (u) => exportedUids.has(u.uid));

  // Per-user activity — "users performance".
  const activity = new Map<string, UserActivity>();
  const userByUid = new Map(input.users.map((u) => [u.uid, u]));
  const act = (uid: string): UserActivity | null => {
    if (!uid) return null;
    let a = activity.get(uid);
    if (!a) {
      const u = userByUid.get(uid);
      a = {
        user: who(uid),
        plan: u?.plan ?? "unknown",
        signedUpAt: u?.createdAt ?? 0,
        lastSeenAt: 0,
        events: 0,
        projects: 0,
        analyses: 0,
        exports: 0,
        failures: 0,
      };
      activity.set(uid, a);
    }
    return a;
  };
  for (const e of prodEvents) {
    const a = act(e.userId);
    if (!a) continue;
    a.events += 1;
    if (e.timestamp > a.lastSeenAt) a.lastSeenAt = e.timestamp;
  }
  for (const p of input.projects) {
    const a = act(p.uid);
    if (a) {
      a.projects += 1;
      if (p.status === "failed") a.failures += 1;
    }
  }
  for (const j of input.analysisJobs) {
    const a = act(j.uid);
    if (a) {
      a.analyses += 1;
      if (j.status === "failed") a.failures += 1;
    }
  }
  for (const x of input.exports) {
    const a = act(x.uid);
    if (a) {
      a.exports += 1;
      if (x.status === "failed") a.failures += 1;
    }
  }
  const activityRows = [...activity.values()];
  const topUsers = [...activityRows]
    .sort((a, b) => b.events + b.projects * 5 + b.exports * 5 - (a.events + a.projects * 5 + a.exports * 5))
    .slice(0, LIST_LIMIT);
  const usersWithFailures = activityRows
    .filter((a) => a.failures > 0)
    .sort((a, b) => b.failures - a.failures)
    .slice(0, LIST_LIMIT);

  // ── Projects ─────────────────────────────────────────────────────────────
  const projectStuck: StuckItem[] = input.projects
    .filter((p) => PROJECT_IN_FLIGHT.has(p.status) && now - (p.updatedAt || p.createdAt) > STUCK_AFTER_MS)
    .map((p) => ({
      kind: "project",
      id: p.id,
      user: who(p.uid),
      title: p.title,
      status: p.status,
      ageMs: now - (p.updatedAt || p.createdAt),
    }));

  // ── Analysis ─────────────────────────────────────────────────────────────
  const jobs = input.analysisJobs;
  const jobFinished = countWhere(jobs, (j) => j.status === "complete" || j.status === "failed");
  const jobFailed = jobs.filter((j) => j.status === "failed");
  const analysisStuck: StuckItem[] = jobs
    .filter((j) => (j.status === "running" || j.status === "queued") && now - j.startedAt > STUCK_AFTER_MS)
    .map((j) => ({
      kind: "analysis job",
      id: j.id,
      user: who(j.uid),
      title: j.projectTitle,
      status: j.status,
      ageMs: now - j.startedAt,
    }));
  const analysisFailureGroups = groupFailures(
    jobFailed,
    (j) => errorSignature(j.errorMessage),
    (j) => ({ kind: "analysis", uid: j.uid, message: j.errorMessage ?? "no message recorded", at: j.completedAt || j.startedAt })
  );

  // ── Exports ──────────────────────────────────────────────────────────────
  const xs = input.exports;
  const turnaround = (x: ReportExport) =>
    x.status === "ready" && x.completedAt && x.createdAt && x.completedAt > x.createdAt
      ? x.completedAt - x.createdAt
      : null;
  const pipelineStats = (name: string, rows: readonly ReportExport[]): PipelineStats => {
    const ready = countWhere(rows, (r) => r.status === "ready");
    const failed = countWhere(rows, (r) => r.status === "failed");
    return {
      pipeline: name,
      total: rows.length,
      ready,
      failed,
      cancelled: countWhere(rows, (r) => r.status === "cancelled"),
      inFlight: countWhere(rows, (r) => r.status === "queued" || r.status === "processing"),
      failureRatePct: percent(failed, ready + failed),
      turnaroundMs: distribution(rows.map(turnaround)),
    };
  };
  const exportFailed = xs.filter((x) => x.status === "failed");
  const exportStuck: StuckItem[] = xs
    .filter((x) => (x.status === "queued" || x.status === "processing") && now - x.createdAt > STUCK_AFTER_MS)
    .map((x) => ({
      kind: `${x.pipeline} export`,
      id: x.id,
      user: who(x.uid),
      title: x.projectTitle,
      status: x.stage ? `${x.rawStatus} / ${x.stage}` : x.rawStatus,
      ageMs: now - x.createdAt,
    }));
  const exportFailureGroups = groupFailures(
    exportFailed,
    (x) => errorLabel(x.errorCode, x.errorMessage),
    (x) => ({
      kind: `${x.pipeline} export`,
      uid: x.uid,
      message: x.errorMessage ?? "no message recorded",
      at: x.completedAt || x.createdAt,
    })
  );

  // ── Unified failures ─────────────────────────────────────────────────────
  const failureItems: (FailureItem & { uid: string; sig: string })[] = [
    ...jobFailed.map((j) => ({
      at: j.completedAt || j.startedAt,
      kind: "analysis",
      uid: j.uid,
      user: who(j.uid),
      project: j.projectTitle,
      code: null,
      message: j.errorMessage ?? "no message recorded",
      context: `engine=${j.engine} chunkMode=${j.chunkMode} failedChunks=${j.failedChunks}/${j.chunkCount} video=${Math.round(j.videoSeconds)}s`,
      sig: errorSignature(j.errorMessage),
    })),
    ...exportFailed.map((x) => ({
      at: x.completedAt || x.createdAt,
      kind: `${x.pipeline} export`,
      uid: x.uid,
      user: who(x.uid),
      project: x.projectTitle,
      code: x.errorCode,
      message: x.errorMessage ?? "no message recorded",
      context: [
        `format=${x.format}`,
        `res=${x.resolution}`,
        x.stage ? `stage=${x.stage}` : "",
        x.backend ? `backend=${x.backend}` : "",
        x.plan ? `plan=${x.plan}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      sig: errorLabel(x.errorCode, x.errorMessage),
    })),
    ...input.projects
      .filter((p) => p.status === "failed")
      .map((p) => ({
        at: p.updatedAt || p.createdAt,
        kind: "project",
        uid: p.uid,
        user: who(p.uid),
        project: p.title,
        code: null,
        message: `Project ended in status "failed" (analysis: ${p.analysisStatus ?? "not started"})`,
        context: `${p.mimeType ?? "unknown type"} ${p.duration ? `${Math.round(p.duration)}s` : ""}`.trim(),
        sig: "project status = failed",
      })),
  ].sort((a, b) => b.at - a.at);

  // ── Client signals (events) ──────────────────────────────────────────────
  const nameCounts = tally(prodEvents, (e) => e.name);
  const lifecycles: Lifecycle[] = LIFECYCLE_FLOWS.map(({ flow, prefix }) => {
    const started = nameCounts[`${prefix}_started`] ?? 0;
    const completed = nameCounts[`${prefix}_completed`] ?? 0;
    const failed = nameCounts[`${prefix}_failed`] ?? 0;
    const cancelled = nameCounts[`${prefix}_cancelled`] ?? 0;
    return {
      flow,
      started,
      completed,
      failed,
      cancelled,
      successRatePct: completed + failed > 0 ? percent(completed, completed + failed) : null,
      unaccounted: Math.max(0, started - completed - failed - cancelled),
    };
  }).filter((l) => l.started + l.completed + l.failed + l.cancelled > 0);

  const failedEvents = prodEvents.filter((e) => e.name.endsWith("_failed"));
  const clientFailureGroups = groupFailures(
    failedEvents,
    (e) => `${e.name}: ${errorSignature(eventReason(e.meta))}`,
    (e) => ({ kind: e.name, uid: e.userId, message: eventReason(e.meta), at: e.timestamp })
  );

  const perfBuckets = new Map<string, { event: string; field: string; unit: PerfMetric["unit"]; values: number[] }>();
  for (const e of prodEvents) {
    for (const [field, v] of Object.entries(e.meta)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const unit = unitFor(field);
      if (!unit) continue;
      const key = `${e.name}.${field}`;
      const b = perfBuckets.get(key) ?? { event: e.name, field, unit, values: [] };
      b.values.push(v);
      perfBuckets.set(key, b);
    }
  }
  const perf: PerfMetric[] = [...perfBuckets.values()]
    .map((b) => ({ event: b.event, field: b.field, unit: b.unit, stats: distribution(b.values)! }))
    .filter((m) => m.stats)
    .sort((a, b) => a.event.localeCompare(b.event) || a.field.localeCompare(b.field));

  const unsupported = toSlices(
    tally(
      prodEvents.filter((e) => e.name.includes("unsupported")),
      (e) => `${e.name}: ${eventReason(e.meta)}`
    ),
    { topN: 15, dropZero: true }
  );

  // ── Usage ────────────────────────────────────────────────────────────────
  const features: FeatureAdoption[] = FEATURES.map(({ feature, events }) => {
    const set = new Set(events);
    const rows = prodEvents.filter((e) => set.has(e.name));
    const users = new Set(rows.map((e) => e.userId).filter(Boolean)).size;
    return { feature, users, events: rows.length, pctOfActive: percent(users, activeUids.size) };
  });

  // ── Billing ──────────────────────────────────────────────────────────────
  const subs = input.subscriptions;
  const activeSubs = subs.filter((s) => isActiveStatus(s.status as never));
  const mrr = subs.reduce((sum, s) => sum + s.monthlyUsd, 0);
  const atRisk = subs
    .filter((s) => ["past_due", "unpaid", "paused"].includes(s.status) || (s.status === "cancelled" && (s.endsAt ?? 0) > now))
    .map((s) => ({ user: who(s.uid), plan: s.plan, status: s.status, renewsAt: s.renewsAt, endsAt: s.endsAt }))
    .slice(0, LIST_LIMIT);

  // ── Daily timeline ───────────────────────────────────────────────────────
  const span = { fromMs: w.fromMs, toMs: w.toMs || now };
  const signupsPerDay = bucketByDay(newUsers, (u) => u.createdAt, span);
  const daily = new Map<string, DailyRow>();
  const row = (day: string): DailyRow => {
    let r = daily.get(day);
    if (!r) {
      r = { day, signups: 0, projects: 0, analysisJobs: 0, exports: 0, failures: 0, events: 0, activeUsers: 0 };
      daily.set(day, r);
    }
    return r;
  };
  for (const p of signupsPerDay) row(p.day).signups = p.count;
  for (const p of input.projects) if (p.createdAt) row(dayKey(p.createdAt)).projects += 1;
  for (const j of jobs) if (j.startedAt) row(dayKey(j.startedAt)).analysisJobs += 1;
  for (const x of xs) if (x.createdAt) row(dayKey(x.createdAt)).exports += 1;
  for (const f of failureItems) if (f.at) row(dayKey(f.at)).failures += 1;
  const activeByDay = new Map<string, Set<string>>();
  for (const e of prodEvents) {
    if (!e.timestamp) continue;
    const k = dayKey(e.timestamp);
    row(k).events += 1;
    if (e.userId) {
      const s = activeByDay.get(k) ?? new Set<string>();
      s.add(e.userId);
      activeByDay.set(k, s);
    }
  }
  for (const [k, s] of activeByDay) row(k).activeUsers = s.size;
  const dailyRows = [...daily.values()].sort((a, b) => a.day.localeCompare(b.day));

  // ── Data quality ─────────────────────────────────────────────────────────
  const notes = [
    "analysisJobs documents exist ONLY for videos longer than 90s (chunked analysis). Shorter videos are analyzed in-place on the project document, so analysis-job counts undercount total analyses; project analysisStatus covers the rest.",
    "Exports come from two collections: users/{uid}/exports (in-browser renders) and users/{uid}/exportJobs (paid cloud renders). Statuses are normalized to queued/processing/ready/failed/cancelled.",
    "Revenue is LIST-PRICE MRR (plan price x subscriptions in a revenue status). Subscriptions store no charged amount, so discounts, taxes and refunds are not reflected. Trials are excluded.",
    "Client analytics events are filtered to environment = production. Some events (caption quota/transcription, page views) are sent to GA4 only and never reach this report.",
    "The generic 'error_occurred' event has no producer in the codebase, so uncaught client errors (JS exceptions, crashes) are NOT captured anywhere in this report.",
    `An item is reported as "stuck" when it has been in a non-terminal state for more than ${Math.round(STUCK_AFTER_MS / 60_000)} minutes.`,
    "Users and subscriptions are scanned all-time; projects, analysis jobs, exports and events are scoped to the report window.",
  ];
  if (!input.includeEmails) notes.push("User emails are masked (first two characters + domain); uids are truncated to 8 characters.");
  const dataQuality = {
    sources: input.scans,
    anyTruncated: input.scans.some((s) => s.truncated),
    skippedDocs: input.scans.reduce((sum, s) => sum + s.skipped, 0),
    notes,
  };

  const exportReady = countWhere(xs, (x) => x.status === "ready");
  const report: AdminReport = {
    meta: {
      app: "Framevo",
      generatedAt: now,
      generatedBy: input.generatedBy,
      window: { ...w, label: windowLabel(w) },
      includeEmails: input.includeEmails,
      reportVersion: 1,
    },
    headline: {
      healthScore: 100,
      totalUsers: input.users.length,
      newUsers: newUsers.length,
      activeUsers: activeUids.size,
      paidUsers: paid,
      conversionPct: percent(paid, input.users.length),
      projects: input.projects.length,
      analysisJobs: jobs.length,
      exports: xs.length,
      exportSuccessPct: exportReady + exportFailed.length > 0 ? percent(exportReady, exportReady + exportFailed.length) : null,
      failures: failureItems.length,
      stuckItems: projectStuck.length + analysisStuck.length + exportStuck.length,
      listPriceMrr: mrr,
    },
    allTime: input.allTime,
    users: {
      total: input.users.length,
      byPlan: toSlices(byPlanCounts),
      newInRange: newUsers.length,
      activeInRange: activeUids.size,
      returningActive,
      paid,
      conversionPct: percent(paid, input.users.length),
      paidWithoutActivity,
      signupsPerDay,
      activation: {
        cohort,
        createdProject,
        analyzed,
        exported,
        createdProjectPct: percent(createdProject, cohort),
        analyzedPct: percent(analyzed, cohort),
        exportedPct: percent(exported, cohort),
      },
      topUsers,
      usersWithFailures,
    },
    projects: {
      inRange: input.projects.length,
      byStatus: toSlices(tally(input.projects, (p) => p.status), { dropZero: true }),
      byAnalysisStatus: toSlices(tally(input.projects, (p) => p.analysisStatus ?? "not started"), { dropZero: true }),
      byMimeType: toSlices(tally(input.projects, (p) => p.mimeType ?? "unknown"), { topN: 10, dropZero: true }),
      durationSec: distribution(input.projects.map((p) => (p.duration && p.duration > 0 ? p.duration : null))),
      fileSizeBytes: distribution(input.projects.map((p) => (p.fileSize && p.fileSize > 0 ? p.fileSize : null))),
      totalBytes: input.projects.reduce((s, p) => s + (p.fileSize ?? 0), 0),
      neverAnalyzed: countWhere(
        input.projects,
        (p) => (p.analysisStatus == null || p.analysisStatus === "idle") && !ANALYZED_PROJECT_STATUSES.has(p.status)
      ),
      failed: countWhere(input.projects, (p) => p.status === "failed"),
      statusExported: countWhere(input.projects, (p) => p.status === "exported"),
      stuck: projectStuck.slice(0, LIST_LIMIT),
    },
    analysis: {
      inRange: jobs.length,
      byStatus: toSlices(tally(jobs, (j) => j.status, ANALYSIS_JOB_STATUSES)),
      failureRatePct: jobFinished > 0 ? percent(jobFailed.length, jobFinished) : null,
      byEngine: toSlices(tally(jobs, (j) => j.engine), { topN: 8, dropZero: true }),
      byChunkMode: toSlices(tally(jobs, (j) => j.chunkMode), { topN: 8, dropZero: true }),
      processingMs: distribution(
        jobs.map((j) =>
          j.status === "complete" && j.completedAt && j.completedAt > j.startedAt ? j.completedAt - j.startedAt : null
        )
      ),
      videoSeconds: distribution(jobs.map((j) => (j.videoSeconds > 0 ? j.videoSeconds : null))),
      avgChunksPerJob: averageOf(jobs, (j) => (j.chunkCount > 0 ? j.chunkCount : null)),
      failedChunksTotal: jobs.reduce((s, j) => s + j.failedChunks, 0),
      stuck: analysisStuck.slice(0, LIST_LIMIT),
      failureGroups: analysisFailureGroups,
    },
    exports: {
      inRange: xs.length,
      byStatus: toSlices(tally(xs, (x) => x.status, NORMALIZED_EXPORT_STATUSES)),
      pipelines: [
        pipelineStats("all", xs),
        pipelineStats("browser", xs.filter((x) => x.pipeline === "browser")),
        pipelineStats("cloud", xs.filter((x) => x.pipeline === "cloud")),
      ],
      byFormat: toSlices(tally(xs, (x) => x.format), { topN: 8, dropZero: true }),
      byResolution: toSlices(tally(xs, (x) => x.resolution), { topN: 8, dropZero: true }),
      byRawStatus: toSlices(tally(xs, (x) => `${x.pipeline}:${x.rawStatus}`), { dropZero: true }),
      failedByStage: toSlices(tally(exportFailed, (x) => x.stage ?? `${x.pipeline} (no stage)`), { dropZero: true }),
      byErrorCode: toSlices(tally(exportFailed, (x) => x.errorCode), { topN: 12, dropZero: true }),
      watermarked: countWhere(xs, (x) => x.watermarked),
      totalBytes: xs.reduce((s, x) => s + (x.fileSize ?? 0), 0),
      cloudMinutes: xs.reduce((s, x) => s + (x.pipeline === "cloud" ? x.exportMinutes ?? 0 : 0), 0),
      stuck: exportStuck.slice(0, LIST_LIMIT),
      failureGroups: exportFailureGroups,
    },
    failures: {
      total: failureItems.length,
      byKind: toSlices(tally(failureItems, (f) => f.kind), { dropZero: true }),
      affectedUsers: new Set(failureItems.map((f) => f.uid).filter(Boolean)).size,
      groups: groupFailures(
        failureItems,
        (f) => f.sig,
        (f) => ({ kind: f.kind, uid: f.uid, message: f.message, at: f.at }),
        20
      ),
      recent: failureItems.slice(0, 60).map(({ uid: _uid, sig: _sig, ...rest }) => rest),
      perDay: bucketByDay(failureItems, (f) => f.at, span),
    },
    clientSignals: { lifecycles, failureGroups: clientFailureGroups, perf, unsupported },
    usage: {
      productionEvents: prodEvents.length,
      otherEnvironmentEvents: input.events.length - prodEvents.length,
      uniqueUsers: activeUids.size,
      byEnvironment: toSlices(tally(input.events, (e) => e.environment), { dropZero: true }),
      topEvents: toSlices(nameCounts, { topN: 40, dropZero: true }),
      byPlan: toSlices(tally(prodEvents, (e) => e.plan ?? "unknown"), { dropZero: true }),
      features,
      desktopFunnel: DESKTOP_FUNNEL.map((label) => ({ label, value: nameCounts[label] ?? 0 })),
    },
    billing: {
      subscriptions: subs.length,
      byStatus: toSlices(tally(subs, (s) => s.status), { dropZero: true }),
      activeByPlan: toSlices(tally(activeSubs, (s) => s.plan), { dropZero: true }),
      active: activeSubs.length,
      trialing: countWhere(subs, (s) => s.status === "on_trial"),
      pastDue: countWhere(subs, (s) => s.status === "past_due"),
      cancelled: countWhere(subs, (s) => s.status === "cancelled"),
      newInRange: countWhere(subs, (s) => inWindow(s.createdAt, w)),
      listPriceMrr: mrr,
      listPriceArr: mrr * 12,
      planMonthlyUsd: { ...PLAN_MONTHLY_USD },
      paidPlanUsers: paid,
      entitlementGap: paid - activeSubs.length,
      atRisk,
    },
    daily: dailyRows,
    dataQuality,
    findings: [],
  };

  report.findings = deriveFindings(report);
  report.headline.healthScore = healthScore(report.findings);
  return report;
}
