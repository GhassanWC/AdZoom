"use client";

import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  FolderOpen,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { usePlatform } from "@/lib/platform";
import type { LocalExportRecord } from "@/lib/platform";
import { useDesktopExport } from "@/components/export/DesktopExportProvider";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { fmtBytes } from "@/lib/usage/plan";
import { projectHref } from "./project-route";
import { cn } from "@/lib/cn";
import Link from "next/link";

/**
 * The exports this computer produced.
 *
 * They have no cloud job, no download URL and no billing behind them — they are
 * files. So the actions are the ones a file affords: play it, show it in its
 * folder, make it again, or throw it away. "Retry" reopens the project that
 * produced it, which is the only honest way to re-render: the recipe lives in
 * the project, not in the export record.
 */
export function DesktopExportsList() {
  const platform = usePlatform();
  const localExports = platform.localExports;
  const desktopExport = useDesktopExport();
  const toast = useToast();
  const confirm = useConfirm();

  const [rows, setRows] = React.useState<LocalExportRecord[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!localExports) return;
    try {
      setRows(await localExports.list());
    } catch (err) {
      toast.error("Couldn't read your exports", err instanceof Error ? err.message : undefined);
      setRows([]);
    }
  }, [localExports, toast]);

  React.useEffect(() => {
    // No local engine → the component renders nothing anyway, so `rows` stays
    // at its initial null rather than being reset synchronously here.
    if (!localExports) return;
    let live = true;
    void localExports
      .list()
      .then((list) => {
        if (live) setRows(list);
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
    // A finished render appends a row, so the list re-reads when the live job
    // reaches a terminal state.
  }, [localExports, desktopExport?.job?.status]);

  if (!localExports) return null;

  const play = async (row: LocalExportRecord) => {
    setBusyId(row.outputId);
    try {
      await localExports.play(row.outputId);
    } catch (err) {
      toast.error("Couldn't open that file", err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const reveal = async (row: LocalExportRecord) => {
    try {
      await localExports.reveal(row.outputId);
    } catch (err) {
      toast.error("Couldn't show that file", err instanceof Error ? err.message : undefined);
    }
  };

  const remove = async (row: LocalExportRecord) => {
    const choice = await confirm({
      title: `Delete “${row.fileName}”?`,
      message: row.fileExists
        ? "This removes the exported video file from your computer. The project it came from is untouched."
        : "That file is already gone. This just clears it from the list.",
      confirmLabel: row.fileExists ? "Delete file" : "Remove from list",
      tone: "danger",
    });
    if (!choice) return;
    setBusyId(row.outputId);
    try {
      await localExports.remove(row.outputId, row.fileExists);
      await refresh();
    } catch (err) {
      toast.error("Couldn't delete that export", err instanceof Error ? err.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/80">
            <HardDrive size={13} className="shrink-0 text-violet-300" />
            On this computer
          </h2>
          <p className="mt-1.5 text-[11.5px] text-fog">
            Rendered locally by Framevo Desktop. These files never left your machine.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} leftIcon={<RefreshCw size={14} />}>
          Refresh
        </Button>
      </div>

      {rows === null ? (
        <div className="glass grid place-items-center rounded-2xl p-10 text-sm text-fog">
          <span className="inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin text-violet-300" />
            Reading your exports…
          </span>
        </div>
      ) : rows.length === 0 ? (
        <div className="glass rounded-2xl p-10 text-center text-sm text-fog">
          <p>No local exports yet.</p>
          <p className="mt-1 text-xs">
            Export a project and the finished MP4 will be listed here.
          </p>
        </div>
      ) : (
        // One divided card, the same shape the cloud history uses below it —
        // separate floating pills made two lists out of what is one idea.
        <ul className="glass overflow-hidden rounded-2xl">
          {rows.map((row, i) => (
            <li
              key={row.outputId}
              className={cn(
                "flex flex-wrap items-center gap-4 px-4 py-4 transition-colors duration-150 hover:bg-white/[0.015] sm:px-5",
                i < rows.length - 1 && "border-b border-white/[0.05]"
              )}
            >
              <StatusGlyph row={row} />

              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-sm font-semibold text-white"
                  title={row.fileName}
                  dir="auto"
                >
                  {row.fileName}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-fog">
                  <span>{new Date(row.createdAt).toLocaleString()}</span>
                  {row.fileExists && (
                    <>
                      <Dot />
                      <span className="font-mono tabular-nums">{fmtBytes(row.sizeBytes)}</span>
                    </>
                  )}
                  {row.encoder && (
                    <>
                      <Dot />
                      <span className="font-mono">{row.encoder}</span>
                    </>
                  )}
                  <Dot />
                  {/* `gap-1.5` keeps the folder glyph off the folder name — at
                      11px they merge into one shape at anything tighter. */}
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <FolderOpen size={12} className="shrink-0" />
                    <span className="truncate">{row.folderName}</span>
                  </span>
                  {!row.fileExists && (
                    <>
                      <Dot />
                      <span className="text-amber-300">file moved or deleted</span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {row.fileExists && (
                  <>
                    <IconAction
                      label={`Play ${row.fileName}`}
                      busy={busyId === row.outputId}
                      onClick={() => void play(row)}
                    >
                      <Play size={15} />
                    </IconAction>
                    <IconAction label={`Show ${row.fileName} in folder`} onClick={() => void reveal(row)}>
                      <FolderOpen size={15} />
                    </IconAction>
                  </>
                )}
                {row.projectId && (
                  // `px-3.5` + `gap-2` — the same rule the cloud rows follow, so
                  // the icon never sits flush against "Export again".
                  <Link
                    href={projectHref(row.projectId)}
                    title="Open the project to export it again"
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 text-[12.5px] font-medium text-white/85 transition-colors duration-150 hover:border-white/20 hover:text-white"
                  >
                    <RefreshCw size={15} className="shrink-0" />
                    Export again
                  </Link>
                )}
                <IconAction
                  label={`Delete ${row.fileName}`}
                  danger
                  busy={busyId === row.outputId}
                  onClick={() => void remove(row)}
                >
                  <Trash2 size={15} />
                </IconAction>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The middot the meta line uses, with its own breathing room. */
function Dot() {
  return <span className="text-fog/30">·</span>;
}

/**
 * The row's status, as one 40px tile — same size, radius and ring as the cloud
 * rows below, so the two lists scan as one column rather than two.
 */
function StatusGlyph({ row }: { row: LocalExportRecord }) {
  const tone =
    row.status === "rendering" || row.status === "pending"
      ? "bg-violet-500/15 text-violet-300 ring-violet-400/20"
      : row.status === "ready" && row.fileExists
        ? "bg-emerald-500/15 text-emerald-300 ring-emerald-400/20"
        : "bg-white/[0.05] text-fog ring-white/10";
  const Icon =
    row.status === "rendering" || row.status === "pending"
      ? Loader2
      : row.status === "ready" && row.fileExists
        ? CheckCircle2
        : AlertCircle;
  const spin = row.status === "rendering" || row.status === "pending";
  return (
    <span
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-xl ring-1",
        tone
      )}
      aria-hidden
    >
      <Icon size={16} className={cn(spin && "animate-spin")} />
    </span>
  );
}

function IconAction({
  label,
  onClick,
  children,
  danger,
  busy,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={busy}
      className={cn(
        // 36px square around a 15px glyph: equal padding on all four sides, and
        // a tap target that clears the 32px minimum.
        "inline-flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-fog transition-colors duration-150 disabled:opacity-50",
        danger ? "hover:border-rose-400/40 hover:text-rose-300" : "hover:border-white/20 hover:text-white"
      )}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : children}
    </button>
  );
}
