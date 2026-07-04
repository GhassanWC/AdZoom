/**
 * Auto-caption usage quota — the pure config, period math, and ledger
 * reducers that the server transactions delegate to (src/lib/usage/
 * caption-quota.ts). Atomicity across concurrent requests comes from
 * Firestore `runTransaction` serialization; these tests lock the reducer
 * semantics those transactions execute — reserve/commit/release, idempotency
 * (no double charge on retries or duplicate deliveries), plan changes, and
 * the billing-period reset. Charging happens ONLY at ASR reserve time, so
 * cached-transcript reuse / re-export / caption restyling never touch the
 * ledger by construction (see the decideTranscription tests too).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPTION_PLAN_LIMITS,
  CAPTION_RESERVATION_TTL_MS,
  addMonthsUtcClamped,
  applyCaptionCommit,
  applyCaptionRelease,
  applyCaptionReserve,
  applyPlanChange,
  captionAllowanceSeconds,
  captionAllowanceLabel,
  captionRemainingSeconds,
  estimateCaptionMinutes,
  exceedsCaptionVideoLimit,
  initialCaptionUsageDoc,
  perVideoCaptionLimitMessage,
  requiredCaptionSeconds,
  resolveCaptionPeriod,
  shouldCommitCaptionUsage,
  sweepStaleReservation,
  type CaptionUsageDoc,
} from "@/lib/usage/caption-quota";
import {
  decideTranscription,
  transcriptionFingerprint,
} from "@/lib/transcript/transcription-job";

const NOW = Date.UTC(2026, 6, 5, 12, 0, 0); // 2026-07-05T12:00Z

function freshDoc(plan: "free" | "pro" | "creator" = "pro"): CaptionUsageDoc {
  const period = resolveCaptionPeriod({ plan, renewsAtMs: null, nowMs: NOW });
  return initialCaptionUsageDoc({ plan, period, nowMs: NOW });
}

/* ── Plan allowances (10 / 150 / 300 minutes) ────────────────────────────── */

test("monthly caption allowances are 10/150/300 minutes by plan", () => {
  assert.equal(captionAllowanceSeconds("free"), 10 * 60);
  assert.equal(captionAllowanceSeconds("pro"), 150 * 60);
  assert.equal(captionAllowanceSeconds("creator"), 300 * 60);
  assert.equal(captionAllowanceLabel("free"), "10 auto-caption minutes/month");
  assert.equal(captionAllowanceLabel("pro"), "150 auto-caption minutes/month");
  assert.equal(captionAllowanceLabel("creator"), "300 auto-caption minutes/month");
});

test("a plan's full allowance is reservable and exactly exhausts", () => {
  for (const plan of ["free", "pro", "creator"] as const) {
    const doc = freshDoc(plan);
    const all = captionAllowanceSeconds(plan);
    const r = applyCaptionReserve(doc, { key: "k1", seconds: all, projectId: "p", nowMs: NOW });
    assert.ok(r.ok && !r.alreadyReserved);
    if (!r.ok) continue;
    assert.equal(r.doc.remainingSeconds, 0);
    // One more second is over the allowance.
    const over = applyCaptionReserve(r.doc, { key: "k2", seconds: 1, projectId: "p", nowMs: NOW });
    assert.deepEqual(over, { ok: false, reason: "exhausted", remainingSeconds: 0 });
  }
});

/* ── Per-video limits (5 / 15 / 30 minutes) ──────────────────────────────── */

test("per-video caption limits are 5/15/30 minutes by plan", () => {
  assert.equal(CAPTION_PLAN_LIMITS.free.maxCaptionVideoSeconds, 300);
  assert.equal(CAPTION_PLAN_LIMITS.pro.maxCaptionVideoSeconds, 900);
  assert.equal(CAPTION_PLAN_LIMITS.creator.maxCaptionVideoSeconds, 1800);
  assert.equal(exceedsCaptionVideoLimit("free", 300), false); // at the cap = allowed
  assert.equal(exceedsCaptionVideoLimit("free", 301), true);
  assert.equal(exceedsCaptionVideoLimit("pro", 901), true);
  assert.equal(exceedsCaptionVideoLimit("creator", 1800), false);
  assert.equal(exceedsCaptionVideoLimit("creator", 1801), true);
  // Unknown durations are gated elsewhere (fail-closed reserve), not here.
  assert.equal(exceedsCaptionVideoLimit("free", null), false);
});

