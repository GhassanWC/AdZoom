/**
 * Billing presentation model — the PURE layer between `subscriptions/{uid}`
 * and the billing screen.
 *
 * Why a separate module: "what does this subscription state mean to the
 * user, and which button fixes it?" is a decision tree with eight statuses,
 * three timestamps, and a plan tier that can disagree with the subscription
 * doc mid-cancellation. Inlining it as nested ternaries in JSX is how a
 * billing page ends up telling someone "Active" while their card is declining.
 *
 * Everything here is pure and unit-tested (tests/billing-view.test.ts). Both
 * imports are TYPE-ONLY, so the module loads under Node's type stripping
 * without pulling in Firestore.
 *
 * The rule this module enforces: **every state that costs the user something
 * carries an action that resolves it.** A warning with no button is a support
 * ticket.
 */
import type { PlanTier } from "@/lib/usage/plan";
import type { SubscriptionStatus } from "@/lib/firebase/schema";

/**
 * Which Lemon Squeezy destination a billing control opens. Mirrors the
 * `target` accepted by `POST /api/billing/portal`.
 *   • `update`      — hosted "update payment method" page (card on file).
 *   • `change-plan` — hosted plan switcher (upgrade / downgrade).
 *   • `portal`      — the full customer portal (invoices, cancel, resume).
 */
export type BillingActionTarget = "portal" | "update" | "change-plan";

export type BillingTone = "ok" | "warn" | "danger" | "neutral";

export interface BillingAlert {
  tone: "warn" | "danger";
  title: string;
  body: string;
  /** `"upgrade"` means "send them to checkout", not to a hosted LS page. */
  action: BillingActionTarget | "upgrade";
  actionLabel: string;
}

export interface BillingSummary {
  /** Short pill rendered beside the plan name. Never longer than two words. */
  statusLabel: string;
  statusTone: BillingTone;
  /** Heading of the money strip — what the date underneath actually means. */
  chargeLabel: string;
  /** Epoch ms for the money strip; null when nothing is scheduled. */
  chargeAtMs: number | null;
  /** Whether the plan price belongs next to that date (no charge on cancel). */
  showAmount: boolean;
  /**
   * True when `chargeAtMs` is a date that has already passed on a state that
   * owes money. Lemon Squeezy's `renews_at` during dunning is the attempt that
   * FAILED, so rendering it as "$25 on Aug 7" reads like a future charge on a
   * screen where the user is actually late.
   */
  chargeOverdue: boolean;
  /** One line of reassurance under the strip. Always present. */
  chargeNote: string;
  /** Non-null only when the user has to do something. */
  alert: BillingAlert | null;
  /**
   * False when the account has no Lemon Squeezy record at all (Free users,
   * and paid plans granted manually). The hosted-page buttons are dead links
   * in that case, so the UI must not offer them.
   */
  hasBillingRecord: boolean;
  /** True while the plan is winding down — suppresses upsells. */
  windingDown: boolean;
}

/** The subset of `Subscription` this module reads. */
export interface BillingSubscriptionInput {
  status: SubscriptionStatus;
  renewsAt?: number;
  endsAt?: number;
  trialEndsAt?: number;
}

/** Which hosted actions make sense for the current state. */
export interface BillingActionAvailability {
  updateCard: boolean;
  invoices: boolean;
  changePlan: boolean;
  cancel: boolean;
  /** Cancelled-but-still-active plans get "Resume" instead of "Cancel". */
  resume: boolean;
}

