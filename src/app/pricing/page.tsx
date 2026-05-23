import Link from "next/link";
import { Check, Sparkles, Crown, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CheckoutButton } from "@/components/billing/CheckoutButton";

export const metadata = {
  title: "Pricing — AdZoom",
  description: "Pick a plan to unlock cinematic AI editing, HD/4K exports, and premium presets.",
};

const FREE_FEATURES = [
  "5 exports per month",
  "1080p exports",
  "Watermark on exports",
  "Basic AI analysis",
  "5 GB project storage",
  "Limited cinematic presets",
];

const CREATOR_FEATURES = [
  "Unlimited recordings",
  "No watermark on exports",
  "HD (1080p) exports",
  "Advanced AI timeline balancing",
  "Attention-aware editing",
  "Cinematic zoom presets",
  "Smart focus engine",
  "AI narrative chapters",
  "Custom intensity tuning",
  "Cursor enhancement",
  "50 GB project storage",
];

const PRO_FEATURES = [
  "Everything in Creator",
  "4K exports",
  "Team workspace support",
  "Shared & brand presets",
  "Advanced AI editing modes",
  "Priority rendering",
  "Batch export",
  "Collaboration-ready structure",
  "Future API & webhook support",
  "500 GB project storage",
];

export default function PricingPage() {
  return (
    <main className="relative min-h-screen px-4 pb-24 pt-20 sm:pt-28">
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
          AdZoom turns raw screen recordings into polished, attention-aware
          edits. Start free; upgrade when you want premium exports, advanced
          AI, or to bring your team along.
        </p>
      </div>

      <div className="mx-auto mt-12 grid max-w-6xl grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Free */}
        <PlanCard
          name="Free"
          price="$0"
          cadence="forever"
          tagline="Try the product — see the AI editing value first-hand."
          features={FREE_FEATURES}
          icon={<Sparkles size={14} />}
          cta={
            <Button variant="ghost" size="md" href="/login">
              Start free
            </Button>
          }
        />

        {/* Creator — featured */}
        <PlanCard
          name="Creator"
          price="$15"
          cadence="month"
          tagline="For creators, indie hackers, tutorial makers, and SaaS demos."
          features={CREATOR_FEATURES}
          icon={<Crown size={14} />}
          featured
          cta={<CheckoutButton plan="creator" label="Start Creator" variant="primary" />}
        />

        {/* Pro */}
        <PlanCard
          name="Pro"
          price="$49"
          cadence="month"
          tagline="For agencies, teams, educators, and SaaS companies."
          features={PRO_FEATURES}
          icon={<Users size={14} />}
          cta={<CheckoutButton plan="pro" label="Start Pro" variant="primary" />}
        />
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
