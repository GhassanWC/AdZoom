"use client";

/**
 * Which backend owns THIS project.
 *
 * On the web there is only ever one answer (Firestore), and this hook returns
 * it synchronously — no probe, no extra render, no behaviour change.
 *
 * On the desktop there are two, and the id alone does not say which: a project
 * imported here lives in SQLite, one created on the website lives in Firestore,
 * and the editor has to open either from the same `/dashboard/projects/<id>`
 * route. So the local library is asked first (it answers off disk, and works
 * offline); anything it doesn't have belongs to the signed-in account.
 *
 * Answers are cached per project id for the life of the page, so returning to a
 * project doesn't re-probe and the editor's subscription isn't torn down and
 * rebuilt by an unrelated re-render.
 */
import * as React from "react";
import { usePlatform } from "./index";
import type { PlatformBridge, ProjectStorage } from "./types";

export type StorageResolution =
  | { status: "resolving"; storage: null }
  | { status: "resolved"; storage: ProjectStorage };

/**
 * Answers per (bridge, projectId). Keyed by the bridge OBJECT so signing out —
 * which builds a new bridge — can never serve a previous user's answer.
 */
const cache = new WeakMap<PlatformBridge, Map<string, ProjectStorage>>();

function lookup(bridge: PlatformBridge, projectId: string): ProjectStorage | null {
  return cache.get(bridge)?.get(projectId) ?? null;
}

function remember(bridge: PlatformBridge, projectId: string, storage: ProjectStorage): void {
  const byId = cache.get(bridge) ?? new Map<string, ProjectStorage>();
  byId.set(projectId, storage);
  cache.set(bridge, byId);
}

export function useProjectStorage(projectId: string): StorageResolution {
  const platform = usePlatform();
  const local = platform.projects;
  const cloud = platform.cloudProjects;

  // One store available → no question to answer. That is the web always, and
  // the desktop whenever nobody is signed in.
  const onlyOption = local.kind === "cloud" ? local : cloud ? null : local;

  // Tagged with the id it answers for, so a navigation to another project can
  // never be served the previous project's store while the probe is in flight.
  const [entry, setEntry] = React.useState<{ id: string; storage: ProjectStorage } | null>(
    null
  );

  React.useEffect(() => {
    if (onlyOption || !cloud) return;
    // Already answered for this project — the render below reads it straight
    // out of the cache, so there is nothing to set and nothing to probe.
    if (lookup(platform, projectId)) return;
    let live = true;
    void local
      .get(projectId)
      .catch(() => null)
      .then((doc) => {
        if (!live) return;
        // Not on this computer → it is the signed-in account's. The editor's own
        // subscription reports "not found" if it turns out to be neither.
        const storage = doc ? local : cloud;
        remember(platform, projectId, storage);
        setEntry({ id: projectId, storage });
      });
    return () => {
      live = false;
    };
  }, [platform, projectId, local, cloud, onlyOption]);

  if (onlyOption) return { status: "resolved", storage: onlyOption };

  const current =
    entry?.id === projectId ? entry.storage : lookup(platform, projectId);
  return current
    ? { status: "resolved", storage: current }
    : { status: "resolving", storage: null };
}
