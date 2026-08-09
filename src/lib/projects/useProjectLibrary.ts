"use client";

/**
 * The ONE list of "my projects", whichever shell is asking.
 *
 * Web:     exactly `subscribeProjects(uid)` — the same Firestore listener the
 *          dashboard has always used. Nothing changes.
 * Desktop: that listener PLUS the local SQLite library, merged and deduped.
 *
 * ── Which data comes from where ────────────────────────────────────────────
 *   Firebase  — identity, subscriptions, plan/usage, cloud projects, analysis
 *               jobs, cloud export jobs. Anything an account owns.
 *   SQLite    — projects imported from this computer, the media references
 *               that point at the user's own files, autosave/recovery history,
 *               and the exports this machine produced. Anything a disk owns.
 *
 * ── Dedup ──────────────────────────────────────────────────────────────────
 * A project can legitimately exist in both places (imported here, later synced,
 * or opened from the cloud and cached locally). The local row records the
 * Firestore id it corresponds to; the merge keys on `cloudProjectId ?? id` and
 * keeps the LOCAL copy, because that one still opens with no network. The cloud
 * document's status/analysis is folded in so the card doesn't regress to a
 * staler view.
 */
import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { subscribeProjects } from "@/lib/firebase/projects";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { usePlatform } from "@/lib/platform";
import type { ProjectSummary } from "@/lib/platform/types";
import { mergeProjectSources } from "./merge-projects";

export interface ProjectLibraryState {
  projects: ProjectDoc[];
  /**
   * The local row behind each project, keyed by the id the merged list uses.
   *
   * A `ProjectDoc` deliberately says nothing about this computer — it is the
   * same shape on the web — so facts that are only true HERE (is the video on
   * this disk, or only in the cloud?) have to travel beside it rather than
   * inside it. Empty on the web.
   */
  localById: Map<string, ProjectSummary>;
  /** True until the first result from every source this platform has arrived. */
  loading: boolean;
  /** How many of `projects` live on this computer. 0 on the web. */
  localCount: number;
  /** How many came from Firestore. */
  cloudCount: number;
  /** Cloud listing failed (offline / signed out) but local projects are shown. */
  cloudUnavailable: boolean;
  /** Re-read the local library — cloud updates arrive on their own. */
  refreshLocal: () => void;
}

export { localSummaryToDoc, mergeProjectSources } from "./merge-projects";

/** Shared empty results, so "nothing yet" is referentially stable. */
const EMPTY_CLOUD: ProjectDoc[] = [];
const EMPTY_LOCAL: ProjectSummary[] = [];

export function useProjectLibrary(): ProjectLibraryState {
  const { user } = useAuth();
  const platform = usePlatform();
  const uid = user?.uid ?? null;
  const listLocal = platform.projects.kind === "local" ? platform.projects.list : undefined;

  /**
   * Both sources are stored TAGGED with what produced them, and every write
   * happens in an async callback. Nothing is reset synchronously when `uid` or
   * the local list changes — "is this result still current?" is answered by
   * comparing the tag instead, which is also what stops a slow response for the
   * previous user from ever being rendered as the new one's library.
   */
  const [cloudState, setCloudState] = React.useState<{
    uid: string | null;
    projects: ProjectDoc[];
    failed: boolean;
  }>({ uid: null, projects: [], failed: false });

  const [localState, setLocalState] = React.useState<{
    nonce: number;
    rows: ProjectSummary[];
  } | null>(null);
  const [localNonce, setLocalNonce] = React.useState(0);

  React.useEffect(() => {
    if (!uid) return;
    let settled = false;
    const unsub = subscribeProjects(uid, (list) => {
      settled = true;
      setCloudState({ uid, projects: list, failed: false });
    });
    // A Firestore listener that never fires (offline, no cached data) must not
    // hold the whole page on a spinner when local projects are ready to show.
    const offlineTimer = setTimeout(() => {
      if (settled) return;
      setCloudState({ uid, projects: [], failed: true });
    }, 6000);
    return () => {
      clearTimeout(offlineTimer);
      unsub();
    };
  }, [uid]);

  React.useEffect(() => {
    if (!listLocal) return;
    let live = true;
    const nonce = localNonce;
    void listLocal()
      .then((rows) => {
        if (live) setLocalState({ nonce, rows });
      })
      .catch((err) => {
        console.error("[project-library] local listing failed", err);
        if (live) setLocalState({ nonce, rows: [] });
      });
    return () => {
      live = false;
    };
  }, [listLocal, localNonce]);

  // Results from a previous user / a superseded listing are ignored, not shown.
  // Memoised so the empty case is a STABLE array — a fresh `[]` each render
  // would re-run the merge below on every render for no reason.
  const cloudCurrent = uid !== null && cloudState.uid === uid;
  const cloud = React.useMemo(
    () => (cloudCurrent ? cloudState.projects : EMPTY_CLOUD),
    [cloudCurrent, cloudState.projects]
  );
  const cloudLoaded = uid === null || cloudCurrent;
  const cloudFailed = cloudCurrent && cloudState.failed;

  const local = React.useMemo(
    () => (listLocal && localState ? localState.rows : EMPTY_LOCAL),
    [listLocal, localState]
  );
  // The FIRST listing is what "loaded" means; a refresh re-lists in the
  // background without throwing the page back to a spinner.
  const localLoaded = !listLocal || localState !== null;

  // The desktop broadcasts every committed local write; re-listing on it keeps
  // the library honest after a create/delete from anywhere in the app.
  const onLibraryChanged = platform.projects.onLibraryChanged;
  React.useEffect(() => {
    if (!onLibraryChanged) return;
    let queued: ReturnType<typeof setTimeout> | null = null;
    const off = onLibraryChanged(() => {
      // Coalesce a burst of writes (the editor writes on every edit) into one
      // re-list, or typing in the timeline would re-query on every keystroke.
      if (queued) return;
      queued = setTimeout(() => {
        queued = null;
        setLocalNonce((n) => n + 1);
      }, 400);
    });
    return () => {
      if (queued) clearTimeout(queued);
      off();
    };
  }, [onLibraryChanged]);

  const projects = React.useMemo(() => mergeProjectSources(local, cloud), [local, cloud]);
  // Keyed on the LOCAL id, which is the id the merged doc carries: a mirrored
  // project uses its cloud id as its own, and one that started life here keeps
  // the id it was created with.
  const localById = React.useMemo(
    () => new Map(local.map((summary) => [summary.id, summary])),
    [local]
  );

  return {
    projects,
    localById,
    loading: (!!uid && !cloudLoaded) || !localLoaded,
    localCount: local.length,
    cloudCount: cloud.length,
    cloudUnavailable: cloudFailed,
    refreshLocal: React.useCallback(() => setLocalNonce((n) => n + 1), []),
  };
}
