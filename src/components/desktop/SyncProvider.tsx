"use client";

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { usePlatform } from "@/lib/platform";
import type { MediaTransferSnapshot, SyncStatusSnapshot } from "@/lib/platform/types";
import { createSyncEngine, type SyncEngine } from "@/lib/sync/engine";
import { createFirestoreRemote } from "@/lib/sync/firestore-remote";
import {
  createMediaUploadWorker,
  type MediaUploadWorker,
} from "@/lib/sync/media-upload-worker";
import type { LocalSyncPort } from "@/lib/sync/ports";
import type { SyncProgress } from "@/lib/sync/types";

/**
 * Runs the sync engine for the signed-in account, and hands the UI the state it
 * needs to talk about it.
 *
 * Mounted once, high in the desktop tree. It is inert on the web (where
 * `platform.sync` is null, because Firestore IS the store) and inert while
 * signed out — the queue keeps accepting work either way, so nothing is lost by
 * the engine not running.
 *
 * The engine is rebuilt when the ACCOUNT changes, never on an unrelated render:
 * a second engine draining the same queue would claim operations out from under
 * the first, and two Firestore listeners would double every pull.
 */

interface SyncContextValue {
  /** Aggregate state for the library indicator. Null before the first report. */
  progress: SyncProgress | null;
  /** Per-project state. Cached and refreshed on change events. */
  statusFor(projectId: string): SyncStatusSnapshot | null;
  /** Ask for a project's state (populates the cache on first call). */
  track(projectId: string): void;
  retry(projectId: string): Promise<void>;
  resolveConflict(
    projectId: string,
    choices: Record<string, "local" | "remote">
  ): Promise<void>;
  /** True on a shell that has no sync at all (the website). */
  available: boolean;

  // ── The source video ──────────────────────────────────────────────────────
  // Documents sync unasked; the recording moves only when somebody asks. These
  // are the two things a user can actually press.

  /** Send this project's video to the cloud. Resolves when it is QUEUED. */
  uploadMedia(projectId: string): Promise<{ queued: boolean; reason?: string }>;
  /** Fetch this project's cloud video onto this computer. */
  downloadMedia(projectId: string): Promise<{ queued: boolean; reason?: string }>;
  /** Stop an in-flight download. Progress is kept; asking again resumes it. */
  cancelDownload(projectId: string): Promise<void>;
  /** Re-arm a parked transfer in either direction. */
  retryTransfer(projectId: string): Promise<void>;
  /** Live transfer state for one project, or null when there is none. */
  transferFor(projectId: string): MediaTransferSnapshot | null;
  /** Push everything queued right now instead of waiting for the next tick. */
  syncNow(): Promise<void>;
}

