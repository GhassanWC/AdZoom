"use client";

/**
 * Admin → Overview.
 *
 * Scope is explicit on every card. The old page mixed all-time `count()` values
 * and range-scoped scans in one grid with identical styling — most visibly, it
 * rendered the ALL-TIME exports total as the header figure above a
 * RANGE-SCOPED "Exports per day" chart, two populations under one number that
 * could never agree.
 *
 * Here the range-scoped section and the cumulative "All time" strip are visually
 * and textually separated, and every chart header shows the total of the very
 * array that drew it.
 */

import * as React from "react";
import {
  Users,
  Folder,
  Download,
  Cpu,
  DollarSign,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { MetricCard, MetricGrid } from "@/components/admin/MetricCard";
import { AdminCard, SectionCard, MicroLabel } from "@/components/admin/AdminCard";
import { BarList, AreaChart, type DayPoint, type Slice } from "@/components/admin/Charts";
import { PageFrame, ChartGrid } from "@/components/admin/PageFrame";
import { MetricGridSkeleton, ChartSkeleton } from "@/components/admin/StatePanels";
import { Toolbar, DateRangeFilter, RefreshButton } from "@/components/admin/Toolbar";
import { useAdminQuery, useDebounced } from "@/components/admin/useAdminQuery";
import { fmtNum, fmtPctValue, fmtUsd } from "@/components/admin/format";
import type { RangeKey } from "@/lib/admin/range";

interface Overview {
  range: { fromMs: number; toMs: number; key: RangeKey };
  generatedAt: number;
  users: {
    total: number;
    paid: number;
    free: number;
    newInRange: number;
    byPlan: Slice[];
    conversionPct: number;
    truncated: boolean;
  };
  projects: {
    inRange: number;
    exported: number;
    failed: number;
    perDay: DayPoint[];
    truncated: boolean;
  };
  exports: {
    inRange: number;
    browser: number;
    cloud: number;
    ready: number;
    failed: number;
    watermarked: number;
    perDay: DayPoint[];
    truncated: boolean;
  };
  analysis: {
    inRange: number;
    complete: number;
    failed: number;
    running: number;
    queued: number;
    note: string;
    truncated: boolean;
  };
  events: {
    inRange: number;
    uniqueUsers: number;
    topEvents: Slice[];
    perDay: DayPoint[];
    truncated: boolean;
  };
  billing: {
    activeSubscriptions: number;
    trialing: number;
    pastDue: number;
    cancelled: number;
    listPriceMrr: number;
    truncated: boolean;
  };
  allTime: { users: number | null; projects: number | null; exports: number | null };
  indexBuilding?: boolean;
}

export default function AdminOverviewPage() {
  const [range, setRange] = React.useState<RangeKey>("30d");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const debouncedFrom = useDebounced(from, 400);
  const debouncedTo = useDebounced(to, 400);

  const q = useAdminQuery<Overview>("/api/admin/overview", {
    range,
    from: debouncedFrom || undefined,
    to: debouncedTo || undefined,
  });
  const d = q.data;

  const anyTruncated = Boolean(
    d &&
      (d.users.truncated ||
        d.projects.truncated ||
        d.exports.truncated ||
        d.analysis.truncated ||
        d.events.truncated)
  );

  return (
    <PageFrame
      title="Overview"
      subtitle="Framevo at a glance — scoped to the selected range."
      state={{ ...q, hasData: Boolean(d) }}
      truncated={anyTruncated}
      scanned={4000}
      skeleton={
        <div className="space-y-4">
          <MetricGridSkeleton count={4} />
          <MetricGridSkeleton count={4} />
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <ChartSkeleton />
            <ChartSkeleton />
          </div>
        </div>
      }
      toolbar={
        <Toolbar>
          <DateRangeFilter
            range={range}
            from={from}
            to={to}
            onRangeChange={setRange}
            onFromChange={setFrom}
            onToChange={setTo}
          />
          <RefreshButton onClick={q.refresh} busy={q.isRefreshing} updatedAt={q.updatedAt} />
        </Toolbar>
      }
    >
      {d && (
        <>
          {/* Cumulative totals, clearly separated from everything range-scoped. */}
          <AdminCard pad="sm">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <MicroLabel>All time</MicroLabel>
              <AllTimeStat label="Users" value={d.allTime.users} />
              <AllTimeStat label="Projects" value={d.allTime.projects} />
              <AllTimeStat label="Exports" value={d.allTime.exports} />
              <span className="ml-auto text-[11px] text-text-muted">
                Everything below is scoped to the selected range
              </span>
            </div>
          </AdminCard>

          <MetricGrid>
            <MetricCard
              label="Total users"
              value={fmtNum(d.users.total)}
              sub={`${fmtNum(d.users.newInRange)} new in range`}
              icon={<Users size={15} />}
              tone="accent"
            />
            <MetricCard
              label="Paid users"
              value={fmtNum(d.users.paid)}
              sub={`${fmtPctValue(d.users.conversionPct)} conversion`}
              icon={<DollarSign size={15} />}
              tone="good"
            />
            <MetricCard
              label="Est. MRR (list price)"
              value={fmtUsd(d.billing.listPriceMrr)}
              sub={`${fmtNum(d.billing.activeSubscriptions)} active subs`}
              icon={<DollarSign size={15} />}
              caveat="Plan price × active subs; excludes trials."
            />
            <MetricCard
              label="Projects in range"
              value={fmtNum(d.projects.inRange)}
              sub={`${fmtNum(d.projects.exported)} exported`}
              icon={<Folder size={15} />}
            />
          </MetricGrid>

          <MetricGrid>
            <MetricCard
              label="Exports in range"
              value={fmtNum(d.exports.inRange)}
              sub={`${fmtNum(d.exports.browser)} browser · ${fmtNum(d.exports.cloud)} cloud`}
              icon={<Download size={15} />}
            />
            <MetricCard
              label="Exports ready"
              value={fmtNum(d.exports.ready)}
              sub={`${fmtNum(d.exports.watermarked)} watermarked`}
              icon={<CheckCircle2 size={15} />}
              tone="good"
            />
            <MetricCard
              label="Failures in range"
              value={fmtNum(d.exports.failed + d.analysis.failed)}
              sub={`${fmtNum(d.exports.failed)} export · ${fmtNum(d.analysis.failed)} analysis`}
              icon={<AlertTriangle size={15} />}
              tone={d.exports.failed + d.analysis.failed > 0 ? "bad" : "default"}
            />
            <MetricCard
              label="Analysis jobs"
              value={fmtNum(d.analysis.inRange)}
              sub={`${fmtNum(d.analysis.complete)} complete · ${fmtNum(d.analysis.running)} running`}
              icon={<Cpu size={15} />}
              caveat={d.analysis.note}
            />
          </MetricGrid>

          <ChartGrid>
            <SectionCard
              title="Exports per day"
              total={fmtNum(d.exports.inRange)}
              subtitle="Browser and cloud combined. Bars sum to the total shown."
            >
              <AreaChart data={d.exports.perDay} label="Exports per day" />
            </SectionCard>
            <SectionCard
              title="Projects per day"
              total={fmtNum(d.projects.inRange)}
              subtitle="New recordings created in range."
            >
              <AreaChart data={d.projects.perDay} label="Projects created per day" />
            </SectionCard>
          </ChartGrid>

          <ChartGrid>
            <SectionCard
              title="Product activity"
              total={fmtNum(d.events.inRange)}
              subtitle={`${fmtNum(d.events.uniqueUsers)} distinct users · production events only`}
            >
              <AreaChart data={d.events.perDay} label="Events per day" />
            </SectionCard>
            <SectionCard
              title="Top events"
              total={fmtNum(d.events.inRange)}
              subtitle="What users did most in this range."
            >
              <BarList data={d.events.topEvents} total={d.events.inRange} />
            </SectionCard>
          </ChartGrid>

          <ChartGrid>
            <SectionCard
              title="Plan distribution"
              total={fmtNum(d.users.total)}
              subtitle="Current entitlement across all accounts."
            >
              <BarList data={d.users.byPlan} total={d.users.total} />
            </SectionCard>
            <SectionCard
              title="Subscription health"
              total={fmtNum(d.billing.activeSubscriptions)}
              subtitle="Live subscription states."
            >
              <BarList
                data={[
                  { label: "active", value: d.billing.activeSubscriptions - d.billing.trialing - d.billing.pastDue },
                  { label: "on_trial", value: d.billing.trialing },
                  { label: "past_due", value: d.billing.pastDue },
                  { label: "cancelled", value: d.billing.cancelled },
                ].filter((x) => x.value > 0)}
                colorByStatus
              />
            </SectionCard>
          </ChartGrid>
        </>
      )}
    </PageFrame>
  );
}

/**
 * A cumulative count. `null` means the count aggregation failed — rendered as
 * an em-dash, never as 0.
 */
function AllTimeStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-sm font-semibold tabular-nums text-text-primary">
        {value == null ? "—" : fmtNum(value)}
      </span>
      <span className="text-xs text-text-muted">{label}</span>
    </div>
  );
}
