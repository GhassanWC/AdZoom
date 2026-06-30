import type { Metadata } from "next";
import Link from "next/link";
import { Check, Sparkles, Crown, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CheckoutButton } from "@/components/billing/CheckoutButton";
import { TrackView } from "@/components/analytics/TrackView";
import { EVENTS } from "@/lib/analytics/events";
import { buildMetadata } from "@/lib/seo";
import { pricingTiers } from "@/lib/mockData";

export const metadata: Metadata = buildMetadata({
  title: "Pricing — Framevo",
  description:
    "Framevo pricing — start free with the full AI editor. Upgrade for more cloud export minutes, 1080p MP4 exports, no watermark, and a priority render queue.",
  path: "/pricing",
});

/** Per-plan icon for the pricing cards (copy lives in `pricingTiers`). */
const PLAN_ICON: Record<string, React.ReactNode> = {
  Free: <Sparkles size={14} />,
  Pro: <Crown size={14} />,
  Creator: <Users size={14} />,
};

export default function PricingPage() {
  return (
    <main className="relative min-h-screen px-4 pb-24 pt-20 sm:pt-28">
      <TrackView event={EVENTS.PRICING_VIEWED} />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-[520px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.22),transparent_65%)] blur-3xl"
      />

      <div className="mx-auto max-w-5xl text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-100">
          <Sparkles size={11} />
          Pricing
        </span>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Cinematic AI editing,{" "}
          <span className="text-violet-300">at every scale.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-fog">
          Framevo turns raw screen recordings into polished, attention-aware
          edits. Start free; upgrade when you want premium exports, advanced
          AI, or to bring your team along.
        </p>
      </div>

      <div className="mx-auto mt-12 grid max-w-6xl grid-cols-1 gap-5 lg:grid-cols-3">
        {pricingTiers.map((tier) => (
          <PlanCard
            key={tier.name}
            name={tier.name}
            price={tier.price}
            cadence={tier.priceUnit}
            tagline={tier.tagline}
            features={tier.features}
            icon={PLAN_ICON[tier.name] ?? <Sparkles size={14} />}
            featured={tier.highlighted}
            cta={
              tier.name === "Pro" ? (
                <CheckoutButton plan="pro" label={tier.cta} variant="primary" />
              ) : tier.name === "Creator" ? (
                <CheckoutButton plan="creator" label={tier.cta} variant="primary" />
              ) : (
                <Button variant="ghost" size="md" href="/login">
                  {tier.cta}
                </Button>
              )
            }
          />
        ))}
      </div>

      <p className="mx-auto mt-10 max-w-xl text-center text-[13px] text-fog">
        Already on a plan?{" "}
        <Link href="/dashboard/billing" className="text-white underline-offset-4 hover:underline">
          Manage your subscription
        </Link>
        . Prices in USD; taxes calculated at checkout.
      </p>
    </main>
  );
}

interface PlanCardProps {
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  features: string[];
  icon: React.ReactNode;
  featured?: boolean;
  cta: React.ReactNode;
}

function PlanCard({
  name,
  price,
  cadence,
  tagline,
  features,
  icon,
  featured,
  cta,
}: PlanCardProps) {
  return (
    <div
      className={
        "glass relative overflow-hidden rounded-3xl p-7 " +
        (featured
          ? "ring-1 ring-violet-400/40 shadow-[0_24px_48px_-24px_rgba(139,92,246,0.55)]"
          : "")
      }
    >
      {featured && (
        <span className="absolute right-5 top-5 inline-flex items-center gap-1 rounded-full border border-violet-300/40 bg-violet-500/20 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-50">
          Most popular
        </span>
      )}
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-200">
        <span className="inline-flex size-6 items-center justify-center rounded-md bg-violet-500/15">
          {icon}
        </span>
        {name}
      </div>
      <div className="mt-5 flex items-baseline gap-1.5">
        <span className="font-display text-5xl font-semibold tracking-tight text-white">
          {price}
        </span>
        <span className="text-sm text-fog">/ {cadence}</span>
      </div>
      <p className="mt-3 max-w-sm text-[13.5px] leading-relaxed text-fog">{tagline}</p>

      <ul className="mt-6 space-y-2.5">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-[13px] text-white/85">
            <span className="mt-[3px] inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-violet-500/20 text-violet-200">
              <Check size={10} />
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-7">{cta}</div>
    </div>
  );
}
