"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { DataTable, type Column } from "@/components/admin/DataTable";
import { Tag, planTone } from "@/components/admin/Tag";
import { LoadMore } from "@/components/admin/LoadMore";
import {
  LoadingPanel,
  ErrorPanel,
  EmptyPanel,
  IndexBuildingPanel,
} from "@/components/admin/StatePanels";
import { useAdminList } from "@/components/admin/useAdminList";
import { fmtDate, fmtRelative, truncateMiddle } from "@/components/admin/format";

interface UserRow {
  uid: string;
  email: string | null;
  displayName: string | null;
  plan: string;
  createdAt: number;
  updatedAt: number;
}

export default function AdminUsersPage() {
  const [input, setInput] = React.useState("");
  const [search, setSearch] = React.useState("");

  // Debounce the email search so each keystroke doesn't hit Firestore.
  React.useEffect(() => {
    const t = setTimeout(() => setSearch(input.trim().toLowerCase()), 350);
    return () => clearTimeout(t);
  }, [input]);

  const list = useAdminList<UserRow>("/api/admin/users", { search: search || undefined });

  const columns: Column<UserRow>[] = [
    {
      key: "email",
      header: "Email",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-white/90">{r.email ?? "—"}</div>
          {r.displayName && <div className="truncate text-xs text-fog">{r.displayName}</div>}
        </div>
      ),
    },
    { key: "plan", header: "Plan", render: (r) => <Tag label={r.plan} tone={planTone(r.plan)} /> },
    {
      key: "uid",
      header: "User ID",
      mono: true,
      render: (r) => <span title={r.uid}>{truncateMiddle(r.uid, 8, 4)}</span>,
    },
    { key: "created", header: "Created", render: (r) => fmtDate(r.createdAt) },
    {
      key: "active",
      header: "Last active",
      align: "right",
      render: (r) => <span className="text-fog">{fmtRelative(r.updatedAt)}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Admin" title="Users" subtitle="Everyone who has signed up." />

      <div className="relative max-w-md">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fog" />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search by email (prefix)…"
          className="h-10 w-full rounded-full border border-white/10 bg-white/[0.02] pl-9 pr-4 text-sm text-white placeholder:text-fog outline-none focus:border-violet-500/50 focus-visible:ring-2 focus-visible:ring-violet-500/40"
        />
      </div>

      {list.loading ? (
        <LoadingPanel label="Loading users…" />
      ) : list.error ? (
        <ErrorPanel message={list.error} />
      ) : list.indexBuilding ? (
        <IndexBuildingPanel />
      ) : list.rows.length === 0 ? (
        <EmptyPanel label={search ? "No users match that email" : "No users yet"} />
      ) : (
        <>
          <DataTable columns={columns} rows={list.rows} rowKey={(r) => r.uid} minWidth={720} />
          <LoadMore
            hasMore={list.hasMore}
            loading={list.loadingMore}
            onClick={list.loadMore}
            count={list.rows.length}
          />
        </>
      )}
    </div>
  );
}
