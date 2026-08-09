"use client";

import * as React from "react";
import {
  AlertTriangle,
  Check,
  CloudOff,
  CloudUpload,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { SyncStatusSnapshot } from "@/lib/platform/types";

/**
 * Where a project stands with the cloud.
 *
 * Follows `StatusPill`'s shape so it reads as part of the same family, with two
 * deliberate differences:
 *
 *  • EVERY state carries an icon and a word, never a colour alone. Four of the
 *    five states are distinguished by hue in `StatusPill`; here two of them
 *    ("needs review", "sync failed") are things the user must ACT on, and an
 *    accessibility rule this product holds is that nothing important is
 *    signalled by colour only.
 *
 *  • The two actionable states are BUTTONS, not decoration. A badge that says
 *    "Sync failed" and cannot be pressed is a dead end; failure here always
 *    carries the reason and a way forward.
 *
 * `pending` is deliberately calm. An edit made on a plane is the system working
 * exactly as designed, and dressing it in warning colours would teach users to
 * distrust a state they will see constantly.
 */

type Kind = SyncStatusSnapshot["state"];

interface Presentation {
  label: (status: SyncStatusSnapshot) => string;
  Icon: typeof Check;
  className: string;
  dot: string;
  spin?: boolean;
}

const PRESENTATION: Record<Kind, Presentation> = {
  synced: {
    label: () => "Up to date",
    Icon: Check,
    className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    dot: "bg-emerald-400",
  },
  pending: {
    // Counted, because "3 changes waiting" is information and "Pending" is not.
    label: (s) =>
      s.pendingOps > 1 ? `${s.pendingOps} changes waiting` : "1 change waiting",
    Icon: CloudUpload,
    className: "border-white/10 bg-white/[0.03] text-fog",
    dot: "bg-fog",
  },
  syncing: {
    label: () => "Syncing…",
    Icon: RefreshCw,
    className: "border-violet-400/30 bg-violet-400/10 text-violet-300",
    dot: "animate-pulse bg-violet-400",
    spin: true,
  },
  conflict: {
    label: (s) =>
      s.conflicts && s.conflicts.length > 1
        ? `${s.conflicts.length} changes need review`
        : "Needs review",
    Icon: AlertTriangle,
    className: "border-amber-400/40 bg-amber-400/10 text-amber-200",
    dot: "bg-amber-400",
  },
  failed: {
    label: () => "Sync failed",
    Icon: CloudOff,
    className: "border-rose-400/40 bg-rose-400/10 text-rose-200",
    dot: "bg-rose-400",
  },
};

export interface SyncStatusBadgeProps {
  status: SyncStatusSnapshot | null;
  /** Open the conflict resolution sheet. Required for `conflict` to be useful. */
  onReview?: (projectId: string) => void;
  /** Re-arm the parked operations. Required for `failed` to be useful. */
  onRetry?: (projectId: string) => void;
  /**
   * Hide the badge entirely while everything is up to date. Project cards use
   * this — a grid of "Up to date" pills is noise, and the states worth seeing
   * are the other four.
   */
  hideWhenSynced?: boolean;
  className?: string;
}

export function SyncStatusBadge({
  status,
  onReview,
  onRetry,
  hideWhenSynced = false,
  className,
}: SyncStatusBadgeProps) {
  const [retrying, setRetrying] = React.useState(false);

  // No status yet (a project that has never synced, or the port is still
  // answering) is not a state to advertise.
  if (!status) return null;
  if (status.state === "synced" && hideWhenSynced) return null;

  const presentation = PRESENTATION[status.state];
  const { Icon } = presentation;
  const label = presentation.label(status);

  const base = cn(
    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
    presentation.className,
    className
  );

  const content = (
    <>
      <Icon
        size={11}
        aria-hidden
        className={cn("shrink-0", (presentation.spin || retrying) && "animate-spin")}
      />
      {label}
    </>
  );

  if (status.state === "conflict" && onReview) {
    return (
      <button
        type="button"
        onClick={() => onReview(status.entityId)}
        className={cn(
          base,
          "transition-colors duration-150 hover:bg-amber-400/20",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
        )}
        // The label already says "needs review"; this says what pressing it does.
        aria-label={`${label} — review and resolve`}
        title="This project was edited here and on the web. Choose which version to keep."
      >
        {content}
      </button>
    );
  }

  if (status.state === "failed" && onRetry) {
    return (
      <button
        type="button"
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          try {
            await onRetry(status.entityId);
          } finally {
            setRetrying(false);
          }
        }}
        className={cn(
          base,
          "transition-colors duration-150 hover:bg-rose-400/20",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/60",
          "disabled:cursor-wait disabled:opacity-70"
        )}
        aria-label={`${label} — retry${status.lastError ? `. Reason: ${status.lastError}` : ""}`}
        // The actual reason, verbatim. "Something went wrong" is not something a
        // user can act on, and the store keeps this string precisely so the UI
        // never has to invent one.
        title={status.lastError ? `${status.lastError}\n\nClick to retry.` : "Click to retry."}
      >
        {retrying ? (
          <>
            <RefreshCw size={11} aria-hidden className="shrink-0 animate-spin" />
            Retrying…
          </>
        ) : (
          content
        )}
      </button>
    );
  }

  return (
    <span className={base} role="status">
      {content}
    </span>
  );
}

/**
 * The same information as one dot, for dense rows (a project card's corner)
 * where a full pill would crowd the title. The accessible name still carries
 * the words, so the meaning is never colour-only for a screen reader either.
 */
export function SyncStatusDot({
  status,
  className,
}: {
  status: SyncStatusSnapshot | null;
  className?: string;
}) {
  if (!status || status.state === "synced") return null;
  const presentation = PRESENTATION[status.state];
  return (
    <span
      role="status"
      aria-label={presentation.label(status)}
      title={status.lastError ?? presentation.label(status)}
      className={cn("size-2 rounded-full ring-2 ring-ink", presentation.dot, className)}
    />
  );
}
