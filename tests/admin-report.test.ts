/**
 * The admin PDF report: the pure summarizer, the findings rules, privacy
 * masking, and an end-to-end render to real PDF bytes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString } from "pdf-lib";

import {
  buildAdminReport,
  maskEmail,
  distribution,
  eventReason,
  STUCK_AFTER_MS,
  type ReportInput,
  type ReportExport,
} from "../src/lib/admin/report/model.ts";
import { healthScore, type Finding } from "../src/lib/admin/report/findings.ts";
import { renderAdminReportPdf, pdfSafe, fmtDuration, fmtBytes } from "../src/lib/admin/report/pdf.ts";
import { percentileOf } from "../src/lib/admin/aggregate.ts";

const NOW = Date.UTC(2026, 10, 21, 12);
const DAY = 86_400_000;
const FROM = NOW - 30 * DAY;

function exp(over: Partial<ReportExport>): ReportExport {
  return {
    id: Math.random().toString(36).slice(2),
    uid: "u1",
    pipeline: "browser",
    projectId: "p1",
    projectTitle: "Demo",
    format: "mp4",
    resolution: "1080p",
    status: "ready",
    rawStatus: "ready",
    stage: null,
    watermarked: false,
    fileSize: 1000,
    errorMessage: null,
    errorCode: null,
    exportMinutes: null,
    plan: null,
    backend: null,
    createdAt: NOW - 2 * DAY,
    completedAt: NOW - 2 * DAY + 60_000,
    ...over,
  };
}

function fixture(over: Partial<ReportInput> = {}): ReportInput {
  return {
    users: [
      { uid: "u1", email: "alice@example.com", displayName: "Alice", plan: "pro", createdAt: NOW - 3 * DAY, updatedAt: NOW },
      { uid: "u2", email: "bob@example.com", displayName: null, plan: "free", createdAt: NOW - 4 * DAY, updatedAt: NOW },
      { uid: "u3", email: null, displayName: null, plan: "free", createdAt: NOW - 400 * DAY, updatedAt: NOW },
      { uid: "u4", email: "dana@example.com", displayName: null, plan: "creator", createdAt: NOW - 5 * DAY, updatedAt: NOW },
    ],
    projects: [
      { id: "p1", uid: "u1", title: "مشروع تجريبي", status: "analyzed", analysisStatus: "complete", duration: 120, fileSize: 5e6, mimeType: "video/mp4", createdAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY },
      { id: "p2", uid: "u2", title: "Stuck one", status: "analyzing", analysisStatus: "analyzing", duration: 30, fileSize: 1e6, mimeType: "video/webm", createdAt: NOW - 3 * DAY, updatedAt: NOW - STUCK_AFTER_MS - 1 },
      { id: "p3", uid: "u1", title: "Fresh", status: "uploaded", analysisStatus: null, duration: null, fileSize: null, mimeType: null, createdAt: NOW - DAY, updatedAt: NOW - DAY },
    ],
    analysisJobs: [
      { id: "j1", uid: "u1", projectId: "p1", projectTitle: "A", status: "complete", engine: "gemini", chunkMode: "auto", chunkCount: 3, failedChunks: 0, videoSeconds: 120, startedAt: NOW - 2 * DAY, completedAt: NOW - 2 * DAY + 90_000, errorMessage: null },
      { id: "j2", uid: "u2", projectId: "p2", projectTitle: "B", status: "failed", engine: "gemini", chunkMode: "auto", chunkCount: 4, failedChunks: 2, videoSeconds: 300, startedAt: NOW - DAY, completedAt: NOW - DAY + 1000, errorMessage: "Quota exceeded for job 8f2a11ee8f2a11ee" },
      { id: "j3", uid: "u2", projectId: "p2", projectTitle: "B", status: "running", engine: "gemini", chunkMode: "auto", chunkCount: 4, failedChunks: 0, videoSeconds: 300, startedAt: NOW - 3 * STUCK_AFTER_MS, completedAt: null, errorMessage: null },
    ],
    exports: [
      exp({}),
      exp({ uid: "u2" }),
      exp({ status: "failed", rawStatus: "failed", errorMessage: "Decoder error at 00:03:12", completedAt: NOW - DAY }),
      exp({ pipeline: "cloud", status: "failed", rawStatus: "failed", errorCode: "audio_missing_after_render", stage: "audiomux", uid: "u4" }),
      exp({ pipeline: "cloud", status: "processing", rawStatus: "rendering", createdAt: NOW - 2 * STUCK_AFTER_MS, completedAt: null, exportMinutes: 2.5 }),
    ],
    events: [
      { name: "export_started", userId: "u1", plan: "pro", environment: "production", projectId: "p1", timestamp: NOW - DAY, meta: {} },
      { name: "editframe_export_failed", userId: "u1", plan: "pro", environment: "production", projectId: "p1", timestamp: NOW - DAY, meta: { reason: "VideoEncoder not supported" } },
      { name: "editframe_export_completed", userId: "u2", plan: "free", environment: "production", projectId: "p2", timestamp: NOW - DAY, meta: { renderDurationMs: 42_000, bytes: 9_000_000 } },
      { name: "sign_up", userId: "u4", plan: "free", environment: "development", projectId: null, timestamp: NOW - DAY, meta: {} },
    ],
    subscriptions: [
      { uid: "u1", plan: "pro", status: "active", monthlyUsd: 25, renewsAt: NOW + 10 * DAY, endsAt: null, lastPaymentAt: NOW - 20 * DAY, createdAt: NOW - 3 * DAY, updatedAt: NOW },
      { uid: "u4", plan: "creator", status: "past_due", monthlyUsd: 50, renewsAt: null, endsAt: null, lastPaymentAt: null, createdAt: NOW - 60 * DAY, updatedAt: NOW },
    ],
    allTime: { users: 4, projects: 3, exports: 5 },
    scans: [{ source: "users", scanned: 4, truncated: false, skipped: 0 }],
    window: { fromMs: FROM, toMs: 0, rangeKey: "30d" },
    now: NOW,
    generatedBy: "admin@example.com",
    includeEmails: false,
    ...over,
  };
}

test("summarizer: headline numbers derive from the same arrays as the sections", () => {
  const r = buildAdminReport(fixture());
  assert.equal(r.headline.totalUsers, 4);
  assert.equal(r.headline.newUsers, 3, "u3 signed up before the window");
  assert.equal(r.headline.paidUsers, 2);
  assert.equal(r.headline.exports, r.exports.inRange);
  assert.equal(
    r.exports.byStatus.reduce((s, x) => s + x.value, 0),
    r.exports.inRange,
    "status slices sum to the window total"
  );
  const all = r.exports.pipelines.find((p) => p.pipeline === "all")!;
  const browser = r.exports.pipelines.find((p) => p.pipeline === "browser")!;
  const cloud = r.exports.pipelines.find((p) => p.pipeline === "cloud")!;
  assert.equal(all.total, browser.total + cloud.total);
  assert.equal(all.failed, 2);
  assert.equal(r.exports.cloudMinutes, 2.5);
  // Failures = 1 analysis + 2 exports (no failed projects in fixture).
  assert.equal(r.failures.total, 3);
  assert.equal(r.headline.failures, r.failures.total);
  assert.equal(r.failures.recent.length, 3);
  // Daily failures sum to the total.
  assert.equal(r.daily.reduce((s, d) => s + d.failures, 0), r.failures.total);
});

test("summarizer: stuck detection covers projects, analysis jobs and exports", () => {
  const r = buildAdminReport(fixture());
  assert.deepEqual(r.projects.stuck.map((s) => s.id), ["p2"]);
  assert.deepEqual(r.analysis.stuck.map((s) => s.id), ["j3"]);
  assert.equal(r.exports.stuck.length, 1);
  assert.match(r.exports.stuck[0].status, /rendering/);
  assert.equal(r.headline.stuckItems, 3);
});

test("summarizer: activation funnel counts only the window's sign-ups", () => {
  const r = buildAdminReport(fixture());
  const a = r.users.activation;
  assert.equal(a.cohort, 3);
  assert.equal(a.createdProject, 2, "u1 and u2 have projects; u4 does not");
  assert.equal(a.analyzed, 1, "only u1 has a completed analysis");
  assert.equal(a.exported, 2, "u1 and u2 have ready exports");
});

test("summarizer: production-only events, lifecycles and client perf", () => {
  const r = buildAdminReport(fixture());
  assert.equal(r.usage.productionEvents, 3);
  assert.equal(r.usage.otherEnvironmentEvents, 1);
  const ef = r.clientSignals.lifecycles.find((l) => l.flow.includes("Editframe"))!;
  assert.equal(ef.completed, 1);
  assert.equal(ef.failed, 1);
  assert.equal(ef.successRatePct, 50);
  assert.ok(r.clientSignals.failureGroups[0].signature.startsWith("editframe_export_failed"));
  const perf = r.clientSignals.perf.find((m) => m.field === "renderDurationMs")!;
  assert.equal(perf.unit, "ms");
  assert.equal(perf.stats.median, 42_000);
});

test("privacy: emails are masked unless explicitly included", () => {
  const masked = buildAdminReport(fixture());
  const json = JSON.stringify(masked);
  assert.ok(!json.includes("alice@example.com"), "full email must not leak");
  assert.ok(json.includes("al***@example.com"));
  const full = buildAdminReport(fixture({ includeEmails: true }));
  assert.ok(JSON.stringify(full.users.topUsers).includes("alice@example.com"));
  assert.equal(maskEmail("ghassan@gmail.com"), "gh***@gmail.com");
  assert.equal(maskEmail("not-an-email"), null);
});

test("findings: rules fire on the evidence and sort by severity", () => {
  const r = buildAdminReport(fixture());
  const titles = r.findings.map((f) => f.title);
  assert.ok(titles.some((t) => /stuck/i.test(t)), "stuck items produce a finding");
  assert.ok(titles.some((t) => /past due/i.test(t)), "past_due produces a finding");
  assert.ok(titles.some((t) => /failed analysis chunk/i.test(t)));
  const order = ["critical", "high", "medium", "low", "info"];
  for (let i = 1; i < r.findings.length; i++) {
    assert.ok(order.indexOf(r.findings[i - 1].severity) <= order.indexOf(r.findings[i].severity));
  }
  assert.equal(r.headline.healthScore, healthScore(r.findings));
});

test("findings: a paid plan without a subscription is an entitlement gap", () => {
  const base = fixture();
  // past_due still grants access, so the base fixture has NO gap (2 paid, 2 granting).
  assert.equal(buildAdminReport(base).billing.entitlementGap, 0);
  const users = base.users.map((u) => (u.uid === "u2" ? { ...u, plan: "pro" as const } : u));
  const r = buildAdminReport(fixture({ users }));
  assert.equal(r.billing.entitlementGap, 1);
  assert.ok(r.findings.some((f) => /disagree/i.test(f.title)));
});

test("findings: export failure-rate rule needs a minimum sample", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    exp({ status: i < 4 ? "failed" : "ready", rawStatus: i < 4 ? "failed" : "ready", errorMessage: i < 4 ? "boom" : null })
  );
  const r = buildAdminReport(fixture({ exports: many }));
  const f = r.findings.find((x) => /browser export failure rate/.test(x.title));
  assert.ok(f, "40% failure over 10 exports must be reported");
  assert.equal(f!.severity, "critical");
  const few = buildAdminReport(fixture({ exports: many.slice(0, 2) }));
  assert.ok(!few.findings.some((x) => /export failure rate/.test(x.title)), "2 samples is not a rate");
});

test("healthScore floors at 0", () => {
  const f: Finding = { severity: "critical", area: "x", title: "x", evidence: "x", recommendation: "x" };
  assert.equal(healthScore([f, f, f, f, f]), 0);
  assert.equal(healthScore([]), 100);
});

test("helpers: percentile, distribution, reasons, formatting", () => {
  assert.equal(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], (v) => v, 90), 9);
  assert.equal(percentileOf([], (v: number) => v, 90), null);
  assert.equal(distribution([null, undefined]), null);
  assert.deepEqual(distribution([2, 4]), { count: 2, avg: 3, median: 3, p90: 4, max: 4 });
  assert.equal(eventReason({ code: "E1", message: "m" }), "E1");
  assert.equal(eventReason({}), "no reason recorded");
  assert.equal(fmtDuration(1500), "1.5 s");
  assert.equal(fmtDuration(5 * 60_000), "5.0 min");
  assert.equal(fmtBytes(1536), "1.5 KB");
});

test("pdfSafe: never emits characters the standard fonts cannot encode", () => {
  assert.equal(pdfSafe("A — B “quoted” … →"), 'A - B "quoted" ... ->');
  assert.equal(pdfSafe("مشروع"), "?????");
  assert.equal(pdfSafe("café"), "café");
  assert.equal(pdfSafe(null), "");
});

test("PDF renders end-to-end (Arabic titles included) with the JSON attached", async () => {
  const report = buildAdminReport(fixture());
  const bytes = await renderAdminReportPdf(report);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 8, `expected a multi-section report, got ${doc.getPageCount()} pages`);
  assert.match(doc.getTitle() ?? "", /Framevo admin report/);
  const names = doc.catalog.lookup(PDFName.of("Names"), PDFDict);
  const files = names.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
  const list = files.lookup(PDFName.of("Names"), PDFArray);
  const first = list.get(0) as PDFString | PDFHexString;
  assert.equal(first.decodeText(), "framevo-admin-report.json", "JSON attachment embedded");
});

test("PDF renders an empty window without throwing", async () => {
  const report = buildAdminReport(
    fixture({ users: [], projects: [], analysisJobs: [], exports: [], events: [], subscriptions: [] })
  );
  const bytes = await renderAdminReportPdf(report);
  assert.ok(bytes.byteLength > 1000);
});
