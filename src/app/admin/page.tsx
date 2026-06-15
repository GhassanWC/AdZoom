"use client";

import * as React from "react";
import {
  Users,
  Folder,
  Download,
  Cpu,
  CreditCard,
  DollarSign,
  TrendingUp,
  Activity,
} from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { MetricCard } from "@/components/admin/MetricCard";
import { DateRangeSelector } from "@/components/admin/DateRangeSelector";
import { LineChart, BarList } from "@/components/admin/Charts";
import { LoadingPanel, ErrorPanel } from "@/components/admin/StatePanels";
import { useAdminApi } from "@/components/admin/useAdminApi";
import { fmtNum, fmtPct, fmtUsd } from "@/components/admin/format";
import type { RangeKey } from "@/lib/admin/range";

interface OverviewResponse {
  range: RangeKey;
  generatedAt: number;
  users: {
    total: number | null;
    new: number | null;
    free: number | null;
    creator: number | null;
    pro: number | null;
    conversionRate: number;
  };
  projects: { total: number | null; new: number | null };
  exports: { total: number | null; ready: number | null; failed: number | null };
  analysis: {
    total: number | null;
    complete: number | null;
    failed: number | null;
    running: number | null;
  };
  events: { total: number | null; inRange: number | null };
  subscriptions: { active: number; cancelled: number; creator: number; pro: number };
  mrr: number;
  timeseries: {
    events: { day: string; count: number }[];
    exports: { day: string; count: number }[];
  };
}

export default function AdminOverviewPage() {
  const [range, setRange] = React.useState<RangeKey>("30d");
  const { data, loading, error } = useAdminApi<OverviewResponse>("/api/admin/overview", {
    range,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Overview"
        subtitle="Product, usage and revenue at a glance."
        action={<DateRangeSelector value={range} onChange={setRange} />}
      />

      {loading && !data ? (
        <LoadingPanel label="Crunching metrics…" />
      ) : error ? (
        <ErrorPanel message={error} />
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard
              label="Total users"
              value={fmtNum(data.users.total)}
              sub={`${fmtNum(data.users.new)} new in range`}
              icon={<Users size={16} />}
            />
            <MetricCard
              label="Paid users"
              value={fmtNum(data.subscriptions.active)}
              sub={`${fmtPct(data.users.conversionRate)} conversion`}
              icon={<CreditCard size={16} />}
              tone="good"
            />
            <MetricCard
              label="MRR"
              value={fmtUsd(data.mrr)}
              sub={`${fmtNum(data.subscriptions.creator)} creator · ${fmtNum(data.subscriptions.pro)} pro`}
              icon={<DollarSign size={16} />}
              tone="good"
            />
            <MetricCard
              label="Conversion"
              value={fmtPct(data.users.conversionRate)}
              sub="free → paid"
              icon={<TrendingUp size={16} />}
            />

            <MetricCard
              label="Projects"
              value={fmtNum(data.projects.total)}
              sub={`${fmtNum(data.projects.new)} new in range`}
              icon={<Folder size={16} />}
            />
            <MetricCard
              label="Analyses"
              value={fmtNum(data.analysis.total)}
              sub={`${fmtNum(data.analysis.failed)} failed · ${fmtNum(data.analysis.running)} running`}
              icon={<Cpu size={16} />}
            />
            <MetricCard
              label="Exports"
              value={fmtNum(data.exports.total)}
              sub={`${fmtNum(data.exports.ready)} ready`}
              icon={<Download size={16} />}
            />
            <MetricCard
              label="Failed exports"
              value={fmtNum(data.exports.failed)}
              icon={<Download size={16} />}
              tone={data.exports.failed ? "bad" : "default"}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <GlassCard>
              <ChartHeader title="Events per day" total={data.events.inRange} icon={<Activity size={14} />} />
              {data.timeseries.events.length ? (
                <LineChart data={data.timeseries.events.map((d) => ({ label: d.day, value: d.count }))} />
              ) : (
                <EmptyChart />
              )}
            </GlassCard>
            <GlassCard>
              <ChartHeader title="Exports per day" total={data.exports.total} icon={<Download size={14} />} />
              {data.timeseries.exports.length ? (
                <LineChart data={data.timeseries.exports.map((d) => ({ label: d.day, value: d.count }))} />
              ) : (
                <EmptyChart />
              )}
            </GlassCard>
          </div>

          <GlassCard>
            <div className="mb-4 text-sm font-medium text-white">Plan distribution</div>
            <BarList
              data={[
                { label: "Free", value: data.users.free ?? 0 },
                { label: "Creator", value: data.users.creator ?? 0 },
                { label: "Pro", value: data.users.pro ?? 0 },
              ]}
            />
          </GlassCard>

          <p className="text-right text-[11px] text-fog">
            Updated {new Date(data.generatedAt).toLocaleTimeString("en-US")}
          </p>
        </>
      ) : null}
    </div>
  );
}

function ChartHeader({
  title,
  total,
  icon,
}: {
  title: string;
  total: number | null;
  icon: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm font-medium text-white">
        <span className="text-violet-300">{icon}</span>
        {title}
      </div>
      <span className="font-mono text-xs tabular-nums text-fog">{fmtNum(total)}</span>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="grid h-40 place-items-center text-xs text-fog">No data in this range yet.</div>
  );
}
