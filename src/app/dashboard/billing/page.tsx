import { Check, Sparkles, CreditCard } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/Button";

const usage = [
  { label: "Storage", value: 4.2, max: 10, unit: "GB", accent: "violet" },
  { label: "Exports this month", value: 23, max: 100, unit: "", accent: "cyan" },
];

const billingHistory = [
  { date: "May 1, 2026", amount: "$19.00", desc: "Pro plan — monthly", status: "Paid" },
  { date: "Apr 1, 2026", amount: "$19.00", desc: "Pro plan — monthly", status: "Paid" },
  { date: "Mar 1, 2026", amount: "$19.00", desc: "Pro plan — monthly", status: "Paid" },
  { date: "Feb 1, 2026", amount: "$19.00", desc: "Pro plan — monthly", status: "Paid" },
  { date: "Jan 1, 2026", amount: "$19.00", desc: "Pro plan — monthly", status: "Paid" },
  { date: "Dec 1, 2025", amount: "$19.00", desc: "Pro plan — monthly", status: "Paid" },
];

export default function BillingPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Billing"
        title="Plan & usage"
        subtitle="Your plan and a snapshot of this month's activity."
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Plan card */}
        <div className="glass relative overflow-hidden rounded-2xl p-6 lg:col-span-1">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-12 right-0 h-32 w-48 bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.25),transparent_60%)] blur-2xl"
          />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-200">
            <Sparkles size={11} />
            Pro
          </span>
          <div className="mt-4 flex items-baseline gap-1.5">
            <span className="font-display text-4xl font-semibold tracking-tight text-white">$19</span>
            <span className="text-sm text-fog">/ month</span>
          </div>
          <p className="mt-1 text-sm text-fog">Renews June 1, 2026</p>

          <ul className="mt-5 space-y-2">
            {["Unlimited exports", "4K + 60fps", "No watermark", "Priority queue"].map((f) => (
              <li key={f} className="flex items-center gap-2 text-sm text-white/85">
                <span className="inline-flex size-4 items-center justify-center rounded-full bg-violet-500/20 text-violet-300">
                  <Check size={10} />
                </span>
                {f}
              </li>
            ))}
          </ul>

          <div className="mt-6 flex gap-2">
            <Button variant="primary" size="sm" className="flex-1">
              Upgrade to Creator
            </Button>
            <Button variant="ghost" size="sm">
              Manage
            </Button>
          </div>
        </div>

        {/* Usage meters */}
        <div className="grid grid-cols-1 gap-5 lg:col-span-2 sm:grid-cols-2">
          {usage.map((u) => {
            const pct = Math.round((u.value / u.max) * 100);
            return (
              <div key={u.label} className="glass rounded-2xl p-6">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white">{u.label}</span>
                  <span className="font-mono text-xs text-fog">
                    {u.value}
                    {u.unit && ` ${u.unit}`} / {u.max}
                    {u.unit && ` ${u.unit}`}
                  </span>
                </div>
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={
                      u.accent === "violet"
                        ? "h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400"
                        : "h-full rounded-full bg-gradient-to-r from-cyan-400 to-violet-500"
                    }
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-2 text-[11px] text-fog">{pct}% used this cycle</div>
              </div>
            );
          })}

          {/* Payment method */}
          <div className="glass rounded-2xl p-6 sm:col-span-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white">
                  <CreditCard size={16} />
                </span>
                <div>
                  <div className="text-sm font-medium text-white">Visa •••• 4242</div>
                  <div className="text-xs text-fog">Expires 04/29</div>
                </div>
              </div>
              <Button variant="ghost" size="sm">
                Update
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Billing history */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-white">Billing history</h3>
        <div className="glass overflow-hidden rounded-2xl">
          {billingHistory.map((row, i) => (
            <div
              key={row.date}
              className={
                i !== billingHistory.length - 1
                  ? "flex flex-wrap items-center gap-3 border-b border-white/[0.04] px-5 py-3.5 text-sm"
                  : "flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm"
              }
            >
              <span className="w-28 shrink-0 text-fog">{row.date}</span>
              <span className="min-w-0 flex-1 text-white">{row.desc}</span>
              <span className="font-mono text-sm tabular-nums text-white/90">{row.amount}</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                {row.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