test("per-video limit messages name the limit and the plan", () => {
  assert.equal(
    perVideoCaptionLimitMessage("free"),
    "This video exceeds the 5-minute auto-caption limit for Free."
  );
  assert.equal(
    perVideoCaptionLimitMessage("pro"),
    "This video exceeds the 15-minute auto-caption limit for Pro."
  );
  assert.equal(
    perVideoCaptionLimitMessage("creator"),
    "This video exceeds the 30-minute auto-caption limit for Creator."
  );
});

/* ── Reservation semantics ───────────────────────────────────────────────── */

test("reservation is charged in whole seconds, rounded up", () => {
  assert.equal(requiredCaptionSeconds(162.2), 163);
  assert.equal(requiredCaptionSeconds(0.4), 1);
  assert.equal(requiredCaptionSeconds(NaN), 1);
});

test("two simultaneous requests cannot overspend (serialized reserve)", () => {
  // Firestore serializes contending transactions; each re-executes against the
  // committed state. Model that: both start from the same doc, the first
  // commits, the second re-runs against the FIRST's result and must fail.
  const doc = freshDoc("free"); // 600s
  const a = applyCaptionReserve(doc, { key: "a", seconds: 400, projectId: "p1", nowMs: NOW });
  assert.ok(a.ok);
  if (!a.ok) return;
  const b = applyCaptionReserve(a.doc, { key: "b", seconds: 400, projectId: "p2", nowMs: NOW });
  assert.deepEqual(b, { ok: false, reason: "exhausted", remainingSeconds: 200 });
});

test("re-reserving the same idempotency key never double-holds", () => {
  const doc = freshDoc("pro");
  const first = applyCaptionReserve(doc, { key: "job1", seconds: 120, projectId: "p", nowMs: NOW });
  assert.ok(first.ok && !first.alreadyReserved);
  if (!first.ok) return;
  const retry = applyCaptionReserve(first.doc, { key: "job1", seconds: 120, projectId: "p", nowMs: NOW });
  assert.ok(retry.ok && retry.alreadyReserved);
  if (!retry.ok) return;
  assert.equal(retry.doc.reservedSeconds, 120); // unchanged
});

/* ── Commit / release lifecycle ──────────────────────────────────────────── */

function reserved(seconds = 120): CaptionUsageDoc {
  const r = applyCaptionReserve(freshDoc("pro"), {
    key: "job1",
    seconds,
    projectId: "p",
    nowMs: NOW,
  });
  assert.ok(r.ok);
  return (r as { ok: true; doc: CaptionUsageDoc }).doc;
}

test("successful ASR commits reserved seconds into usedSeconds", () => {
  const doc = applyCaptionCommit(reserved(120), { key: "job1", nowMs: NOW });
  assert.equal(doc.usedSeconds, 120);
  assert.equal(doc.reservedSeconds, 0);
  assert.equal(doc.remainingSeconds, 150 * 60 - 120);
  assert.ok(doc.finalizedKeys["job1"]);
});

test("failed ASR releases the reservation without charging", () => {
  const doc = applyCaptionRelease(reserved(120), { key: "job1", nowMs: NOW });
  assert.equal(doc.usedSeconds, 0);
  assert.equal(doc.reservedSeconds, 0);
  assert.equal(doc.remainingSeconds, 150 * 60);
});

test("a successful EMPTY transcript still counts (provider processed audio)", () => {
  // Policy helper shared by the analyze route + the worker: any `complete`
  // status commits — segments are irrelevant to billing.
  assert.equal(shouldCommitCaptionUsage("complete"), true);
  assert.equal(shouldCommitCaptionUsage("failed"), false);
  assert.equal(shouldCommitCaptionUsage("unavailable"), false);
  assert.equal(shouldCommitCaptionUsage("processing"), false);
});

test("duplicate worker delivery cannot charge twice (idempotent commit)", () => {
  const once = applyCaptionCommit(reserved(120), { key: "job1", nowMs: NOW });
  const twice = applyCaptionCommit(once, { key: "job1", nowMs: NOW + 1000 });
  assert.equal(twice, once); // structurally the SAME doc — a no-op
  assert.equal(twice.usedSeconds, 120);
});

test("release after commit never reduces usedSeconds", () => {
  const committed = applyCaptionCommit(reserved(120), { key: "job1", nowMs: NOW });
  const released = applyCaptionRelease(committed, { key: "job1", nowMs: NOW + 1000 });
  assert.equal(released.usedSeconds, 120);
  assert.equal(released, committed);
});

