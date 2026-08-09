"use client";

/**
 * One line saying where this computer stands with the cloud, and one button to
 * make it stand somewhere better.
 *
 * WHY A "SYNC NOW" BUTTON EXISTS AT ALL WHEN SYNC IS AUTOMATIC
 * -----------------------------------------------------------
 * Because "it's automatic" is a claim, and a user about to close a laptop and
 * get on a plane has no way to check it. The button does nothing the engine
 * would not have done within a second — it drains the outbox, then wakes the
 * upload worker — but it converts a promise into an observation, which is the
 * only thing that makes a local-first app trustworthy on the way out the door.
 *
 * It is deliberately quiet when there is nothing to say. A permanent green
 * "everything synced" banner is read once and never again.
 */

import * as React from "react";
import { AlertTriangle, Check, CloudOff, RefreshCw } from "lucide-react";
import { useSync } from "@/components/desktop/SyncProvider";
import { cn } from "@/lib/cn";

export function CloudSyncSummary({ className }: { className?: string }) {
  const sync = useSync();
  const [syncing, setSyncing] = React.useState(false);
  const progress = sync.progress;

  if (!sync.available) return null;

  const offline = progress ? !progress.online : false;
  const pending = progress?.pendingOps ?? 0;
  const failed = progress?.failedOps ?? 0;
  const conflicts = progress?.conflictedRecords ?? 0;

  const summary = offline
    ? {
        Icon: CloudOff,
        tone: "border-white/10 bg-white/[0.03] text-fog",
        // Offline is not a failure. Edits are on disk and queued; saying
        // "offline" and nothing more is both true and calm.
        text:
          pending > 0
            ? `Offline — ${pending} ${pending === 1 ? "change" : "changes"} will sync when you reconnect`
            : "Offline — your projects are on this computer",
      }
    : conflicts > 0
      ? {
          Icon: AlertTriangle,
          tone: "border-amber-400/40 bg-amber-400/10 text-amber-200",
          text: `${conflicts} ${conflicts === 1 ? "project needs" : "projects need"} review`,
        }
      : failed > 0
        ? {
            Icon: CloudOff,
            tone: "border-rose-400/40 bg-rose-400/10 text-rose-200",
            text: `${failed} ${failed === 1 ? "change" : "changes"} couldn't be synced`,
          }
        : pending > 0
          ? {
              Icon: RefreshCw,
              tone: "border-violet-400/30 bg-violet-400/10 text-violet-200",
              text: `Syncing ${pending} ${pending === 1 ? "change" : "changes"}…`,
            }
          : {
              Icon: Check,
              tone: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
              text: "Everything is synced",
            };

  const { Icon } = summary;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <span
        role="status"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
          summary.tone
        )}
      >
        <Icon size={11} aria-hidden className={cn("shrink-0", pending > 0 && !offline && "animate-spin")} />
        {summary.text}
      </span>

      <button
        type="button"
        disabled={syncing || offline}
        onClick={async () => {
          setSyncing(true);
          try {
            await sync.syncNow();
          } finally {
            setSyncing(false);
          }
        }}
        title={
          offline
            ? "There's no connection right now. Your changes are saved here and will sync automatically."
            : "Send everything waiting to the cloud now."
        }
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1",
          "text-[11px] font-medium text-white transition-colors duration-150",
          "hover:bg-white/[0.08] focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-400/50",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        <RefreshCw size={11} aria-hidden className={cn("shrink-0", syncing && "animate-spin")} />
        {syncing ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