function isPositiveMs(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** `undefined`/null/NaN/0 all collapse to null so callers test one thing. */
function ms(v: number | undefined | null): number | null {
  return isPositiveMs(v) ? v : null;
}

/**
 * Format an epoch for billing copy — "Jun 24, 2026". Locale-aware, but the
 * year is always shown: "Jun 24" is ambiguous on an annual plan.
 */
export function formatBillingDate(epochMs: number | null | undefined): string | null {
  if (!isPositiveMs(epochMs)) return null;
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Whole days from `nowMs` to `epochMs`, rounded up. Negative = in the past. */
export function daysUntil(epochMs: number, nowMs: number): number {
  return Math.ceil((epochMs - nowMs) / 86_400_000);
}

/**
 * Human-friendly plan name for copy ("Pro", not "pro" or "Pro plan").
 * Kept here so alert bodies and the payment card agree.
 */
export function planLabel(tier: PlanTier): string {
  return tier === "creator" ? "Creator" : tier === "pro" ? "Pro" : "Free";
}

/**
 * Reduce plan tier + subscription doc into everything the billing screen
 * renders above the usage meters.
 *
 * `tier` is the ACCESS-effective plan (mirrored to `users/{uid}.plan` by the
 * webhook), while `sub.status` is the payment state. They deliberately
 * disagree during a cancellation grace period — the user still has Pro while
 * `status === "cancelled"` — and this function is where that reconciliation
 * lives.
 */
export function summarizeBilling(input: {
  tier: PlanTier;
  sub: BillingSubscriptionInput | null;
  nowMs: number;
}): BillingSummary {
  const { tier, sub, nowMs } = input;
  const name = planLabel(tier);

  // ── No Lemon Squeezy record ────────────────────────────────────────────
  // Free users (the common case) and manually-granted paid plans (rare, but
  // real: an admin can set `users/{uid}.plan` directly). Neither has a card,
  // so neither may be shown a portal button.
  if (!sub) {
    if (tier === "free") {
      return {
        statusLabel: "Free",
        statusTone: "neutral",
        chargeLabel: "Next payment",
        chargeAtMs: null,
        showAmount: false,
        chargeOverdue: false,
        chargeNote: "No card on file. You're never charged on the Free plan.",
        alert: null,
        hasBillingRecord: false,
        windingDown: false,
      };
    }
    return {
      statusLabel: "Active",
      statusTone: "ok",
      chargeLabel: "Next payment",
      chargeAtMs: null,
      showAmount: false,
      chargeOverdue: false,
      chargeNote: `${name} is active on this account with no card attached — contact support to change it.`,
      alert: null,
      hasBillingRecord: false,
      windingDown: false,
    };
  }

  const renewsAt = ms(sub.renewsAt);
  const endsAt = ms(sub.endsAt);
  const trialEndsAt = ms(sub.trialEndsAt);

  switch (sub.status) {
    case "on_trial": {
      const chargeAtMs = trialEndsAt ?? renewsAt;
      return {
        statusLabel: "Free trial",
        statusTone: "ok",
        chargeLabel: "First payment",
        chargeAtMs,
        showAmount: true,
        chargeOverdue: false,
        chargeNote: chargeAtMs
          ? "Your trial converts automatically. Cancel any time before then and you won't be charged."
          : "Your trial converts automatically. Cancel any time and you won't be charged.",
        alert: null,
        hasBillingRecord: true,
        windingDown: false,
      };
    }

    case "past_due":
      return {
        statusLabel: "Payment failed",
        statusTone: "danger",
        chargeLabel: "Payment due",
        chargeAtMs: renewsAt,
        showAmount: true,
        chargeOverdue: renewsAt != null && renewsAt <= nowMs,
        chargeNote:
          "We'll keep retrying your card, but updating it fixes this straight away.",
        alert: {
          tone: "danger",
          title: "Your last payment didn't go through",
          body: `Update your card to keep ${name} — your projects and exports stay untouched in the meantime.`,
          action: "update",
          actionLabel: "Update card",
        },
        hasBillingRecord: true,
        windingDown: false,
      };

    case "unpaid":
      return {
        statusLabel: "Unpaid",
        statusTone: "danger",
        chargeLabel: "Payment due",
        chargeAtMs: renewsAt,
        showAmount: true,
        chargeOverdue: renewsAt != null && renewsAt <= nowMs,
        chargeNote: "Paid features are paused until a payment succeeds.",
        alert: {
          tone: "danger",
          title: "We couldn't collect payment",
          body: `Every retry on your card failed, so ${name} features are paused. Add a working card to restore them.`,
          action: "update",
          actionLabel: "Update card",
        },
        hasBillingRecord: true,
        windingDown: true,
      };

    case "paused":
      return {
        statusLabel: "Paused",
        statusTone: "warn",
        chargeLabel: "Resumes",
        chargeAtMs: renewsAt,
        showAmount: false,
        chargeOverdue: false,
        chargeNote: "You're not being charged while your subscription is paused.",
        alert: {
          tone: "warn",
          title: "Your subscription is paused",
          body: "Paid features are off until you resume. Nothing has been deleted.",
          action: "portal",
          actionLabel: "Resume plan",
        },
        hasBillingRecord: true,
        windingDown: true,
      };

    case "cancelled": {
      const stillActive = endsAt != null && endsAt > nowMs;
      const when = formatBillingDate(endsAt);
      return {
        statusLabel: stillActive ? "Cancelling" : "Cancelled",
        statusTone: "warn",
        chargeLabel: "Access ends",
        chargeAtMs: endsAt,
        showAmount: false,
        chargeOverdue: false,
        chargeNote: stillActive
          ? `No further payments. You keep ${name} until then.`
          : "No further payments. Resubscribe any time — your projects are still here.",
        alert: {
          tone: "warn",
          title: stillActive
            ? `${name} ends ${when ?? "at the end of this period"}`
            : `${name} has ended`,
          body: stillActive
            ? "Resume before then and nothing changes — same plan, same billing date."
            : "Resubscribe to get cloud exports, captions and watermark-free video back.",
          action: stillActive ? "portal" : "upgrade",
          actionLabel: stillActive ? "Resume plan" : "Choose a plan",
        },
        hasBillingRecord: true,
        windingDown: true,
      };
    }

    case "expired":
      return {
        statusLabel: "Expired",
        statusTone: "danger",
        chargeLabel: "Next payment",
        chargeAtMs: null,
        showAmount: false,
        chargeOverdue: false,
        chargeNote: "No card is being charged. Your projects are safe on the Free plan.",
        alert: {
          tone: "danger",
          title: "Your subscription expired",
          body: "Pick a plan to restore cloud exports, extra caption minutes and watermark-free video.",
          action: "upgrade",
          actionLabel: "Choose a plan",
        },
        hasBillingRecord: true,
        windingDown: true,
      };

    case "active":
    default:
      return {
        statusLabel: "Active",
        statusTone: "ok",
        chargeLabel: "Next payment",
        chargeAtMs: renewsAt,
        showAmount: true,
        chargeOverdue: false,
        chargeNote: renewsAt
          ? "Renews automatically. Cancel any time — no questions asked."
          : "Renews automatically. Cancel any time.",
        alert: null,
        hasBillingRecord: true,
        windingDown: false,
      };
  }
}

/**
 * Which hosted billing actions to render. Driven off the same summary the
 * page shows, so a state can never advertise a button that leads nowhere
 * (e.g. "Cancel subscription" on an already-cancelled plan).
 */
export function billingActions(summary: BillingSummary, status?: SubscriptionStatus): BillingActionAvailability {
  if (!summary.hasBillingRecord) {
    return { updateCard: false, invoices: false, changePlan: false, cancel: false, resume: false };
  }
  const ended = status === "expired";
  const cancelled = status === "cancelled";
  const paused = status === "paused";
  return {
    // Invoices exist for anything LS ever billed, including ended plans.
    invoices: true,
    // A card can be replaced right up until the record expires.
    updateCard: !ended,
    // Switching plans through the portal needs a live subscription.
    changePlan: !ended && !cancelled,
    cancel: !ended && !cancelled && !paused,
    resume: cancelled || paused,
  };
}
