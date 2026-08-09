"use client";

/**
 * The workspace's NUMBERS, with none of its documents.
 *
 * The counterpart to `useProjectLibrary()`: that hook exists to render
 * projects, this one exists to render counts. The dashboard needs the second
 * and used to pay for the first — subscribing to every cloud document and
 * listing every local row so it could show a total and a byte sum. Both sources
 * can answer those questions directly:
 *
 *   cloud — one Firestore aggregate query (`count()` + `sum('fileSize')`),
 *           computed server-side, one row on the wire.
 *   local — one SQLite aggregate over the desktop library (see
 *           desktop/src/main/library.ts `stats()`), one row across the bridge.
 *
 * ── Dedup, without merging ─────────────────────────────────────────────────
 * A project the user has in both places must be counted ONCE, and the merge
 * that normally decides this needs the rows themselves. It is recoverable from
 * counts alone because the local side knows how many of its rows name a cloud
 * twin: `total = local + (cloud − linked)`. That matches
 * `mergeProjectSources()` whenever every linked row's twin still exists in the
 * cloud, which is what `linkCloud` maintains; the clamp below keeps a deleted
 * twin from pushing the total below the number of projects actually here.
 *
 * ── Freshness ──────────────────────────────────────────────────────────────
 * Aggregates are one-shot, so this re-reads on the events that can change a
 * count: sign-in, a committed local write, and the window becoming visible
 * again. That is deliberately coarser than a listener — a stat tile that is a
 * few seconds stale costs nothing, and the whole point of this hook is to stop
 * paying a listener's price for it.
 */
import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { getCloudProjectStats } from "@/lib/firebase/projects";
import { usePlatform } from "@/lib/platform";

export interface WorkspaceStats {
  /** Projects the user has, counted once each across both sources. */
  projectCount: number;
  /** How many live on this computer. 0 on the web. */
  localCount: number;
  /** How many live in Firestore (including those mirrored locally). */
  cloudCount: number;
  /** Cloud bytes — what the storage plan is measured against. */
  cloudBytes: number;
  /**
   * Bytes of source video on this disk, as RECORDED at import (0 on the web).
   * The Storage screen stats the filesystem for the exact figure; this is the
   * library's own tally, which costs nothing.
   */
  localBytes: number;
  /** True until the first answer from every source this platform has. */
  loading: boolean;
  /** The cloud aggregate failed (offline / signed out). Local numbers stand. */
  cloudUnavailable: boolean;
  /** Re-read both sources now. */
  refresh: () => void;
}

const EMPTY: Omit<WorkspaceStats, "loading" | "cloudUnavailable" | "refresh"> = {
  projectCount: 0,
  localCount: 0,
  cloudCount: 0,
  cloudBytes: 0,
  localBytes: 0,
};

export function useWorkspaceStats(): WorkspaceStats {
  const { user } = useAuth();
  const platform = usePlatform();
  const uid = user?.uid ?? null;
  const localStats = platform.projects.kind === "local" ? platform.projects.stats : undefined;

  /**
   * Both results are TAGGED with what produced them and written only in an
   * async callback — the same rule `useProjectLibrary` follows, and for the
   * same reason: a slow response for the previous account must never be
   * rendered as the new one's workspace.
   */
  const [cloud, setCloud] = React.useState<{
    uid: string | null;
    projectCount: number;
    storageBytes: number;
    failed: boolean;
  }>({ uid: null, projectCount: 0, storageBytes: 0, failed: false });

  const [local, setLocal] = React.useState<{
    projectCount: number;
    linkedCount: number;
    mediaBytes: number;
  } | null>(null);

  const [nonce, setNonce] = React.useState(0);
  const refresh = React.useCallback(() => setNonce((n) => n + 1), []);

  React.useEffect(() => {
    if (!uid) return;
    let live = true;
    void getCloudProjectStats(uid)
      .then((stats) => {
        if (!live) return;
        setCloud({ uid, ...stats, failed: false });
      })
      .catch((err) => {
        console.error("[workspace-stats] cloud aggregate failed", err);
        if (!live) return;
        setCloud({ uid, projectCount: 0, storageBytes: 0, failed: true });
      });
    return () => {
      live = false;
    };
  }, [uid, nonce]);

  React.useEffect(() => {
    if (!localStats) return;
    let live = true;
    void localStats()
      .then((stats) => {
        if (live) setLocal(stats);
      })
      .catch((err) => {
        console.error("[workspace-stats] local stats failed", err);
        if (live) setLocal({ projectCount: 0, linkedCount: 0, mediaBytes: 0 });
      });
    return () => {
      live = false;
    };
  }, [localStats, nonce]);

  // A committed local write can create or delete a project; the same coalescing
  // the library listing uses applies, since the editor writes on every edit.
  const onLibraryChanged = platform.projects.onLibraryChanged;
  React.useEffect(() => {
    if (!onLibraryChanged) return;
    let queued: ReturnType<typeof setTimeout> | null = null;
    const off = onLibraryChanged(() => {
      if (queued) return;
      queued = setTimeout(() => {
        queued = null;
        refresh();
      }, 400);
    });
    return () => {
      if (queued) clearTimeout(queued);
      off();
    };
  }, [onLibraryChanged, refresh]);

  // Coming back to the window is the moment a stale count is noticed — and the
  // moment a project may have been created on another device.
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const cloudCurrent = uid !== null && cloud.uid === uid;
  const cloudLoaded = uid === null || cloudCurrent;
  const localLoaded = !localStats || local !== null;

  if (!cloudCurrent && !local) {
    return {
      ...EMPTY,
      loading: !cloudLoaded || !localLoaded,
      cloudUnavailable: false,
      refresh,
    };
  }

  const cloudCount = cloudCurrent ? cloud.projectCount : 0;
  const localCount = local?.projectCount ?? 0;
  const linked = Math.min(local?.linkedCount ?? 0, cloudCount);

  return {
    projectCount: localCount + (cloudCount - linked),
    localCount,
    cloudCount,
    cloudBytes: cloudCurrent ? cloud.storageBytes : 0,
    localBytes: local?.mediaBytes ?? 0,
    loading: !cloudLoaded || !localLoaded,
    cloudUnavailable: cloudCurrent && cloud.failed,
    refresh,
  };
}
