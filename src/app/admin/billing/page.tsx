"use client";

import * as React from "react";
import { DollarSign, Users, CreditCard, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { MetricCard } from "@/components/admin/MetricCard";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Tag, planTone, statusTone } from "@/components/admin/Tag";
import { BarList } from "@/components/admin/Charts";
import { LoadingPanel, ErrorPanel } from "@/components/admin/StatePanels";
import { useAdminApi } from "@/components/admin/useAdminApi";
import { fmtDate, fmtNum, fmtPct, fmtUsd, truncateMiddle } from "@/components/admin/format";

interface RecentSub {
  uid: string;
  plan: string;
  status: string;
  lastPaymentAt: number;
  updatedAt: number;
}

interface BillingResponse {
  totalUsers: number | null;
  freeUsers: number | null;
  paidUsers: number;
  activeSubscriptions: number;
  cancelledSubscriptions: number;
  mrr: number;
  conversionRate: number;
  planDistribution: Record<string, number>;
  statusDistribution: Record<string, number>;
  recent: RecentSub[];
}

export default function AdminBillingPage() {
  const { data, loading, error } = useAdminApi<BillingResponse>("/api/admin/billing");

  const columns: Column<RecentSub>[] = [
    {
      key: "uid",
      header: "User ID",
      mono: true,
      render: (r) => <span title={r.uid}>{truncateMiddle(r.uid, 10, 4)}</span>,
    },
    { key: "plan", header: "Plan", render: (r) => <Tag label={r.plan} tone={planTone(r.plan)} /> },
    { key: "status", header: "Status", render: (r) => <Tag label={r.status} tone={statusTone(r.status)} /> },
    { key: "payment", header: "Last payment", render: (r) => fmtDate(r.lastPaymentAt) },
    { key: "updated", header: "Updated", align: "right", render: (r) => fmtDate(r.updatedAt) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Admin" title="Billing" subtitle="Subscriptions, revenue and conversion." />

      {loading && !data ? (
        <LoadingPanel label="Loading billing…" />
      ) : error ? (
        <ErrorPanel message={error} />
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="MRR" value={fmtUsd(data.mrr)} icon={<DollarSign size={16} />} tone="good" />
            <MetricCard
              label="Paid users"
              value={fmtNum(data.paidUsers)}
              sub={`${fmtNum(data.activeSubscriptions)} active subs`}
              icon={<CreditCard size={16} />}
            />
            <MetricCard
              label="Free users"
              value={fmtNum(data.freeUsers)}
              sub={`${fmtNum(data.totalUsers)} total`}
              icon={<Users size={16} />}
            />
            <MetricCard
              label="Conversion"
              value={fmtPct(data.conversionRate)}
              sub="free → paid"
              icon={<TrendingUp size={16} />}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <GlassCard>
              <div className="mb-4 text-sm font-medium text-white">Plan distribution</div>
              <BarList
                data={Object.entries(data.planDistribution).map(([label, value]) => ({
                  label,
                  value,
                }))}
              />
            </GlassCard>
            <GlassCard>
              <div className="mb-4 text-sm font-medium text-white">Subscription status</div>
              {Object.keys(data.statusDistribution).length ? (
                <BarList
                  data={Object.entries(data.statusDistribution).map(([label, value]) => ({
                    label,
                    value,
                  }))}
                />
              ) : (
                <div className="grid h-24 place-items-center text-xs text-fog">
                  No subscriptions yet.
                </div>
              )}
            </GlassCard>
          </div>

          <div>
            <div className="mb-3 text-sm font-medium text-white">Recent subscription activity</div>
            {data.recent.length ? (
              <DataTable columns={columns} rows={data.recent} rowKey={(r) => r.uid} minWidth={680} />
            ) : (
              <GlassCard>
                <div className="grid h-24 place-items-center text-xs text-fog">
                  No subscription activity yet.
                </div>
              </GlassCard>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
