"use client";

import * as React from "react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Tag } from "@/components/admin/Tag";
import { FilterSelect } from "@/components/admin/FilterSelect";
import { BarList } from "@/components/admin/Charts";
import { LoadMore } from "@/components/admin/LoadMore";
import {
  LoadingPanel,
  ErrorPanel,
  EmptyPanel,
  IndexBuildingPanel,
} from "@/components/admin/StatePanels";
import { useAdminList } from "@/components/admin/useAdminList";
import { fmtDate, truncateMiddle } from "@/components/admin/format";
import { EVENTS } from "@/lib/analytics/events";

interface EventRow {
  id: string;
  eventName: string;
  userId: string;
  userEmail: string | null;
  projectId: string | null;
  plan: string | null;
  environment: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

interface EventsExtra {
  topEvents: { eventName: string; count: number }[];
}

const EVENT_OPTIONS = Object.values(EVENTS)
  .sort()
  .map((v) => ({ value: v, label: v }));

export default function AdminEventsPage() {
  const [eventName, setEventName] = React.useState("");
  const [userInput, setUserInput] = React.useState("");
  const [userId, setUserId] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setUserId(userInput.trim()), 350);
    return () => clearTimeout(t);
  }, [userInput]);

  const list = useAdminList<EventRow, EventsExtra>("/api/admin/events", {
    eventName: eventName || undefined,
    userId: userId || undefined,
  });

  const columns: Column<EventRow>[] = [
    { key: "time", header: "Time", render: (r) => fmtDate(r.timestamp) },
    {
      key: "event",
      header: "Event",
      render: (r) => <Tag label={r.eventName} tone="violet" />,
    },
    {
      key: "user",
      header: "User",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-white/85">{r.userEmail ?? truncateMiddle(r.userId, 8, 4)}</div>
          {r.plan && <div className="text-xs text-fog">{r.plan}</div>}
        </div>
      ),
    },
    {
      key: "env",
      header: "Env",
      render: (r) => (
        <Tag label={r.environment} tone={r.environment === "production" ? "emerald" : "neutral"} />
      ),
    },
    {
      key: "meta",
      header: "Metadata",
      mono: true,
      render: (r) => {
        const json = JSON.stringify(r.metadata);
        return (
          <span className="text-fog" title={json}>
            {json === "{}" ? "—" : truncateMiddle(json, 28, 6)}
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Events"
        subtitle="Raw app-owned analytics event stream."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              value={eventName}
              onChange={setEventName}
              options={EVENT_OPTIONS}
              allLabel="All events"
              ariaLabel="Filter by event"
            />
            <input
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="Filter by user id…"
              className="h-10 w-44 rounded-full border border-white/10 bg-white/[0.02] px-4 text-sm text-white placeholder:text-fog outline-none focus:border-violet-500/50"
            />
          </div>
        }
      />

      {list.loading ? (
        <LoadingPanel label="Loading events…" />
      ) : list.error ? (
        <ErrorPanel message={list.error} />
      ) : list.indexBuilding ? (
        <IndexBuildingPanel />
      ) : (
        <>
          {list.extra.topEvents && list.extra.topEvents.length > 0 && (
            <GlassCard>
              <div className="mb-4 text-sm font-medium text-white">
                Top events <span className="text-fog">(recent sample)</span>
              </div>
              <BarList
                data={list.extra.topEvents
                  .slice(0, 10)
                  .map((t) => ({ label: t.eventName, value: t.count }))}
              />
            </GlassCard>
          )}

          {list.rows.length === 0 ? (
            <EmptyPanel label="No events match these filters" />
          ) : (
            <>
              <DataTable columns={columns} rows={list.rows} rowKey={(r) => r.id} minWidth={780} />
              <LoadMore
                hasMore={list.hasMore}
                loading={list.loadingMore}
                onClick={list.loadMore}
                count={list.rows.length}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
