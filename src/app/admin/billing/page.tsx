"use client";

/**
 * Admin → Billing.
 *
 * Revenue here is LIST-PRICE MRR and is labelled as such everywhere it appears.
 * `Subscription` stores no monetary amount — no charged price, currency,
 * discount or proration — so plan tier × public price is the only revenue figure
 * the data supports. The footnote on the card states the basis explicitly rather
 * than presenting an estimate as booked revenue.
 *
 * Two correctness fixes carried from the audit:
 *  • Trials no longer count toward MRR (they had been billed at full price).
 *  • `paused` / `unpaid` / `expired` are reported distinctly instead of being
 *    lumped into a single "cancelled" number.
 */

import * as React from "react";
import { DollarSign, CreditCard, TrendingUp, UserMinus } from "lucide-react";
import { MetricCard, MetricGrid } from "@/components/admin/MetricCard";
import { SectionCard } from "@/components/admin/AdminCard";
import { DataTable, CellStack, type Column } from "@/components/admin/DataTable";
import { BarList, AreaChart, StatusDot, type DayPoint, type Slice } from "@/components/admin/Charts";
import { Pagination } from "@/components/admin/Pagination";
import { PageFrame, ChartGrid } from "@/components/admin/PageFrame";
import { EmptyPanel } from "@/components/admin/StatePanels";
import {
  Toolbar,
  SearchInput,
  FilterSelect,
  DateRangeFilter,
  RefreshButton,
} from "@/components/admin/Toolbar";
import { useAdminListPage, type AdminListResponse } from "@/components/admin/useAdminListPage";
import { fmtDate, fmtNum, fmtPctValue, fmtUsd, truncateMiddle } from "@/components/admin/format";

