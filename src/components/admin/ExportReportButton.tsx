"use client";

/**
 * "Download PDF report" — the full admin health & diagnostics report for the
 * range currently selected on the page (see /api/admin/report).
 *
 * The route is admin-gated server-side; this button only lives inside the
 * admin shell. Emails are masked by default, because the PDF is meant to be
 * shared (with a teammate or an AI assistant) — full emails are an explicit,
 * separate choice.
 */

import * as React from "react";
import { ChevronDown, FileDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/firebase/AuthProvider";
import type { RangeKey } from "@/lib/admin/range";

const CONTROL =
  "h-9 rounded-lg border border-border-soft bg-button-bg-soft text-xs text-text-primary transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60";

export function ExportReportButton({
  range,
  from,
  to,
}: {
  range: RangeKey;
  from?: string;
  to?: string;
}) {
  const { getIdToken } = useAuth();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const download = async (includeEmails: boolean) => {
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ range });
      if (from) sp.set("from", from);
      if (to) sp.set("to", to);
      if (includeEmails) sp.set("includeEmails", "1");

      const attempt = async (force: boolean) =>
        fetch(`/api/admin/report?${sp.toString()}`, {
          headers: { Authorization: `Bearer ${(await getIdToken(force)) ?? ""}` },
          cache: "no-store",
        });
      let res = await attempt(false);
      if (res.status === 401) res = await attempt(true);

      const type = res.headers.get("Content-Type") ?? "";
      if (!res.ok || !type.includes("application/pdf")) {
        const body = (await res.json().catch(() => null)) as { error?: string; indexBuilding?: boolean } | null;
        throw new Error(
          body?.indexBuilding
            ? "A database index is still building. Try again in a few minutes."
            : body?.error || `Report failed (${res.status})`
        );
      }

      const blob = await res.blob();
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ??
        `framevo-admin-report-${range}.pdf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Download the full admin report as a PDF"
        className={cn(CONTROL, "inline-flex items-center gap-1.5 px-2.5 disabled:opacity-60")}
      >
        {busy ? <Loader2 size={13} aria-hidden className="animate-spin" /> : <FileDown size={13} aria-hidden />}
        <span>{busy ? "Building report…" : "PDF report"}</span>
        <ChevronDown size={12} aria-hidden className="text-text-muted" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1.5 w-64 overflow-hidden rounded-lg border border-border-soft bg-surface p-1 shadow-xl"
        >
          <MenuItem
            title="Download report"
            sub="Emails masked — safe to share with AI or teammates"
            onSelect={() => download(false)}
          />
          <MenuItem
            title="Download with full emails"
            sub="Contains personal data — internal use only"
            onSelect={() => download(true)}
          />
        </div>
      )}

      {error && (
        <p role="alert" className="absolute right-0 top-full mt-1.5 w-64 rounded-md border border-rose-400/25 bg-rose-500/[0.07] px-2 py-1.5 text-[11px] text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}

function MenuItem({ title, sub, onSelect }: { title: string; sub: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="flex w-full flex-col items-start rounded-md px-2.5 py-2 text-left hover:bg-button-bg-soft focus-visible:bg-button-bg-soft focus-visible:outline-none"
    >
      <span className="text-xs font-medium text-text-primary">{title}</span>
      <span className="text-[11px] text-text-muted">{sub}</span>
    </button>
  );
}
