"use client";

/**
 * "Put this in the cloud" / "bring this here" — the two things a local-first
 * user actually presses.
 *
 * WHAT IT IS SAYING
 * -----------------
 * A project's TIMELINE syncs on its own and is never what this control is
 * about. Its VIDEO does not: it is gigabytes, so it moves only when asked. So
 * every state below is a sentence about where the RECORDING is, and the button
 * is the missing half of that sentence:
 *
 *   on this computer only     → "Save to cloud"     (upload)
 *   in the cloud only         → "Download"          (fetch it here)
 *   both                      →  nothing to press; say so quietly
 *
 * WHY IT IS NOT A SPINNER
 * -----------------------
 * A four-gigabyte upload is not a loading state, it is a task with a duration.
 * It gets a real percentage, a size, and a way to stop — the same courtesy any
 * file transfer gets — because a spinner that turns for eleven minutes teaches
 * people the app has hung.
 */

import * as React from "react";
import {
  Check,
  CloudDownload,
  CloudUpload,
  HardDrive,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import { useSync } from "@/components/desktop/SyncProvider";
import type { MediaTransferSnapshot } from "@/lib/platform/types";
import { cn } from "@/lib/cn";

export interface CloudTransferControlProps {
  projectId: string;
  /** True when the video is only in the cloud — i.e. the download case. */
  cloudOnly: boolean;
  /**
   * True when the project has no cloud copy to download and no local file to
   * upload (a cloud project whose video was never uploaded from anywhere).
   */
  disabled?: boolean;
  /** `card` is compact and icon-led; `bar` is the editor's inline version. */
  variant?: "card" | "bar";
  className?: string;
  onNotice?: (message: string) => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || !Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function percentOf(transfer: MediaTransferSnapshot): number | null {
  if (!transfer.bytesTotal) return null;
  return Math.min(100, Math.round((transfer.bytesTransferred / transfer.bytesTotal) * 100));
}

export function CloudTransferControl({
  projectId,
  cloudOnly,
  disabled = false,
  variant = "card",
  className,
  onNotice,
}: CloudTransferControlProps) {
  const sync = useSync();
  const transfer = sync.transferFor(projectId);
  const [busy, setBusy] = React.useState(false);

  if (!sync.available) return null;

  const act = async (run: () => Promise<{ queued: boolean; reason?: string } | void>) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await run();
      // A refusal is INFORMATION, not an error: "already uploaded" and "this
      // has no cloud video yet" are both perfectly good answers, and the store
      // phrases them for exactly this.
      if (result && !result.queued && result.reason) onNotice?.(result.reason);
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : "That didn't work. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const compact = variant === "card";
  const shell = cn(
    "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium",
    "transition-colors duration-150 focus:outline-none focus-visible:ring-1",
    compact ? "" : "px-2.5 py-1.5 text-xs",
    className
  );

  // ── In flight ─────────────────────────────────────────────────────────────
  if (transfer && transfer.state === "active") {
    const pct = percentOf(transfer);
    const downloading = transfer.direction === "download";
    return (
      <span
        className={cn(shell, "border-violet-400/30 bg-violet-500/10 text-violet-200")}
        role="status"
        aria-live="polite"
        title={
          transfer.bytesTotal
            ? `${formatBytes(transfer.bytesTransferred)} of ${formatBytes(transfer.bytesTotal)}`
            : undefined
        }
      >
        <Loader2 size={11} aria-hidden className="shrink-0 animate-spin" />
        {downloading ? "Downloading" : "Uploading"}
        {pct !== null && <span className="tabular-nums">{pct}%</span>}
        {downloading && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void sync.cancelDownload(projectId);
            }}
            aria-label="Stop downloading"
            title="Stop. Progress is kept — starting again resumes."
            className="relative z-20 -mr-0.5 ml-0.5 rounded p-0.5 text-violet-200/70 hover:bg-white/10 hover:text-white"
          >
            <X size={10} />
          </button>
        )}
      </span>
    );
  }

  // ── Parked with a reason ──────────────────────────────────────────────────
  if (transfer && transfer.state === "failed") {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void act(() => sync.retryTransfer(projectId));
        }}
        // The real reason, verbatim. The store keeps this string precisely so
        // the UI never has to invent "something went wrong".
        title={
          transfer.lastError
            ? `${transfer.lastError}\n\nClick to try again.`
            : "Click to try again."
        }
        aria-label={`${transfer.direction === "download" ? "Download" : "Upload"} failed${
          transfer.lastError ? `. Reason: ${transfer.lastError}` : ""
        }. Try again`}
        className={cn(
          shell,
          "relative z-20 border-rose-400/40 bg-rose-500/10 text-rose-200",
          "hover:bg-rose-500/20 focus-visible:ring-rose-300/60 disabled:opacity-60"
        )}
      >
        <RotateCw size={11} aria-hidden className={cn("shrink-0", busy && "animate-spin")} />
        Try again
      </button>
    );
  }

  // ── The video is only in the cloud ────────────────────────────────────────
  if (cloudOnly) {
    const resuming = transfer?.state === "pending" && transfer.bytesTransferred > 0;
    return (
      <button
        type="button"
        disabled={busy || disabled}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void act(() => sync.downloadMedia(projectId));
        }}
        title="Copy this video onto this computer so the project opens and exports offline."
        className={cn(
          shell,
          "relative z-20 border-white/10 bg-white/[0.04] text-white",
          "hover:bg-white/[0.09] focus-visible:ring-violet-400/50 disabled:opacity-50"
        )}
      >
        <CloudDownload size={12} aria-hidden className="shrink-0" />
        {resuming ? "Resume download" : compact ? "Download" : "Download to this computer"}
      </button>
    );
  }

  // ── Already in both places ────────────────────────────────────────────────
  if (transfer && transfer.state === "done") {
    return (
      <span
        className={cn(shell, "border-emerald-400/30 bg-emerald-400/10 text-emerald-300")}
        role="status"
      >
        <Check size={11} aria-hidden className="shrink-0" />
        {compact ? "In cloud" : "Saved to cloud"}
      </span>
    );
  }

  // ── On this computer only ─────────────────────────────────────────────────
  const queued = transfer?.state === "pending";
  return (
    <button
      type="button"
      disabled={busy || disabled || queued}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void act(() => sync.uploadMedia(projectId));
      }}
      title={
        disabled
          ? "This project has no video on this computer to upload."
          : "Copy this video to the cloud so you can open the project on the web or on another computer."
      }
      className={cn(
        shell,
        "relative z-20 border-white/10 bg-white/[0.04] text-white",
        "hover:bg-white/[0.09] focus-visible:ring-violet-400/50 disabled:opacity-50"
      )}
    >
      {queued ? (
        <>
          <HardDrive size={12} aria-hidden className="shrink-0" />
          Waiting to upload
        </>
      ) : (
        <>
          <CloudUpload size={12} aria-hidden className="shrink-0" />
          {compact ? "Save to cloud" : "Save video to cloud"}
        </>
      )}
    </button>
  );
}