test("a late success whose reservation was swept charges the fallback", () => {
  const swept = applyCaptionRelease(reserved(120), { key: "job1", nowMs: NOW });
  // ...but the sweep RELEASED it, then the provider success arrives: the key
  // is finalized, so nothing double-charges…
  const lateAfterRelease = applyCaptionCommit(swept, { key: "job1", nowMs: NOW });
  assert.equal(lateAfterRelease.usedSeconds, 0);
  // …while a commit for a key with NO reservation record at all (e.g. a
  // period-crossing job) charges its recorded fallback seconds exactly once.
  const doc = applyCaptionCommit(freshDoc("pro"), { key: "ghost", nowMs: NOW, fallbackSeconds: 90 });
  assert.equal(doc.usedSeconds, 90);
  const again = applyCaptionCommit(doc, { key: "ghost", nowMs: NOW, fallbackSeconds: 90 });
  assert.equal(again.usedSeconds, 90); // idempotent
});

/* ── Stale-job reconciliation ────────────────────────────────────────────── */

test("stale reservations reconcile from recorded transcript state", () => {
  const res = { seconds: 120, projectId: "p", createdAtMs: NOW - CAPTION_RESERVATION_TTL_MS - 1 };
  const fresh = { ...res, createdAtMs: NOW };
  assert.equal(
    sweepStaleReservation({ reservation: fresh, nowMs: NOW, transcriptUsageKey: "k", transcriptStatus: "processing", key: "k" }),
    "keep"
  );
  // Completed under this key → the provider processed audio → commit.
  assert.equal(
    sweepStaleReservation({ reservation: res, nowMs: NOW, transcriptUsageKey: "k", transcriptStatus: "complete", key: "k" }),
    "commit"
  );
  // Dead/replaced/failed job → release.
  assert.equal(
    sweepStaleReservation({ reservation: res, nowMs: NOW, transcriptUsageKey: "k", transcriptStatus: "failed", key: "k" }),
    "release"
  );
  assert.equal(
    sweepStaleReservation({ reservation: res, nowMs: NOW, transcriptUsageKey: "other", transcriptStatus: "complete", key: "k" }),
    "release"
  );
  assert.equal(
    sweepStaleReservation({ reservation: res, nowMs: NOW, transcriptUsageKey: null, transcriptStatus: null, key: "k" }),
    "release"
  );
});

/* ── Caching / reuse never charges ───────────────────────────────────────── */

const SOURCE = { storagePath: "u/p/video.mp4", fileSize: 1000, duration: 90 };

test("unchanged video + language reuses the transcript (no new ASR, no charge)", () => {
  const fp = transcriptionFingerprint({
    source: SOURCE,
    languageMode: "auto",
    model: "latest_long",
    provider: "google_speech",
  });
  const decision = decideTranscription({
    existing: {
      status: "complete",
      segments: [{ id: "s1", startTime: 0, endTime: 1, text: "hi" }],
      sourceFingerprint: fp,
    },
    fingerprint: fp,
    runnable: true,
    forceRetranscribe: false,
    now: NOW,
  });
  assert.equal(decision.action, "reuse"); // reuse path never reaches reserve
});

test("changed video or changed language forces a NEW charged transcription", () => {
  const base = {
    languageMode: "auto" as const,
    model: "latest_long",
    provider: "google_speech",
  };
  const fp = transcriptionFingerprint({ source: SOURCE, ...base });
  const fpNewVideo = transcriptionFingerprint({
    source: { ...SOURCE, fileSize: 2000 },
    ...base,
  });
  const fpNewLang = transcriptionFingerprint({
    source: SOURCE,
    languageMode: "selected",
    languageCode: "ar-OM",
    model: "latest_long",
    provider: "google_speech",
  });
  assert.notEqual(fp, fpNewVideo);
  assert.notEqual(fp, fpNewLang);
  const existing = {
    status: "complete" as const,
    segments: [{ id: "s1", startTime: 0, endTime: 1, text: "hi" }],
    sourceFingerprint: fp,
  };
  assert.equal(
    decideTranscription({ existing, fingerprint: fpNewVideo, runnable: true, forceRetranscribe: false, now: NOW }).action,
    "transcribe"
  );
  assert.equal(
    decideTranscription({ existing, fingerprint: fpNewLang, runnable: true, forceRetranscribe: false, now: NOW }).action,
    "transcribe"
  );
});

/* ── Billing periods, reset, upgrades ────────────────────────────────────── */