const SyncCtx = React.createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const platform = usePlatform();
  const { user } = useAuth();
  const sync = platform.sync;
  const uid = user?.uid ?? null;

  const [progress, setProgress] = React.useState<SyncProgress | null>(null);
  const [statuses, setStatuses] = React.useState<Record<string, SyncStatusSnapshot | null>>({});
  /**
   * Transfer state for EVERY project, not just the tracked ones.
   *
   * Unlike a sync status — which is cheap to ask for, one project at a time —
   * transfers arrive as a push from main while bytes are moving. Keeping the
   * whole map means a card that scrolls into view mid-upload already knows.
   */
  const [transfers, setTransfers] = React.useState<Record<string, MediaTransferSnapshot>>({});
  /** Which projects the UI has asked about — the set we refresh on a change. */
  const tracked = React.useRef(new Set<string>());
  const engineRef = React.useRef<SyncEngine | null>(null);
  const uploaderRef = React.useRef<MediaUploadWorker | null>(null);

  const refresh = React.useCallback(
    async (projectId: string) => {
      if (!sync) return;
      try {
        const next = await sync.status(projectId);
        setStatuses((prev) =>
          prev[projectId] === next ? prev : { ...prev, [projectId]: next }
        );
      } catch {
        // A status read is cosmetic; failing it must not surface an error.
      }
    },
    [sync]
  );

  // ── The engine ────────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!sync || !uid) return;

    const engine = createSyncEngine({
      local: sync.queue as LocalSyncPort,
      remote: createFirestoreRemote(uid),
      ownerUid: uid,
      onProgress: (next) => {
        setProgress(next);
        // Anything the UI is watching may have moved with it.
        for (const id of tracked.current) void refresh(id);
      },
      onError: (error) => {
        // Deliberately not a toast. Sync errors are per-operation and already
        // recorded on the record itself, where the badge can offer a retry; a
        // global popup for a transient network blip would be noise.
        console.warn("[sync]", error.message);
      },
    });
    engineRef.current = engine;
    engine.start();

    const online = () => engine.setOnline(true);
    const offline = () => engine.setOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    engine.setOnline(navigator.onLine);

    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      engine.stop();
      engineRef.current = null;
    };
  }, [sync, uid, refresh]);

  // ── Main-process change events ────────────────────────────────────────────
  React.useEffect(() => {
    if (!sync) return;
    return sync.onChanged(({ projectId }) => {
      if (tracked.current.has(projectId)) void refresh(projectId);
    });
  }, [sync, refresh]);

  // ── The source video's transfers ──────────────────────────────────────────
  // The uploader is built alongside the engine and for the same reason: two of
  // them draining one queue would claim each other's jobs. It is NOT started
  // automatically — a recording goes to the cloud when the user asks, never
  // because they happened to sign in on a metered connection — but a job left
  // queued by a previous session is picked up, because that IS them asking.
  React.useEffect(() => {
    if (!sync || !uid) return;
    const worker = createMediaUploadWorker({
      bridge: sync.media,
      ownerUid: uid,
      onError: (error) => {
        // Per-transfer failures are recorded on the row, where the card can
        // show the reason and offer a retry. A toast here would duplicate it.
        console.warn("[sync/media]", error.message);
      },
    });
    uploaderRef.current = worker;

    let live = true;
    void (async () => {
      // MAIN HAS TO KNOW WHO IS SIGNED IN FIRST.
      //
      // Every transfer channel is scoped to the account main was told about,
      // and `DesktopAuthGate` reports it from its OWN effect — a sibling, with
      // no ordering guarantee against this one. Losing that race rejects the
      // first claim and, worse, the first `list()`, which is the only unsolicited
      // read there is: a transfer queued before the last quit would then stay
      // invisible until something else happened to move it.
      //
      // `setOwner` is idempotent (main compares before assigning), so asking
      // again costs nothing and makes the dependency explicit instead of lucky.
      await sync.setOwner(uid).catch(() => undefined);
      if (!live) return;

      const rows = await sync.media.list().catch(() => []);
      if (!live) return;
      setTransfers(Object.fromEntries(rows.map((row) => [row.projectId, row])));

      // Anything left queued by a previous session IS the user still asking.
      void worker.drain();
    })();

    return () => {
      live = false;
      worker.stop();
      uploaderRef.current = null;
    };
  }, [sync, uid]);

  React.useEffect(() => {
    if (!sync) return;
    return sync.media.onChanged((snapshot) => {
      setTransfers((prev) => ({ ...prev, [snapshot.projectId]: snapshot }));
      // A finished upload repointed the document, so the project's sync state
      // moved with it.
      if (snapshot.state === "done" && tracked.current.has(snapshot.projectId)) {
        void refresh(snapshot.projectId);
      }
    });
  }, [sync, refresh]);

  const value = React.useMemo<SyncContextValue>(
    () => ({
      progress,
      available: !!sync,
      statusFor: (projectId) => statuses[projectId] ?? null,
      track: (projectId) => {
        if (tracked.current.has(projectId)) return;
        tracked.current.add(projectId);
        void refresh(projectId);
      },
      async retry(projectId) {
        if (!sync) return;
        await sync.retry(projectId);
        await refresh(projectId);
        // Re-arming only makes the work claimable; something has to claim it.
        await engineRef.current?.drain();
        await refresh(projectId);
      },
      async resolveConflict(projectId, choices) {
        if (!sync) return;
        await sync.resolveConflict(projectId, choices);
        await refresh(projectId);
        await engineRef.current?.drain();
        await refresh(projectId);
      },

      transferFor: (projectId) => transfers[projectId] ?? null,

      async uploadMedia(projectId) {
        if (!sync) return { queued: false, reason: "Sync isn't available here." };
        const result = await sync.media.requestUpload(projectId);
        // Queuing is not doing. Nothing moves until a worker claims the job, so
        // the same click that queues it also wakes the worker — otherwise the
        // upload would sit there until an unrelated event happened to drain.
        if (result.queued) void uploaderRef.current?.drain();
        return result;
      },

      async downloadMedia(projectId) {
        if (!sync) return { queued: false, reason: "Sync isn't available here." };
        // Main starts the transfer itself; progress arrives over `onChanged`.
        return sync.media.requestDownload(projectId);
      },

      async cancelDownload(projectId) {
        await sync?.media.cancelDownload(projectId);
      },

      async retryTransfer(projectId) {
        if (!sync) return;
        await sync.media.retry(projectId);
        void uploaderRef.current?.drain();
      },

      async syncNow() {
        // Documents first — they are small, and a user who pressed "Sync now"
        // wants to see the timeline land, not wait behind four gigabytes.
        await engineRef.current?.drain();
        await uploaderRef.current?.drain();
      },
    }),
    [progress, statuses, transfers, sync, refresh]
  );

  return <SyncCtx.Provider value={value}>{children}</SyncCtx.Provider>;
}

/**
 * Sync state, or a dormant stand-in on a shell without it.
 *
 * Returns a working object rather than throwing when there is no provider, so a
 * component can render a badge unconditionally and simply get nothing on the
 * web — the alternative is an `isDesktop` check at every call site, which is
 * exactly what the platform ports exist to avoid.
 */
export function useSync(): SyncContextValue {
  return React.useContext(SyncCtx) ?? DORMANT;
}

const UNAVAILABLE = { queued: false, reason: "Sync isn't available here." };

const DORMANT: SyncContextValue = {
  progress: null,
  available: false,
  statusFor: () => null,
  track: () => {},
  retry: async () => {},
  resolveConflict: async () => {},
  uploadMedia: async () => UNAVAILABLE,
  downloadMedia: async () => UNAVAILABLE,
  cancelDownload: async () => {},
  retryTransfer: async () => {},
  transferFor: () => null,
  syncNow: async () => {},
};

/**
 * Subscribe one component to one project's sync state.
 *
 * Registering interest on mount is what keeps the provider from polling every
 * project in the library — only what is actually on screen is refreshed.
 */
export function useProjectSyncStatus(projectId: string | null): SyncStatusSnapshot | null {
  const sync = useSync();
  React.useEffect(() => {
    if (projectId) sync.track(projectId);
  }, [sync, projectId]);
  return projectId ? sync.statusFor(projectId) : null;
}

/**
 * One project's video transfer, if it has one.
 *
 * No registration needed, unlike `useProjectSyncStatus`: transfers are pushed
 * from main while bytes move, so the provider already holds every one.
 */
export function useMediaTransfer(projectId: string | null): MediaTransferSnapshot | null {
  const sync = useSync();
  return projectId ? sync.transferFor(projectId) : null;
}
