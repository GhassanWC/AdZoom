/**
 * Unit tests for the BILLING PRESENTATION MODEL — the pure reducer that turns
 * `users/{uid}.plan` + `subscriptions/{uid}` into the status pill, the money
 * strip and the "which button fixes this" action on /dashboard/billing.
 *
 * Run with:  npm test   (node --test, native TS strip; no test deps)
 *
 * `subscription-view.ts` imports both `@/lib/usage/plan` and
 * `@/lib/firebase/schema` TYPE-ONLY (erased by Node's type stripping), so it
 * loads cleanly via a relative path with no Firestore in the process.
 *
 * The invariants worth locking:
 *   1. Every state that costs the user money or access carries an action.
 *   2. A cancelled-but-not-yet-ended plan never claims a future PAYMENT — it
 *      shows when ACCESS ends, with no amount.
 *   3. Accounts with no Lemon Squeezy record never advertise hosted-page
 *      buttons (they would 404).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  summarizeBilling,
  billingActions,
  formatBillingDate,
  daysUntil,
  planLabel,
} from "../src/lib/billing/subscription-view.ts";

const NOW = Date.UTC(2026, 5, 1); // 2026-06-01
const IN_23_DAYS = Date.UTC(2026, 5, 24);
const LAST_WEEK = Date.UTC(2026, 4, 25);

test("free account with no subscription doc: no card, no alert, no portal", () => {
  const s = summarizeBilling({ tier: "free", sub: null, nowMs: NOW });
  assert.equal(s.statusLabel, "Free");
  assert.equal(s.statusTone, "neutral");
  assert.equal(s.chargeAtMs, null);
  assert.equal(s.showAmount, false);
  assert.equal(s.alert, null);
  assert.equal(s.hasBillingRecord, false);

  const a = billingActions(s);
  assert.deepEqual(a, {
    updateCard: false,
    invoices: false,
    changePlan: false,
    cancel: false,
    resume: false,
  });
});

test("paid tier with NO subscription doc (manually granted) hides hosted actions", () => {
  const s = summarizeBilling({ tier: "pro", sub: null, nowMs: NOW });
  assert.equal(s.statusTone, "ok");
  assert.equal(s.hasBillingRecord, false);
  // No dead links to Lemon Squeezy pages this account has no record on.
  assert.equal(billingActions(s).updateCard, false);
  assert.equal(billingActions(s).invoices, false);
});

test("active subscription: next payment date + amount, no alert", () => {
  const s = summarizeBilling({
    tier: "pro",
    sub: { status: "active", renewsAt: IN_23_DAYS },
    nowMs: NOW,
  });
  assert.equal(s.statusLabel, "Active");
  assert.equal(s.statusTone, "ok");
  assert.equal(s.chargeLabel, "Next payment");
  assert.equal(s.chargeAtMs, IN_23_DAYS);
  assert.equal(s.showAmount, true);
  assert.equal(s.alert, null);
  assert.equal(s.windingDown, false);

  const a = billingActions(s, "active");
  assert.equal(a.updateCard, true);
  assert.equal(a.invoices, true);
  assert.equal(a.changePlan, true);
  assert.equal(a.cancel, true);
  assert.equal(a.resume, false);
});

test("past_due is a DANGER state whose action is update-card", () => {
  const s = summarizeBilling({
    tier: "pro",
    sub: { status: "past_due", renewsAt: IN_23_DAYS },
    nowMs: NOW,
  });
  assert.equal(s.statusTone, "danger");
  assert.ok(s.alert, "past_due must raise an alert");
  assert.equal(s.alert?.tone, "danger");
  assert.equal(s.alert?.action, "update");
  // Still a paying customer — don't tell them the plan is winding down.
  assert.equal(s.windingDown, false);
  // Card replacement is exactly what unblocks them.
  assert.equal(billingActions(s, "past_due").updateCard, true);
});

test("a past renewal date on a dunning state is flagged OVERDUE, not upcoming", () => {
  // LS's renews_at during dunning is the attempt that failed. Rendering it as
  // "$25 on Aug 7" on Aug 9 tells a late customer they have nothing to do.
  const late = summarizeBilling({
    tier: "pro",
    sub: { status: "past_due", renewsAt: LAST_WEEK },
    nowMs: NOW,
  });
  assert.equal(late.chargeOverdue, true);

  // A future retry date is genuinely upcoming — don't cry wolf.
  const retryScheduled = summarizeBilling({
    tier: "pro",
    sub: { status: "past_due", renewsAt: IN_23_DAYS },
    nowMs: NOW,
  });
  assert.equal(retryScheduled.chargeOverdue, false);

  // Healthy and winding-down states never claim an overdue balance.
  for (const status of ["active", "on_trial", "cancelled", "paused", "expired"] as const) {
    const s = summarizeBilling({
      tier: "pro",
      sub: { status, renewsAt: LAST_WEEK, endsAt: LAST_WEEK, trialEndsAt: LAST_WEEK },
      nowMs: NOW,
    });
    assert.equal(s.chargeOverdue, false, `${status} must not read as overdue`);
  }
});

test("unpaid keeps the update-card action but marks the plan as winding down", () => {
  const s = summarizeBilling({ tier: "pro", sub: { status: "unpaid" }, nowMs: NOW });
  assert.equal(s.statusTone, "danger");
  assert.equal(s.alert?.action, "update");
  assert.equal(s.windingDown, true);
});

test("cancelled-but-still-active shows ACCESS ENDS, never a future charge", () => {
  const s = summarizeBilling({
    tier: "pro",
    sub: { status: "cancelled", endsAt: IN_23_DAYS, renewsAt: IN_23_DAYS },
    nowMs: NOW,
  });
  assert.equal(s.statusLabel, "Cancelling");
  assert.equal(s.chargeLabel, "Access ends");
  assert.equal(s.chargeAtMs, IN_23_DAYS);
  // The single most important assertion on this screen: a cancelled plan
  // must not display a price next to a date, or it reads as "you'll be billed".
  assert.equal(s.showAmount, false);
  assert.equal(s.alert?.action, "portal");
  assert.equal(s.alert?.actionLabel, "Resume plan");

  const a = billingActions(s, "cancelled");
  assert.equal(a.cancel, false, "cannot cancel twice");
  assert.equal(a.resume, true);
  assert.equal(a.invoices, true, "past invoices remain reachable");
});

test("cancelled with an endsAt in the past reads as fully cancelled", () => {
  const s = summarizeBilling({
    tier: "free",
    sub: { status: "cancelled", endsAt: LAST_WEEK },
    nowMs: NOW,
  });
  assert.equal(s.statusLabel, "Cancelled");
  assert.equal(s.alert?.action, "upgrade");
});

test("paused pauses billing and offers resume", () => {
  const s = summarizeBilling({
    tier: "pro",
    sub: { status: "paused", renewsAt: IN_23_DAYS },
    nowMs: NOW,
  });
  assert.equal(s.statusTone, "warn");
  assert.equal(s.chargeLabel, "Resumes");
  assert.equal(s.showAmount, false);
  assert.equal(s.alert?.action, "portal");
  const a = billingActions(s, "paused");
  assert.equal(a.resume, true);
  assert.equal(a.cancel, false);
});

test("expired routes to checkout, not to the portal", () => {
  const s = summarizeBilling({ tier: "free", sub: { status: "expired" }, nowMs: NOW });
  assert.equal(s.statusTone, "danger");
  assert.equal(s.alert?.action, "upgrade");
  assert.equal(s.chargeAtMs, null);
  const a = billingActions(s, "expired");
  assert.equal(a.updateCard, false, "nothing left to charge");
  assert.equal(a.changePlan, false);
  assert.equal(a.invoices, true, "receipts still matter after expiry");
});

test("on_trial bills at trialEndsAt, falling back to renewsAt", () => {
  const withTrial = summarizeBilling({
    tier: "pro",
    sub: { status: "on_trial", trialEndsAt: IN_23_DAYS, renewsAt: Date.UTC(2026, 6, 24) },
    nowMs: NOW,
  });
  assert.equal(withTrial.chargeLabel, "First payment");
  assert.equal(withTrial.chargeAtMs, IN_23_DAYS);
  assert.equal(withTrial.showAmount, true);
  assert.equal(withTrial.alert, null);

  const noTrialStamp = summarizeBilling({
    tier: "pro",
    sub: { status: "on_trial", renewsAt: IN_23_DAYS },
    nowMs: NOW,
  });
  assert.equal(noTrialStamp.chargeAtMs, IN_23_DAYS);
});

test("garbage timestamps collapse to null rather than rendering Invalid Date", () => {
  const s = summarizeBilling({
    tier: "pro",
    // 0 and NaN both reach this reducer from partially-written webhook docs.
    sub: { status: "active", renewsAt: 0, endsAt: Number.NaN },
    nowMs: NOW,
  });
  assert.equal(s.chargeAtMs, null);
  assert.equal(formatBillingDate(s.chargeAtMs), null);
  assert.equal(formatBillingDate(undefined), null);
});

test("every alert carries an action label the UI can render on a button", () => {
  const states = ["past_due", "unpaid", "paused", "cancelled", "expired"] as const;
  for (const status of states) {
    const s = summarizeBilling({
      tier: "pro",
      sub: { status, endsAt: IN_23_DAYS },
      nowMs: NOW,
    });
    assert.ok(s.alert, `${status} should alert`);
    assert.ok((s.alert?.actionLabel ?? "").length > 0, `${status} alert needs a button label`);
    assert.ok((s.alert?.body ?? "").length > 0, `${status} alert needs body copy`);
  }
});

test("healthy states never alert", () => {
  for (const status of ["active", "on_trial"] as const) {
    const s = summarizeBilling({
      tier: "creator",
      sub: { status, renewsAt: IN_23_DAYS },
      nowMs: NOW,
    });
    assert.equal(s.alert, null, `${status} must not nag`);
  }
});

test("date + day helpers", () => {
  assert.equal(daysUntil(IN_23_DAYS, NOW), 23);
  assert.equal(daysUntil(LAST_WEEK, NOW), -7);
  assert.ok(formatBillingDate(IN_23_DAYS)?.includes("2026"));
});

test("plan labels are the ones the pricing page uses", () => {
  assert.equal(planLabel("free"), "Free");
  assert.equal(planLabel("pro"), "Pro");
  assert.equal(planLabel("creator"), "Creator");
});
