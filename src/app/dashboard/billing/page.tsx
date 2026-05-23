"use client";

import * as React from "react";
import { AlertTriangle, Check, CreditCard, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { fmtBytes, storageBand, type PlanTier } from "@/lib/usage/plan";
import { subscribeSubscription } from "@/lib/firebase/subscriptions";
import { CheckoutButton } from "@/components/billing/CheckoutButton";
import { ManageSubscriptionButton } from "@/components/billing/ManageSubscriptionButton";
import { cn } from "@/lib/cn";
import type { Subscription } from "@/lib/firebase/schema";

// Exports-this-month is still TODO — no usage tracking on the server yet.
// Keep it mocked but visually muted so it doesn't read as authoritative.
const mockExports = { value: 0, max: 100, unit: "" };

interface PlanCopy {
  price: string;
  cadence: string;
  features: string[];
}

const PLAN_COPY: Record<PlanTier, PlanCopy> = {
  free: {
    price: "$0",
    cadence: "forever",
    features: [
      "5 exports per month",
      "1080p exports",
      "Watermark on exports",
      "Basic AI analysis",
      "5 GB project storage",
    ],
  },
  creator: {
    price: "$15",
    cadence: "month",
    features: [
      "No watermark",
      "Unlimited recordings",
      "HD exports",
      "Advanced AI timeline balancing",
      "Cinematic zoom presets",
      "50 GB project storage",
    ],
  },
  pro: {
    price: "$49",
    cadence: "month",
    features: [
      "Everything in Creator",
      "4K exports",
      "Team workspace support",
      "Brand presets",
      "Priority rendering",
      "500 GB project storage",
    ],
  },
};

function fmtDate(epochMs?: number): string | null {
  if (!epochMs) return null;
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function BillingPage() {
  const { user } = useAuth();
  const storage = useStoragePlan();
  const tier = storage.plan.tier;
  const copy = PLAN_COPY[tier];

  // Live subscription doc — present once the LS webhook has fired at least once.
  const [sub, setSub] = React.useState<Subscription | null>(null);
  React.useEffect(() => {
    if (!user) {
      setSub(null);
      return;
    }
    return subscribeSubscription(user.uid, setSub);
  }, [user]);

  const storageBandKind = storageBand(storage.usedBytes, storage.limitBytes);
  const storagePct = Math.max(1, Math.round(storage.fraction * 100));
  const storageBarClass =
    storageBandKind === "danger"
      ? "bg-gradient-to-r from-rose-500 to-rose-400"
      : storageBandKind === "warn"
        ? "bg-gradient-to-r from-amber-400 to-amber-300"
        : "bg-gradient-to-r from-violet-500 to-cyan-400";

  // Status banner for cancelled / paused / past_due states — keeps the
  // sidebar's plan name authoritative while warning the user something is up.
  const banner = (() => {
    if (!sub) return null;
    if (sub.status === "past_due") {
      return {
        kind: "warn" as const,
        text: "Payment past due — update your card to keep your plan active.",
      };
    }
    if (sub.status === "cancelled" && sub.endsAt) {
      return {
        kind: "warn" as const,
        text: `Subscription cancelled — access ends ${fmtDate(sub.endsAt)}.`,
      };
    }
    if (sub.status === "paused") {
      return {
        kind: "warn" as const,
        text: "Subscription paused. Resume from the customer portal to restore access.",
      };
    }
    if (sub.status === "expired") {
      return {
        kind: "danger" as const,
        text: "Subscription expired. Pick a plan below to restore premium features.",
      };
    }
    return null;
  })();

  // Primary + secondary CTAs depend on the current tier.
  const ctaBlock = (() => {
    if (tier === "free") {
      return (
        <div className="mt-6 flex flex-wrap gap-2">
          <CheckoutButton plan="creator" label="Upgrade to Creator" variant="primary" />
          <CheckoutButton plan="pro" label="Go Pro" variant="ghost" />
        </div>
      );
    }
    if (tier === "creator") {
      return (
        <div className="mt-6 flex flex-wrap gap-2">
          <CheckoutButton plan="pro" label="Upgrade to Pro" variant="primary" />
          <ManageSubscriptionButton variant="ghost" />
        </div>
      );
    }
    return (
      <div className="mt-6 flex flex-wrap gap-2">
        <ManageSubscriptionButton variant="primary" label="Manage subscription" />
      </div>
    );
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Billing"
        title="Plan & usage"
        subtitle="Your plan and a snapshot of this month's activity."
      />

      {banner && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-xl border px-4 py-3 text-sm",
            banner.kind === "danger"
              ? "border-rose-400/30 bg-rose-500/[0.06] text-rose-100"
              : "border-amber-400/30 bg-amber-500/[0.06] text-amber-100"
          )}
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{banner.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Plan card */}
        <div className="glass relative overflow-hidden rounded-2xl p-6 lg:col-span-1">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-12 right-0 h-32 w-48 bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.25),transparent_60%)] blur-2xl"
          />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-200">
            <Sparkles size={11} />
            {storage.plan.name.replace(" plan", "")}
          </span>
          <div className="mt-4 flex items-baseline gap-1.5">
            <span className="font-display text-4xl font-semibold tracking-tight text-white">
              {copy.price}
            </span>
            <span className="text-sm text-fog">/ {copy.cadence}</span>
          </div>
          <p className="mt-1 text-sm text-fog">
            {tier === "free"
              ? "No card on file — upgrade any time."
              : sub?.renewsAt
                ? `Renews ${fmtDate(sub.renewsAt)}`
                : "Active subscription"}
          </p>

          <ul className="mt-5 space-y-2">
            {copy.features.map((f) => (
              <li key={f} className="flex items-center gap-2 text-sm text-white/85">
                <span className="inline-flex size-4 items-center justify-center rounded-full bg-violet-500/20 text-violet-300">
                  <Check size={10} />
                </span>
                {f}
              </li>
            ))}
          </ul>

          {ctaBlock}
        </div>

        {/* Usage meters */}
        <div className="grid grid-cols-1 gap-5 lg:col-span-2 sm:grid-cols-2">
          {/* Storage — live from useStoragePlan */}
          <div className="glass rounded-2xl p-6">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-white">Storage</span>
              <span
                className={cn(
                  "font-mono text-xs tabular-nums",
                  storageBandKind === "danger"
                    ? "text-rose-300"
                    : storageBandKind === "warn"
                      ? "text-amber-200"
                      : "text-fog"
                )}
              >
                {fmtBytes(storage.usedBytes)} / {fmtBytes(storage.limitBytes)}
              </span>
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={cn("h-full rounded-full transition-[width] duration-300", storageBarClass)}
                style={{ width: `${storagePct}%` }}
              />
            </div>
            <div className="mt-2 text-[11px] text-fog">
              {storagePct}% used · {storage.projectCount} project
              {storage.projectCount === 1 ? "" : "s"}
            </div>
          </div>

          {/* Exports — still mock; flagged in code */}
          <div className="glass rounded-2xl p-6 opacity-80">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-white">Exports this month</span>
              <span className="font-mono text-xs text-fog">
                {mockExports.value} / {mockExports.max}
              </span>
            </div>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500"
                style={{ width: `${(mockExports.value / mockExports.max) * 100}%` }}
              />
            </div>
            <div className="mt-2 text-[11px] text-fog">Export tracking coming soon</div>
          </div>

          {/* Payment method — driven by live subscription state */}
          <div className="glass rounded-2xl p-6 sm:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white">
                  <CreditCard size={16} />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white">
                    {tier === "free"
                      ? "No card on file"
                      : sub
                        ? "Payment method managed by Lemon Squeezy"
                        : "Loading payment details…"}
                  </div>
                  <div className="text-xs text-fog">
                    {tier === "free"
                      ? "Add one when you upgrade"
                      : "Update card or cancel via the customer portal"}
                  </div>
                </div>
              </div>
              {tier !== "free" && <ManageSubscriptionButton variant="ghost" label="Open portal" />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
