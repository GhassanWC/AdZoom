"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Tag, type TagTone } from "@/components/admin/Tag";
import { FilterSelect } from "@/components/admin/FilterSelect";
import { LoadingPanel, ErrorPanel, EmptyPanel } from "@/components/admin/StatePanels";
import { useAdminApi } from "@/components/admin/useAdminApi";
import { fmtRelative, truncateMiddle } from "@/components/admin/format";

interface ErrorRow {
  kind: "analysis" | "export" | "client";
  uid: string;
  ref: string;
  message: string;
  errorKind: string | null;
  at: number;
  context: Record<string, unknown>;
}

interface ErrorsResponse {
  rows: ErrorRow[];
}

const KIND_TONE: Record<ErrorRow["kind"], TagTone> = {
  analysis: "violet",
  export: "cyan",
  client: "rose",
};

const FILTER_OPTIONS = [
  { value: "analysis", label: "Analysis errors" },
  { value: "export", label: "Export errors" },
  { value: "client", label: "Client errors" },
];

export default function AdminErrorsPage() {
  const [filter, setFilter] = React.useState("");
  const { data, loading, error } = useAdminApi<ErrorsResponse>("/api/admin/errors", {
    filter: filter || undefined,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Errors & diagnostics"
        subtitle="Failed analyses, failed exports and client errors."
        action={
          <FilterSelect
            value={filter}
            onChange={setFilter}
            options={FILTER_OPTIONS}
            allLabel="All errors"
            ariaLabel="Filter errors"
          />
        }
      />

      {loading && !data ? (
        <LoadingPanel label="Loading errors…" />
      ) : error ? (
        <ErrorPanel message={error} />
      ) : !data || data.rows.length === 0 ? (
        <EmptyPanel label="No errors 🎉" />
      ) : (
        <div className="space-y-2.5">
          {data.rows.map((row, i) => (
            <GlassCard key={`${row.kind}-${row.ref}-${i}`} padded={false} className="p-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-rose-400/20 bg-rose-500/10 text-rose-300">
                  <AlertTriangle size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag label={row.kind} tone={KIND_TONE[row.kind]} />
                    {row.errorKind && <Tag label={row.errorKind} tone="amber" />}
                    <span className="text-xs text-fog">{fmtRelative(row.at)}</span>
                  </div>
                  <p className="mt-1.5 break-words text-sm text-white/90">{row.message}</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-fog">
                    {row.uid && <span title={row.uid}>user {truncateMiddle(row.uid, 8, 4)}</span>}
                    {row.ref && <span title={row.ref}>ref {truncateMiddle(row.ref, 8, 4)}</span>}
                  </div>
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
