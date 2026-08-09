"use client";

import * as React from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  CalendarClock,
  Check,
  CircleSlash,
  CreditCard,
  Lock,
  ReceiptText,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { useCloudMinutes } from "@/lib/usage/useCloudMinutes";
import { useCaptionUsage } from "@/lib/usage/useCaptionUsage";
import { fmtBytes, storageBand, type PlanTier } from "@/lib/usage/plan";
import { subscribeSubscription } from "@/lib/firebase/subscriptions";
import { CheckoutButton } from "@/components/billing/CheckoutButton";
import { ComparePlansLink } from "@/components/billing/ComparePlansLink";
import { BillingActionRow } from "@/components/billing/BillingActionRow";
import { UsageMeter, type MeterTone } from "@/components/billing/UsageMeter";
import { useBillingPortal } from "@/components/billing/useBillingPortal";
import {
  billingActions,
  daysUntil,
  formatBillingDate,
  planLabel,
  summarizeBilling,
  type BillingActionTarget,
  type BillingTone,
} from "@/lib/billing/subscription-view";
import { cn } from "@/lib/cn";
import { logFramevoEvent } from "@/lib/firebase/analytics";
import { EVENTS } from "@/lib/analytics/events";
import { pricingTiers } from "@/lib/mockData";
import type { Subscription } from "@/lib/firebase/schema";

interface PlanCopy {
  price: string;
  cadence: string;
  tagline: string;
  features: string[];
}

// Keyed by INTERNAL tier; copy is the SAME source as the /pricing + landing
// pages (src/lib/mockData `pricingTiers`) so plan benefits never drift.
function tierCopy(name: "free" | "pro" | "creator"): PlanCopy {
  const t = pricingTiers.find((x) => x.name.toLowerCase() === name);
  return {
    price: t?.price ?? "$0",
    cadence: t?.priceUnit ?? "forever",
    tagline: t?.tagline ?? "",
    features: t?.features ?? [],
  };
}
const PLAN_COPY: Record<PlanTier, PlanCopy> = {
  free: tierCopy("free"),
  pro: tierCopy("pro"),
  creator: tierCopy("creator"),
};

/** The tier we'd sell next. Creator is the top plan, so it upsells nothing. */
const NEXT_TIER: Record<PlanTier, "pro" | "creator" | null> = {
  free: "pro",
  pro: "creator",
  creator: null,
};

/** "in 12 days" for anything inside two months; null when it's not worth saying. */
function relativeDays(targetMs: number, nowMs: number): string | null {
  const d = daysUntil(targetMs, nowMs);
  if (d < 0 || d > 60) return null;
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  return `in ${d} days`;
}

/** First instant of next UTC month — when the `YYYY-MM` usage doc rolls over. */
function nextCalendarMonthUtc(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/* Hydration gate. Dates here are formatted with `toLocaleDateString`, and the
   usage numbers arrive from Firestore listeners — both differ between the
   server render and the browser. `useSyncExternalStore` is the sanctioned way
   to ask "am I past hydration?": React renders the server snapshot first, then
   re-renders with the client one. A `useState` + `useEffect` flag would do the
   same job with an extra cascading render. The store never changes, so
   `subscribe` has nothing to unsubscribe. */
const NEVER_CHANGES = () => () => {};
const onClient = () => true;
const onServer = () => false;

const CHIP_TONE: Record<BillingTone, string> = {
  ok: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  warn: "border-amber-400/30 bg-amber-400/15 text-amber-200",
  danger: "border-rose-400/30 bg-rose-400/10 text-rose-300",
  neutral: "border-white/10 bg-white/[0.03] text-fog",
};
const DOT_TONE: Record<BillingTone, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  danger: "bg-rose-400",
  neutral: "bg-fog",
};

function StatusChip({ label, tone }: { label: string; tone: BillingTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        CHIP_TONE[tone]
      )}
    >
      <span className={cn("size-1.5 rounded-full", DOT_TONE[tone])} />
      {label}
    </span>
  );
}

