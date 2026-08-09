"use client";

import * as React from "react";
import {
  Cloud,
  Database,
  FileVideo,
  FolderOpen,
  HardDrive,
  Loader2,
  Sparkles,
  Trash2,
  Video,
} from "lucide-react";
import { usePlatform } from "@/lib/platform";
import type { LocalStorageUsage } from "@/lib/platform";
import { useStoragePlan } from "@/lib/usage/useStoragePlan";
import { fmtBytes, storageBand } from "@/lib/usage/plan";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

/**
 * Storage — the two places a Framevo project can weigh something.
 *
 *   CLOUD  (Firebase)  — counts against the plan. Uploaded videos and their
 *                        documents; the same figure the sidebar meter shows.
 *   LOCAL  (this disk) — does not count against anything. Split into what
 *                        Framevo merely POINTS AT (videos the user imported,
 *                        which the app must never delete) and what Framevo
 *                        OWNS (recordings it wrote, exports it produced, the
 *                        library database).
 *
 * Only the owned half is reclaimable, and every reclaim action says exactly what
 * it will remove before it does it.
 */
export function DesktopStoragePage() {
  const platform = usePlatform();
  const storage = platform.storage;
  const cloud = useStoragePlan();
  const toast = useToast();

  const [usage, setUsage] = React.useState<LocalStorageUsage | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!storage) return;
    try {
      setUsage(await storage.usage());
    } catch (err) {
      toast.error("Couldn't read local storage", err instanceof Error ? err.message : undefined);
    }
  }, [storage, toast]);

  React.useEffect(() => {
    if (!storage) return;
    let live = true;
    void storage
      .usage()
      .then((u) => {
        if (live) setUsage(u);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [storage]);

  const run = async (
    key: string,
    action: () => Promise<unknown>,
    describe: (result: unknown) => string
  ) => {
    setBusy(key);
    try {
      const result = await action();
      await load();
      toast.success("Done", describe(result));
    } catch (err) {
      toast.error("That didn't work", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  const cloudBand = storageBand(cloud.usedBytes, cloud.limitBytes);
  const cloudPct = cloud.limitBytes > 0 ? Math.max(1, Math.round(cloud.fraction * 100)) : 0;

  const localTotal = usage
    ? usage.mediaBytes + usage.recordingBytes + usage.exportBytes + usage.databaseBytes
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Storage"
        title="Where your videos live"
        subtitle="Framevo Desktop keeps projects on this computer and syncs only what you ask it to."
        action={
          storage && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => void storage.openLibraryFolder()}
              leftIcon={<FolderOpen size={14} />}
            >
              Open library folder
            </Button>
          )
        }
      />

      {/* ── Cloud ───────────────────────────────────────────────────────── */}
      <section className="glass rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Cloud size={15} className="text-cyan-300" />
              Your Framevo account
            </h2>
            <p className="mt-1 text-xs text-fog">
              Videos you uploaded from any device. This is what counts against your plan.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/25 bg-violet-500/10 px-2.5 py-1 text-[11px] font-medium text-violet-200">
            <Sparkles size={11} />
            {cloud.plan.name}
          </span>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-fog">
              {cloud.loading ? "Reading your account…" : `${cloud.projectCount} cloud project${cloud.projectCount === 1 ? "" : "s"}`}
            </span>
            <span
              className={cn(
                "font-mono tabular-nums",
                cloudBand === "danger"
                  ? "text-rose-300"
                  : cloudBand === "warn"
                    ? "text-amber-200"
                    : "text-white/85"
              )}
            >
              {fmtBytes(cloud.usedBytes)} / {fmtBytes(cloud.limitBytes)}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-300",
                cloudBand === "danger"
                  ? "bg-gradient-to-r from-rose-500 to-rose-400"
                  : cloudBand === "warn"
                    ? "bg-gradient-to-r from-amber-400 to-amber-300"
                    : "bg-gradient-to-r from-violet-500 to-cyan-400"
              )}
              style={{ width: `${cloudPct}%` }}
            />
          </div>
        </div>
      </section>

      {/* ── Local ───────────────────────────────────────────────────────── */}
      <section className="glass rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <HardDrive size={15} className="text-violet-300" />
              This computer
            </h2>
            <p className="mt-1 text-xs text-fog">
              Local projects use no plan quota. Framevo reads your source videos where they already
              are — it never copies them.
            </p>
          </div>
          {usage?.freeDiskBytes !== undefined && (
            <span className="text-[11px] text-fog">
              {fmtBytes(usage.freeDiskBytes)} free on this drive
            </span>
          )}
        </div>

        {!usage ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-fog">
            <Loader2 size={14} className="animate-spin text-violet-300" />
            Measuring…
          </div>
        ) : (
          <>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <UsageTile
                icon={<FileVideo size={13} />}
                label="Imported videos"
                bytes={usage.mediaBytes}
                detail={`${usage.mediaCount} file${usage.mediaCount === 1 ? "" : "s"} · referenced, not copied`}
              />
              <UsageTile
                icon={<Video size={13} />}
                label="Recordings"
                bytes={usage.recordingBytes}
                detail={`${usage.recordingCount} saved by Framevo`}
              />
              <UsageTile
                icon={<HardDrive size={13} />}
                label="Exports"
                bytes={usage.exportBytes}
                detail={`${usage.exportCount} finished file${usage.exportCount === 1 ? "" : "s"}`}
              />
              <UsageTile
                icon={<Database size={13} />}
                label="Library"
                bytes={usage.databaseBytes}
                detail="Projects, edits and autosave history"
              />
            </div>

            <p className="mt-4 text-[11px] text-fog">
              {fmtBytes(localTotal)} total in{" "}
              <span className="font-mono text-white/80">{usage.libraryFolderName}</span> and the
              folders your videos live in.
            </p>

            {/* ── Reclaim ─────────────────────────────────────────────── */}
            <div className="mt-5 space-y-2 border-t border-white/[0.06] pt-5">
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-fog">
                Free up space
              </h3>

              <ReclaimRow
                title="Trim autosave history"
                detail="Keeps the newest save point for every project and drops the older ones. Your projects are untouched."
                actionLabel="Trim"
                busy={busy === "compact"}
                onClick={() =>
                  void run(
                    "compact",
                    () => storage!.compactAutosaves(),
                    (r) => {
                      const res = r as { removedSnapshots: number; freedBytes: number };
                      return res.removedSnapshots
                        ? `Removed ${res.removedSnapshots} old save points, freeing ${fmtBytes(res.freedBytes)}.`
                        : "Nothing to trim — your history is already compact.";
                    }
                  )
                }
              />

              <ReclaimRow
                title="Forget missing videos"
                detail={
                  usage.missingMediaCount
                    ? `${usage.missingMediaCount} source video${usage.missingMediaCount === 1 ? " has" : "s have"} been moved or deleted outside Framevo. This clears the broken references — no file is deleted.`
                    : "Every source video is still where Framevo expects it."
                }
                actionLabel="Clear references"
                disabled={usage.missingMediaCount === 0}
                busy={busy === "media"}
                onClick={() =>
                  void run(
                    "media",
                    () => storage!.purgeMissingMedia(),
                    (r) => `Cleared ${(r as { removed: number }).removed} broken reference(s).`
                  )
                }
              />

              <ReclaimRow
                title="Clear vanished exports"
                detail={
                  usage.staleExportCount
                    ? `${usage.staleExportCount} export${usage.staleExportCount === 1 ? "" : "s"} in the list no longer exist on disk.`
                    : "Every export in your list is still on disk."
                }
                actionLabel="Clear list"
                disabled={usage.staleExportCount === 0}
                busy={busy === "exports"}
                onClick={() =>
                  void run(
                    "exports",
                    () => storage!.purgeStaleExports(),
                    (r) => `Removed ${(r as { removed: number }).removed} stale record(s).`
                  )
                }
              />

              <p className="pt-1 text-[11px] leading-relaxed text-fog">
                <Trash2 size={11} className="mr-1 inline align-[-1px]" />
                Exported video files are deleted one at a time from{" "}
                <span className="text-white/80">Exports</span>, so you always see what goes. Framevo
                never deletes a video you imported — it doesn&apos;t own those files.
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function UsageTile({
  icon,
  label,
  bytes,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  bytes: number;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-fog">
        <span className="text-violet-300">{icon}</span>
        {label}
      </div>
      <div className="mt-2 font-display text-lg font-semibold tabular-nums text-white">
        {fmtBytes(bytes)}
      </div>
      <div className="mt-0.5 text-[11px] leading-relaxed text-fog">{detail}</div>
    </div>
  );
}

function ReclaimRow({
  title,
  detail,
  actionLabel,
  onClick,
  busy,
  disabled,
}: {
  title: string;
  detail: string;
  actionLabel: string;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-white">{title}</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-fog">{detail}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClick}
        disabled={disabled || busy}
        leftIcon={busy ? <Loader2 size={13} className="animate-spin" /> : undefined}
      >
        {actionLabel}
      </Button>
    </div>
  );
}
