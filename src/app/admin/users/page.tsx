"use client";

/**
 * Admin → Users.
 *
 * Previously a bare table with no aggregates at all. It now reports total,
 * new, plan distribution and activity — every figure derived from the same scan
 * that feeds the table.
 *
 * "Active" is explicitly labelled as event-derived. `UserDoc` has no last-seen
 * field, so the only real activity signal is a tracked event in
 * `analyticsEvents`; the card says so rather than implying a session count.
 */

import { Users as UsersIcon, UserPlus, Activity, CreditCard } from "lucide-react";
import { MetricCard, MetricGrid } from "@/components/admin/MetricCard";
import { SectionCard } from "@/components/admin/AdminCard";
import { DataTable, CellStack, type Column } from "@/components/admin/DataTable";
import { BarList, AreaChart, type DayPoint, type Slice } from "@/components/admin/Charts";
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
import { fmtDate, fmtNum, fmtPctValue, fmtRelative, truncateMiddle } from "@/components/admin/format";

interface UserRow {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  plan: string;
  createdAt: number;
  updatedAt: number;
  activeInWindow: boolean;
}

interface UserSummary {
  byPlan: Record<string, number>;
  byPlanSlices: Slice[];
  total: number;
  paid: number;
  free: number;
  newInRange: number;
  newLast7d: number;
  activeWithEvents: number;
  conversionPct: number;
  activityTruncated: boolean;
  perDay: DayPoint[];
}

const PLAN_OPTIONS = [
  { value: "free", label: "Free" },
  { value: "pro", label: "Pro" },
  { value: "creator", label: "Creator" },
];

export default function AdminUsersPage() {
  const q = useAdminListPage<AdminListResponse<UserRow, UserSummary>>("/api/admin/users");
  const d = q.data;
  const s = d?.summary;

  const columns: Column<UserRow>[] = [
    {
      key: "user",
      header: "User",
      render: (r) => (
        <CellStack
          primary={r.displayName || r.email || "Unnamed account"}
          secondary={r.email && r.displayName ? r.email : truncateMiddle(r.uid, 10, 6)}
          title={r.email ?? r.uid}
        />
      ),
    },
    {
      key: "plan",
      header: "Plan",
      render: (r) => <span className="capitalize text-text-secondary">{r.plan}</span>,
    },
    {
      key: "active",
      header: "Active in range",
      align: "center",
      hideOnMobile: true,
      render: (r) =>
        r.activeInWindow ? (
          <span className="text-emerald-300">Yes</span>
        ) : (
          <span className="text-text-muted">No</span>
        ),
    },
    { key: "uid", header: "UID", mono: true, hideOnMobile: true, render: (r) => truncateMiddle(r.uid, 8, 6) },
    { key: "created", header: "Signed up", align: "right", render: (r) => fmtDate(r.createdAt) },
    {
      key: "updated",
      header: "Profile updated",
      align: "right",
      hideOnMobile: true,
      render: (r) => fmtRelative(r.updatedAt),
    },
  ];

  return (
    <PageFrame
      title="Users"
      subtitle="Accounts, plan mix and signup trend."
      state={{ ...q, hasData: Boolean(d) }}
      truncated={d?.truncated}
      scanned={d?.scanned}
      toolbar={
        <Toolbar>
          <SearchInput
            value={q.search}
            onChange={q.setSearch}
            label="Search users by email, name or uid"
            placeholder="Email, name, uid…"
          />
          <FilterSelect
            value={q.status}
            onChange={q.setStatus}
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
              label="Total users"
              value={fmtNum(s.total)}
              sub="all accounts, all time"
              icon={<UsersIcon size={15} />}
              tone="accent"
            />
            <MetricCard
              label="New in range"
              value={fmtNum(s.newInRange)}
              sub={`${fmtNum(s.newLast7d)} in the last 7 days`}
              icon={<UserPlus size={15} />}
            />
            <MetricCard
              label="Active in range"
              value={fmtNum(s.activeWithEvents)}
              sub="users with a tracked event"
              icon={<Activity size={15} />}
              caveat={
                s.activityTruncated
                  ? "Activity scan hit its cap — this is a minimum."
                  : "Derived from analytics events; Firestore stores no last-seen field."
              }
            />
            <MetricCard
              label="Paid users"
              value={fmtNum(s.paid)}
              sub={`${fmtPctValue(s.conversionPct)} of all accounts`}
              icon={<CreditCard size={15} />}
              tone="good"
            />
          </MetricGrid>

          <ChartGrid>
            <SectionCard
              title="Signups per day"
              total={fmtNum(s.newInRange)}
              subtitle="Accounts created inside the selected range."
            >
              <AreaChart data={s.perDay} label="User signups per day" />
            </SectionCard>
            <SectionCard
              title="Plan distribution"
              total={fmtNum(s.total)}
              subtitle="Current entitlement from users.plan — Billing reports subscription status."
            >
              <BarList data={s.byPlanSlices} total={s.total} />
            </SectionCard>
          </ChartGrid>

          {d.rows.length === 0 ? (
            <EmptyPanel
              label="No users match these filters"
              hint="Search matches email, display name and uid."
            />
          ) : (
            <>
              <DataTable
                caption="All user accounts, newest first"
                columns={columns}
                rows={d.rows}
                rowKey={(r) => r.uid}
                minWidth={860}
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