export default function BillingPage() {
  const { user } = useAuth();
  const storage = useStoragePlan();
  const cloud = useCloudMinutes();
  const captions = useCaptionUsage();
  const portal = useBillingPortal();
  const tier = storage.plan.tier;
  const copy = PLAN_COPY[tier];

  // One timestamp for the whole render pass, so the countdown chip and the
  // "cancelled or cancelling?" decision can't disagree by a millisecond.
  const nowMs = React.useMemo(() => Date.now(), []);

  // Dates and live counters are client-only facts: rendering them during SSR
  // would both mismatch on hydration (server locale ≠ browser locale) and
  // flash a confident "0 / 5 GB" before the real numbers land.
  const mounted = React.useSyncExternalStore(NEVER_CHANGES, onClient, onServer);

  // Free buys a COUNT of cloud exports (2/month); paid plans buy MINUTES
  // (150 / 250). One meter, two units — matching what /pricing sells.
  const cloudUsed = tier === "free" ? cloud.monthlyExportsUsed : cloud.used;
  const cloudLimit = tier === "free" ? cloud.monthlyExportLimit : cloud.limit;

  // Lemon Squeezy redirects back here with ?checkout=success after a paid
  // checkout — the client-observable "purchase" signal for GA4 (a conversion).
  // The webhook remains the source of truth for the subscription itself.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("checkout") === "success") {
      logFramevoEvent(EVENTS.CHECKOUT_COMPLETED, { plan: sp.get("plan") ?? undefined });
    }
  }, []);

  // Live subscription doc — present once the LS webhook has fired at least once.
  const [sub, setSub] = React.useState<Subscription | null>(null);
  React.useEffect(() => {
    if (!user) {
      setSub(null);
      return;
    }
    return subscribeSubscription(user.uid, setSub);
  }, [user]);

  const summary = summarizeBilling({ tier, sub, nowMs });
  const actions = billingActions(summary, sub?.status);
  const name = planLabel(tier);
  // Bound once so the banner's handler closes over a narrowed value instead of
  // re-asserting non-null inside JSX.
  const alert = summary.alert;

  // ── Money strip ─────────────────────────────────────────────────────────
  const chargeDate = formatBillingDate(summary.chargeAtMs);
  const chargeHeadline = !chargeDate
    ? tier === "free"
      ? "No payment due"
      : "No date scheduled"
    : summary.chargeOverdue
      ? `${copy.price} overdue since ${chargeDate}`
      : summary.showAmount
        ? `${copy.price} on ${chargeDate}`
        : chargeDate;
  const countdown = summary.chargeAtMs ? relativeDays(summary.chargeAtMs, nowMs) : null;

  // ── Usage meters ────────────────────────────────────────────────────────
  const cloudCapped = Number.isFinite(cloudLimit);
  const cloudRemaining = cloudCapped ? Math.max(0, cloudLimit - cloudUsed) : Number.POSITIVE_INFINITY;
  const cloudUnit = tier === "free" ? "" : " min";
  const monthResets = formatBillingDate(nextCalendarMonthUtc(nowMs));
  const captionResets = formatBillingDate(captions.periodEndMs);
  const storagePct = Math.round(storage.fraction * 100);

  const band = (used: number, limit: number): MeterTone =>
    Number.isFinite(limit) ? storageBand(used, limit) : "ok";

  // ── Upgrade strip ───────────────────────────────────────────────────────
  const nextTier = NEXT_TIER[tier];
  const upgrade = nextTier
    ? {
        plan: nextTier,
        name: planLabel(nextTier),
        copy: PLAN_COPY[nextTier],
        // What the NEXT plan adds, derived from the same pricing data rather
        // than a hand-written list that would rot the next time a limit moves.
        deltas: PLAN_COPY[nextTier].features.filter((f) => !copy.features.includes(f)),
      }
    : null;

  // Every hosted-page row shares one request slot, so the card can't fire two
  // portal lookups at once.
  const rows: Array<{
    key: string;
    icon: React.ReactNode;
    title: string;
    description: string;
    actionLabel: string;
    target: BillingActionTarget;
    tone?: "default" | "quiet";
  }> = [];
  if (actions.updateCard) {
    rows.push({
      key: "update",
      icon: <CreditCard size={15} />,
      title: "Payment method",
      description: "Change the card we charge each period",
      actionLabel: "Update",
      target: "update",
    });
  }
  if (actions.invoices) {
    rows.push({
      key: "invoices",
      icon: <ReceiptText size={15} />,
      title: "Invoices & receipts",
      description: "Download every payment for your records",
      actionLabel: "View",
      target: "portal",
    });
  }
  if (actions.changePlan) {
    rows.push({
      key: "change-plan",
      icon: <ArrowLeftRight size={15} />,
      title: "Change plan",
      description: "Switch tiers — billing adjusts automatically",
      actionLabel: "Switch",
      target: "change-plan",
    });
  }
  if (actions.resume) {
    rows.push({
      key: "resume",
      icon: <RotateCcw size={15} />,
      title: "Resume subscription",
      description:
        summary.chargeAtMs && summary.chargeAtMs > nowMs
          ? `Keep ${name} past ${formatBillingDate(summary.chargeAtMs)}`
          : "Restart billing on this account",
      actionLabel: "Resume",
      target: "portal",
    });
  }
  if (actions.cancel) {
    rows.push({
      key: "cancel",
      icon: <CircleSlash size={15} />,
      title: "Cancel subscription",
      // A past renewal date means we're mid-dunning; promising access "until"
      // a day that has already gone would be nonsense.
      description:
        sub?.renewsAt && sub.renewsAt > nowMs
          ? `Keep ${name} until ${formatBillingDate(sub.renewsAt)}, then stop`
          : "Stop future payments — nothing is deleted",
      actionLabel: "Cancel",
      target: "portal",
      tone: "quiet",
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Billing"
        title="Plan & payment"
        subtitle="Your plan, your card, and what you've used this period."
      />

      {/* Something needs the user's attention — and the button that fixes it
          sits inside the same banner, not three scrolls away. */}
      {alert && (
        <div
          role="alert"
          className={cn(
            "flex flex-col gap-3 rounded-2xl border px-4 py-4 sm:flex-row sm:items-center sm:justify-between",
            alert.tone === "danger"
              ? "border-rose-400/30 bg-rose-500/[0.06] text-rose-100"
              : "border-amber-400/30 bg-amber-500/[0.06] text-amber-100"
          )}
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold">{alert.title}</p>
              <p className="mt-0.5 text-xs opacity-90">{alert.body}</p>
            </div>
          </div>
          <div className="shrink-0 sm:pl-4">
            {alert.action === "upgrade" ? (
              <CheckoutButton
                plan={tier === "creator" ? "creator" : "pro"}
                label={alert.actionLabel}
                variant="ghost"
              />
            ) : (
              <Button
                variant="ghost"
                size="md"
                onClick={() => void portal.open(alert.action as BillingActionTarget)}
                disabled={portal.pending !== null}
              >
                {portal.pending === alert.action ? "Opening…" : alert.actionLabel}
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* ── Plan + next payment ─────────────────────────────────────────── */}
        <section className="glass relative overflow-hidden rounded-2xl p-6 lg:col-span-3">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-12 right-0 h-32 w-48 bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.25),transparent_60%)] blur-2xl"
          />

          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-200">
              <Sparkles size={11} />
              {name}
            </span>
            {/* Only when the status carries information. On Free the badge to
                the left already says "Free" — a grey "• Free" beside it is a
                second chip that answers nothing. */}
            {summary.statusTone !== "neutral" && (
              <StatusChip label={summary.statusLabel} tone={summary.statusTone} />
            )}
          </div>

          <div className="mt-4 flex items-baseline gap-1.5">
            <span className="font-display text-4xl font-semibold tracking-tight text-white">
              {copy.price}
            </span>
            <span className="text-sm text-fog">/ {copy.cadence}</span>
          </div>

          {/* The single fact people open this page to check. */}
          <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-fog">
                  <CalendarClock size={12} />
                  {summary.chargeLabel}
                </div>
                <div className="mt-1.5 font-display text-lg font-semibold tracking-tight text-white">
                  {mounted ? chargeHeadline : "—"}
                </div>
              </div>
              {mounted && countdown && (
                <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-fog">
                  {countdown}
                </span>
              )}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-fog">{summary.chargeNote}</p>
          </div>

          <div className="mt-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fog">
              What&apos;s included
            </h2>
            <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {copy.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-white/85">
                  <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-violet-500/20 text-violet-300">
                    <Check size={10} />
                  </span>
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Payment & invoices ──────────────────────────────────────────── */}
        <section className="glass flex flex-col rounded-2xl p-5 lg:col-span-2">
          <header className="flex items-center justify-between gap-2 px-1">
            <h2 className="text-sm font-semibold text-white">Payment &amp; invoices</h2>
            <span className="inline-flex items-center gap-1 text-[11px] text-fog">
              <Lock size={11} />
              Secure
            </span>
          </header>

          {summary.hasBillingRecord && rows.length > 0 ? (
            <div className="mt-3">
              {rows.map((row, i) => (
                <BillingActionRow
                  key={row.key}
                  icon={row.icon}
                  title={row.title}
                  description={row.description}
                  actionLabel={row.actionLabel}
                  tone={row.tone}
                  loading={portal.pending === row.target}
                  disabled={portal.pending !== null && portal.pending !== row.target}
                  onClick={() => void portal.open(row.target)}
                  className={i > 0 ? "mt-1 border-t border-white/[0.06] pt-3.5" : undefined}
                />
              ))}
            </div>
          ) : (
            // Free plan (and the rare manually-granted one): no card exists,
            // so no portal button is offered — it would 404. Instead, answer
            // the question someone on this card is actually asking: what
            // happens to my money if I upgrade?
            //
            // Centred rather than top-aligned: this branch is ~150px shorter
            // than the plan card beside it, and pinning it to the top opens a
            // hollow band above the footnote.
            <div className="flex flex-1 flex-col justify-center px-1 py-4">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white">
                  <CreditCard size={16} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">
                    {summary.hasBillingRecord ? "No actions available" : "No card on file"}
                  </p>
                  <p className="text-xs text-fog">
                    {tier === "free" ? "Nothing is charged on the Free plan." : "Billing is managed off-platform."}
                  </p>
                </div>
              </div>
              {tier === "free" && (
                <ul className="mt-4 space-y-2">
                  {[
                    "Add a card only when you upgrade",
                    "Cancel or switch plans in two clicks",
                    "Receipts emailed after every payment",
                  ].map((line) => (
                    <li key={line} className="flex items-start gap-2 text-xs text-fog">
                      <Check size={12} className="mt-0.5 shrink-0 text-violet-300" />
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {portal.error && (
            <p className="mt-3 px-1 text-[11px] text-rose-300" role="alert">
              {portal.error}
            </p>
          )}

          <p className="mt-auto px-1 pt-5 text-[11px] leading-relaxed text-fog">
            Payments are handled by Lemon Squeezy, our merchant of record. These links open in your
            browser — Framevo never sees or stores your card details.
          </p>
        </section>
      </div>

      {/* ── Usage ─────────────────────────────────────────────────────────── */}
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight text-white">
              Usage this period
            </h2>
            <p className="mt-0.5 text-sm text-fog">
              Allowances included with {name}. They refill automatically.
            </p>
          </div>
          <Button href="/dashboard/exports" variant="subtle" size="sm">
            Export history
          </Button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <UsageMeter
            label={tier === "free" ? "Cloud exports" : "Cloud export minutes"}
            valueText={`${cloudUsed} / ${cloudCapped ? `${cloudLimit}${cloudUnit}` : "∞"}`}
            fraction={cloudCapped ? cloudUsed / Math.max(1, cloudLimit) : 1}
            tone={band(cloudUsed, cloudLimit)}
            note={
              !cloudCapped
                ? "Included with your plan"
                : cloudRemaining > 0
                  ? `${cloudRemaining}${cloudUnit} left`
                  : tier === "free"
                    ? "Cap reached — Pro adds 150 minutes"
                    : "Cap reached — upgrade for more minutes"
            }
            resetNote={monthResets ? `Resets ${monthResets}` : null}
            loading={!mounted || cloud.loading}
          />

          <UsageMeter
            label="Auto-caption minutes"
            valueText={`${captions.usedMinutes} / ${captions.allowanceMinutes} min`}
            fraction={captions.usedMinutes / Math.max(1, captions.allowanceMinutes)}
            tone={band(captions.usedMinutes, captions.allowanceMinutes)}
            note={
              captions.remainingMinutes > 0
                ? `${captions.remainingMinutes} min left`
                : "Cap reached — upgrade for more caption minutes"
            }
            resetNote={captionResets ? `Resets ${captionResets}` : null}
            loading={!mounted || captions.loading}
          />

          <UsageMeter
            label="Storage"
            valueText={`${fmtBytes(storage.usedBytes)} / ${fmtBytes(storage.limitBytes)}`}
            fraction={storage.fraction}
            tone={band(storage.usedBytes, storage.limitBytes)}
            note={`${storagePct}% used · ${storage.projectCount} project${
              storage.projectCount === 1 ? "" : "s"
            }`}
            // Storage is a running total, not a monthly allowance — claiming a
            // reset date here would be a lie.
            resetNote={null}
            loading={!mounted || storage.loading}
          />
        </div>
      </section>

      {/* ── Upgrade ───────────────────────────────────────────────────────── */}
      {upgrade && (
        <section className="glass relative overflow-hidden rounded-2xl p-6">
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-16 -right-8 h-40 w-64 bg-[radial-gradient(ellipse_at_bottom_right,rgba(139,92,246,0.22),transparent_65%)] blur-2xl"
          />
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <Sparkles size={12} className="text-violet-300" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-200">
                  Upgrade
                </span>
              </div>
              <h2 className="mt-2 font-display text-lg font-semibold tracking-tight text-white">
                {upgrade.name} — {upgrade.copy.price}/{upgrade.copy.cadence}
              </h2>
              <p className="mt-1 text-sm text-fog">{upgrade.copy.tagline}</p>
              {upgrade.deltas.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
                  {upgrade.deltas.slice(0, 4).map((f) => (
                    <li key={f} className="flex items-center gap-1.5 text-xs text-white/85">
                      <Check size={11} className="shrink-0 text-violet-300" />
                      {f}
                    </li>
                  ))}
                  {upgrade.deltas.length > 4 && (
                    <li className="text-xs text-fog">+{upgrade.deltas.length - 4} more</li>
                  )}
                </ul>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <CheckoutButton
                plan={upgrade.plan}
                label={`Upgrade to ${upgrade.name}`}
                variant="primary"
              />
              <ComparePlansLink />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
