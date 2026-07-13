"use client";

import * as React from "react";
import {
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { getFirebase } from "./client";
import { useAuth } from "./AuthProvider";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  type NotificationPreferences,
  type WorkspaceSettings,
} from "./schema";
import { isValidPresetId } from "@/lib/presets/registry";
import { MAX_RECENT_PRESETS } from "@/lib/presets/types";

/**
 * Live + writable per-user workspace settings.
 *
 * Reads `users/{uid}/settings/workspace` with `onSnapshot` so other tabs
 * + other surfaces (notifications store, new-project defaults) see
 * updates immediately. Returns merged defaults — undefined fields on the
 * Firestore doc fall back to `DEFAULT_WORKSPACE_SETTINGS` so older
 * accounts work without migration.
 *
 * Writes via `setDoc(..., { merge: true })` so partial updates from one
 * section don't clobber another.
 */
export interface ResolvedWorkspaceSettings {
  defaultPresetId: string;
  defaultExportFormat: WorkspaceSettings["defaultExportFormat"] & string;
  notifications: Required<NotificationPreferences>;
  analysisEngines: Required<NonNullable<WorkspaceSettings["analysisEngines"]>>;
  analysisDetail: Required<NonNullable<WorkspaceSettings["analysisDetail"]>>;
  presetLibrary: Required<NonNullable<WorkspaceSettings["presetLibrary"]>>;
  updatedAt?: number;
}

/** Classified error from the settings subscription — mirrors `useApiKeys`. */
export interface WorkspaceSettingsError {
  code: "permission-denied" | "unknown";
  message: string;
}

export function useWorkspaceSettings(): {
  settings: ResolvedWorkspaceSettings;
  loading: boolean;
  error: WorkspaceSettingsError | null;
  save: (patch: Partial<Omit<WorkspaceSettings, "updatedAt">>) => Promise<void>;
} {
  const { user } = useAuth();
  const [raw, setRaw] = React.useState<WorkspaceSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<WorkspaceSettingsError | null>(null);

  React.useEffect(() => {
    if (!user) {
      setRaw(null);
      setLoading(false);
      setError(null);
      return;
    }
    setError(null);
    setLoading(true);
    const { db } = getFirebase();
    const ref = doc(db, "users", user.uid, "settings", "workspace");
    const unsub = onSnapshot(
      ref,
      (snap) => {
        setError(null);
        const data = snap.exists() ? (snap.data() as WorkspaceSettings) : {};
        const createdAt =
          (data.updatedAt as unknown as { toMillis?: () => number } | undefined)
            ?.toMillis?.() ?? (typeof data.updatedAt === "number" ? data.updatedAt : undefined);
        setRaw({ ...data, updatedAt: createdAt });
        setLoading(false);
      },
      (err) => {
        // Mirror `useApiKeys` — distinguish permission-denied (rules
        // missing) from other failures so the UI can show a precise
        // diagnosis. Log the raw error in dev for bug-report copy-paste.
        if (process.env.NODE_ENV !== "production") {
          console.error("[useWorkspaceSettings] onSnapshot error", err);
        }
        const e = err as { code?: string };
        const code: WorkspaceSettingsError["code"] =
          e?.code === "permission-denied" ? "permission-denied" : "unknown";
        setError({ code, message: err.message });
        setLoading(false);
      }
    );
    return () => unsub();
  }, [user]);

  const settings = React.useMemo(() => mergeWithDefaults(raw), [raw]);

  const save = React.useCallback(
    async (patch: Partial<Omit<WorkspaceSettings, "updatedAt">>) => {
      if (!user) throw new Error("Not signed in.");
      const { db } = getFirebase();
      const ref = doc(db, "users", user.uid, "settings", "workspace");
      // `serverTimestamp()` is preferred over `Date.now()` so writes
      // from clocks-skewed devices still order correctly server-side.
      await setDoc(
        ref,
        { ...patch, updatedAt: serverTimestamp() },
        { merge: true }
      );
    },
    [user]
  );

  return { settings, loading, error, save };
}

function mergeWithDefaults(
  raw: WorkspaceSettings | null
): ResolvedWorkspaceSettings {
  return {
    defaultPresetId:
      raw?.defaultPresetId ?? DEFAULT_WORKSPACE_SETTINGS.defaultPresetId,
    defaultExportFormat:
      raw?.defaultExportFormat ?? DEFAULT_WORKSPACE_SETTINGS.defaultExportFormat,
    notifications: mergeNotifications(raw?.notifications),
    analysisEngines: mergeAnalysisEngines(raw?.analysisEngines),
    analysisDetail: mergeAnalysisDetail(raw?.analysisDetail),
    presetLibrary: mergePresetLibrary(raw?.presetLibrary),
    updatedAt: raw?.updatedAt,
  };
}

/**
 * Favourites + recents, filtered against the LIVE registry.
 *
 * A preset id that no longer exists (renamed, retired) is dropped on read rather
 * than surfacing as a broken card. Doing it here — at the single resolve point —
 * means every consumer gets valid ids and no UI has to defend against a stale
 * one.
 */
function mergePresetLibrary(
  raw: WorkspaceSettings["presetLibrary"]
): Required<NonNullable<WorkspaceSettings["presetLibrary"]>> {
  const clean = (ids: string[] | undefined, cap: number): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids ?? []) {
      if (typeof id !== "string" || !isValidPresetId(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= cap) break;
    }
    return out;
  };
  return {
    favouriteIds: clean(raw?.favouriteIds, 200),
    recentIds: clean(raw?.recentIds, MAX_RECENT_PRESETS),
  };
}

function mergeAnalysisDetail(
  raw: WorkspaceSettings["analysisDetail"]
): Required<NonNullable<WorkspaceSettings["analysisDetail"]>> {
  const d = DEFAULT_WORKSPACE_SETTINGS.analysisDetail;
  return {
    chunkMode: raw?.chunkMode ?? d.chunkMode ?? "balanced",
    chunkSizeSeconds: raw?.chunkSizeSeconds ?? d.chunkSizeSeconds ?? 30,
  };
}

function mergeAnalysisEngines(
  raw: WorkspaceSettings["analysisEngines"]
): Required<NonNullable<WorkspaceSettings["analysisEngines"]>> {
  const d = DEFAULT_WORKSPACE_SETTINGS.analysisEngines;
  return {
    generateCameraEdits: raw?.generateCameraEdits ?? d.generateCameraEdits ?? true,
    generateCut: raw?.generateCut ?? d.generateCut ?? true,
    generateSpeed: raw?.generateSpeed ?? d.generateSpeed ?? true,
  };
}

function mergeNotifications(
  raw: NotificationPreferences | undefined
): Required<NotificationPreferences> {
  return {
    renderComplete:
      raw?.renderComplete ?? DEFAULT_WORKSPACE_SETTINGS.notifications.renderComplete ?? true,
    weeklyDigest:
      raw?.weeklyDigest ?? DEFAULT_WORKSPACE_SETTINGS.notifications.weeklyDigest ?? false,
    productNews:
      raw?.productNews ?? DEFAULT_WORKSPACE_SETTINGS.notifications.productNews ?? true,
  };
}