test("free plan resets on the UTC calendar month", () => {
  const july = resolveCaptionPeriod({ plan: "free", renewsAtMs: null, nowMs: NOW });
  assert.equal(july.periodId, "cal-2026-07");
  assert.equal(july.anchor, "calendar");
  const august = resolveCaptionPeriod({
    plan: "free",
    renewsAtMs: null,
    nowMs: Date.UTC(2026, 7, 1, 0, 0, 1),
  });
  assert.equal(august.periodId, "cal-2026-08");
  // A new period is a NEW ledger doc — usage starts from zero (the reset).
  const next = initialCaptionUsageDoc({ plan: "free", period: august, nowMs: NOW });
  assert.equal(next.usedSeconds, 0);
  assert.equal(next.remainingSeconds, 600);
});

test("paid plans anchor the period to the subscription renewal date", () => {
  // Renews on the 20th → on July 5 the current window is Jun 20 → Jul 20.
  const renewsAt = Date.UTC(2026, 6, 20, 9, 30);
  const p = resolveCaptionPeriod({ plan: "pro", renewsAtMs: renewsAt, nowMs: NOW });
  assert.equal(p.anchor, "subscription");
  assert.equal(p.periodId, "sub-20260620");
  assert.ok(p.startMs <= NOW && NOW < p.endMs);
  assert.equal(p.endMs, renewsAt);
  // A stale renewsAt (months ago) walks FORWARD to the window containing now.
  const old = resolveCaptionPeriod({
    plan: "pro",
    renewsAtMs: Date.UTC(2026, 0, 20),
    nowMs: NOW,
  });
  assert.equal(old.periodId, "sub-20260620");
  // Paid with no subscription doc falls back to the calendar month.
  const fallback = resolveCaptionPeriod({ plan: "pro", renewsAtMs: null, nowMs: NOW });
  assert.equal(fallback.anchor, "calendar");
});

test("month stepping clamps end-of-month anniversaries", () => {
  const jan31 = Date.UTC(2026, 0, 31);
  const feb = addMonthsUtcClamped(jan31, 1);
  assert.equal(new Date(feb).getUTCMonth(), 1);
  assert.equal(new Date(feb).getUTCDate(), 28); // 2026 is not a leap year
  const mar31 = Date.UTC(2026, 2, 31);
  assert.equal(new Date(addMonthsUtcClamped(mar31, 1)).getUTCDate(), 30); // Apr 30
});

test("upgrade mid-cycle immediately raises the allowance, never touching used", () => {
  let doc = freshDoc("free"); // 600s
  const r = applyCaptionReserve(doc, { key: "k", seconds: 500, projectId: "p", nowMs: NOW });
  assert.ok(r.ok);
  doc = applyCaptionCommit((r as { ok: true; doc: CaptionUsageDoc }).doc, { key: "k", nowMs: NOW });
  const upgraded = applyPlanChange(doc, "pro", NOW);
  assert.equal(upgraded.plan, "pro");
  assert.equal(upgraded.allowanceSeconds, 150 * 60);
  assert.equal(upgraded.usedSeconds, 500); // never reduced
  assert.equal(upgraded.remainingSeconds, 150 * 60 - 500);
});

test("downgrade keeps the current period's granted allowance (entitlement)", () => {
  const doc = freshDoc("creator"); // 300 min granted this period
  const after = applyPlanChange(doc, "free", NOW);
  assert.equal(after, doc); // unchanged until the period rolls over
});

test("remaining is max(0, allowance − used − reserved) and never negative", () => {
  assert.equal(
    captionRemainingSeconds({ allowanceSeconds: 600, usedSeconds: 500, reservedSeconds: 200 }),
    0
  );
  assert.equal(
    captionRemainingSeconds({ allowanceSeconds: 600, usedSeconds: 100, reservedSeconds: 50 }),
    450
  );
});

test("old users without a captionUsage doc initialize safely at zero usage", () => {
  const period = resolveCaptionPeriod({ plan: "pro", renewsAtMs: null, nowMs: NOW });
  const doc = initialCaptionUsageDoc({ plan: "pro", period, nowMs: NOW });
  assert.equal(doc.usedSeconds, 0);
  assert.equal(doc.reservedSeconds, 0);
  assert.equal(doc.remainingSeconds, 150 * 60);
  assert.deepEqual(doc.reservations, {});
  assert.deepEqual(doc.finalizedKeys, {});
});

/* ── UI estimates ────────────────────────────────────────────────────────── */

test("the analysis estimate rounds to one decimal minute", () => {
  assert.equal(estimateCaptionMinutes(162), 2.7); // the spec's example
  assert.equal(estimateCaptionMinutes(60), 1);
  assert.equal(estimateCaptionMinutes(3), 0.1); // floor at a tenth
});