interface SubscriptionRow {
  uid: string;
  plan: string;
  status: string;
  monthlyUsd: number;
  renewsAt: number | null;
  endsAt: number | null;
  lastPaymentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface BillingSummary {
  byStatus: Record<string, number>;
  byStatusSlices: Slice[];
  byPlan: Slice[];
  activeSubscriptions: number;
  trialing: number;
  pastDue: number;
  cancelled: number;
  paused: number;
  expired: number;
  unpaid: number;
  listPriceMrr: number;
  listPriceArr: number;
  totalUsers: number;
  paidUsers: number;
  freeUsers: number;
  conversionPct: number;
  newInRange: number;
  revenueBasis: {
    planMonthlyUsd: Record<string, number>;
    revenueStatuses: string[];
    activeStatuses: string[];
  };
  perDay: DayPoint[];
}

const STATUS_OPTIONS = [
  "active",
  "on_trial",
  "past_due",
  "paused",
  "unpaid",
  "cancelled",
  "expired",
].map((s) => ({ value: s, label: s.replace(/_/g, " ") }));

const PLAN_OPTIONS = [
  { value: "pro", label: "Pro" },
  { value: "creator", label: "Creator" },
];

export default function AdminBillingPage() {
  const [plan, setPlan] = React.useState("");
  const q = useAdminListPage<AdminListResponse<SubscriptionRow, BillingSummary>>(
    "/api/admin/billing",
    { extraParams: { plan: plan || undefined } }
  );
  const d = q.data;
  const s = d?.summary;

  const priceBasis = s
    ? Object.entries(s.revenueBasis.planMonthlyUsd)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k} $${v}`)
        .join(" · ")
    : "";

  const columns: Column<SubscriptionRow>[] = [
    {
      key: "user",
      header: "Subscriber",
      render: (r) => (
        <CellStack primary={truncateMiddle(r.uid, 10, 6)} secondary={r.plan} title={r.uid} />
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusDot status={r.status} /> },
    {
      key: "mrr",
      header: "Monthly",
      align: "right",
      render: (r) => (r.monthlyUsd > 0 ? fmtUsd(r.monthlyUsd) : "—"),
    },
    {
      key: "lastPayment",
      header: "Last payment",
      align: "right",
      hideOnMobile: true,
      render: (r) => fmtDate(r.lastPaymentAt),
    },
    {
      key: "renews",
      header: "Renews",
      align: "right",
      hideOnMobile: true,
      render: (r) => fmtDate(r.renewsAt),
    },
    {
      key: "ends",
      header: "Ends",
      align: "right",
      hideOnMobile: true,
      render: (r) => fmtDate(r.endsAt),
    },
    { key: "updated", header: "Updated", align: "right", render: (r) => fmtDate(r.updatedAt) },
  ];

  return (
    <PageFrame
      title="Billing"
      subtitle="Subscriptions, plan mix and list-price revenue."
      state={{ ...q, hasData: Boolean(d) }}
      truncated={d?.truncated}
      scanned={d?.scanned}
      toolbar={
        <Toolbar>
          <SearchInput
            value={q.search}
            onChange={q.setSearch}
            label="Search subscriptions by uid, plan or status"
            placeholder="UID, plan, status…"
          />
          <FilterSelect
            value={q.status}
            onChange={q.setStatus}
            options={STATUS_OPTIONS}
            allLabel="All statuses"
            label="Filter by subscription status"
          />
          <FilterSelect
            value={plan}
            onChange={setPlan}
            options={PLAN_OPTIONS}
            allLabel="All plans"
            label="Filter by plan"
          />
          <DateRangeFilter
            range={q.range}
            from={q.from}
            to={q.to}
            onRangeChange={q.setRange}
            onFromChange={q.setFrom}
            onToChange={q.setTo}
          />
          <RefreshButton onClick={q.refresh} busy={q.isRefreshing} updatedAt={q.updatedAt} />
        </Toolbar>
      }
    >
      {d && s && (
        <>
          <MetricGrid>
            <MetricCard
              label="Est. MRR (list price)"
              value={fmtUsd(s.listPriceMrr)}
              sub={`${fmtUsd(s.listPriceArr)} annualized`}
              icon={<DollarSign size={15} />}
              tone="good"
              caveat={`Plan price × active subs (${priceBasis}). Excludes trials; Firestore stores no charged amount.`}
            />
            <MetricCard
              label="Active subscriptions"
              value={fmtNum(s.activeSubscriptions)}
              sub={`${fmtNum(s.trialing)} trialing · ${fmtNum(s.pastDue)} past due`}
              icon={<CreditCard size={15} />}
            />
            <MetricCard
              label="Conversion"
              value={fmtPctValue(s.conversionPct)}
              sub={`${fmtNum(s.paidUsers)} paid of ${fmtNum(s.totalUsers)} accounts`}
              icon={<TrendingUp size={15} />}
              tone="accent"
            />
            <MetricCard
              label="Ended"
              value={fmtNum(s.cancelled + s.expired)}
              sub={`${fmtNum(s.cancelled)} cancelled · ${fmtNum(s.expired)} expired · ${fmtNum(s.paused)} paused`}
              icon={<UserMinus size={15} />}
              tone={s.cancelled > 0 ? "warn" : "default"}
            />
          </MetricGrid>

          <ChartGrid>
            <SectionCard
              title="New subscriptions per day"
              total={fmtNum(s.newInRange)}
              subtitle="Subscription records created inside the selected range."
            >
              <AreaChart data={s.perDay} label="New subscriptions per day" />
            </SectionCard>
            <SectionCard
              title="Subscription status"
              total={fmtNum(d.windowTotal)}
              subtitle="Every subscription record, by lifecycle state."
            >
              <BarList data={s.byStatusSlices} total={d.windowTotal} colorByStatus />
            </SectionCard>
          </ChartGrid>

          <ChartGrid>
            <SectionCard
              title="Paid plan mix"
              total={fmtNum(s.activeSubscriptions)}
              subtitle="Among subscriptions that currently grant access."
            >
              <BarList data={s.byPlan} total={s.activeSubscriptions} />
            </SectionCard>
            <SectionCard
              title="Account split"
              total={fmtNum(s.totalUsers)}
              subtitle="From users.plan — the same source the Users page reports."
            >
              <BarList
                data={[
                  { label: "free", value: s.freeUsers },
                  { label: "paid", value: s.paidUsers },
                ]}
                total={s.totalUsers}
              />
            </SectionCard>
          </ChartGrid>

          {d.rows.length === 0 ? (
            <EmptyPanel
              label="No subscriptions match these filters"
              hint="Only users who have subscribed at least once have a record here."
            />
          ) : (
            <>
              <DataTable
                caption="Subscription records, most recently updated first"
                columns={columns}
                rows={d.rows}
                rowKey={(r) => r.uid}
                minWidth={900}
              />
              <Pagination
                page={d.page}
                pageCount={d.pageCount}
                pageSize={d.pageSize}
                total={d.filteredTotal}
                onPageChange={q.setPage}
                onPageSizeChange={q.setPageSize}
              />
            </>
          )}
        </>
      )}
    </PageFrame>
  );
}
