"use client";

/**
 * Platform resolution + React access.
 *
 * `PlatformProvider` picks ONE bridge at boot — the desktop bridge when the
 * Electron preload installed its API, the web bridge otherwise — and every
 * consumer reads capabilities off it (`platform.media.canPickLocalFiles`,
 * `platform.export !== null`, …) instead of sniffing the runtime.
 *
 * The web bridge is exactly today's behaviour: Firestore storage for the signed
 * in user, no local media picking, no local export engine (the browser exports
 * through the existing in-browser/cloud engines).
 *
 * The desktop bridge carries BOTH backends. Its `projects` is the local SQLite
 * library; `cloudProjects` is the signed-in user's Firestore, which exists as
 * soon as they sign in and disappears when they sign out. That pair is what
 * lets one editor open a project from either place — see `storageFor`.
 */
import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { createCloudProjectStorage } from "./cloud-project-storage";
import { createDesktopPlatform, getDesktopApi } from "./desktop/bridge";
import type { AppInfo, MediaService, PlatformBridge, ProjectStorage } from "./types";

/** Storage stub for a signed-out web session — the dashboard gates on auth. */
function signedOutStorage(): ProjectStorage {
  const explain = () =>
    new Error("Sign in to open cloud projects.");
  return {
    kind: "cloud",
    label: "Firestore (signed out)",
    subscribe(_projectId, onChange) {
      onChange(null);
      return () => {};
    },
    async get() {
      return null;
    },
    async write() {
      throw explain();
    },
  };
}

/**
 * The browser cannot hold a durable reference to a file on disk (a File handle
 * dies with the tab), which is the whole reason the local project library is a
 * desktop capability. Say so plainly rather than pretending to support it.
 */
const webMedia: MediaService = {
  canPickLocalFiles: false,
  async pickVideo() {
    throw new Error("Importing files from this computer requires the Framevo desktop app.");
  },
  async resolve() {
    return null;
  },
  async revealOutput() {
    throw new Error("Revealing files in a folder requires the Framevo desktop app.");
  },
};

function createWebPlatform(uid: string | null): PlatformBridge {
  const projects = uid ? createCloudProjectStorage(uid) : signedOutStorage();
  return {
    kind: "web",
    projects,
    cloudProjects: projects,
    storageFor: () => projects,
    media: webMedia,
    export: null,
    localExports: null,
    storage: null,
    auth: null,
    app: null,
    // Nothing to reconcile on the web: Firestore is the store, not a mirror of
    // one. A no-op implementation here would be a lie about what the platform
    // can do — see the "null, never a fake" rule in ./types.ts.
    sync: null,
    libraryHref: "/dashboard/projects",
    // The website IS the website — those routes are ordinary in-app links.
    webAppOrigin: null,
    openExternal(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
  };
}

const PlatformContext = React.createContext<PlatformBridge | null>(null);

export function PlatformProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const api = React.useMemo(() => getDesktopApi(), []);
  const [appInfo, setAppInfo] = React.useState<AppInfo | null>(null);

  React.useEffect(() => {
    if (!api) return;
    let live = true;
    void api.app
      .info()
      .then((info) => {
        if (live) setAppInfo(info);
      })
      .catch((err) => console.error("[platform] app info failed", err));
    return () => {
      live = false;
    };
  }, [api]);

  // Rebuilt only when the SIGNED-IN USER changes, so a cloud subscription is
  // never torn down by an unrelated re-render.
  const cloud = React.useMemo(
    () => (uid ? createCloudProjectStorage(uid) : null),
    [uid]
  );

  const platform = React.useMemo<PlatformBridge>(
    () => (api ? createDesktopPlatform(api, appInfo, cloud) : createWebPlatform(uid)),
    [api, appInfo, cloud, uid]
  );

  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

/**
 * The active platform. Falls back to the web bridge (signed out) when no
 * provider is mounted, so isolated component tests and the marketing pages
 * don't need one.
 */
export function usePlatform(): PlatformBridge {
  const ctx = React.useContext(PlatformContext);
  const fallback = React.useMemo(() => createWebPlatform(null), []);
  return ctx ?? fallback;
}

/** True when the local (desktop) export engine is available. */
export function useLocalExport() {
  return usePlatform().export;
}

export type {
  AppInfo,
  DesktopAuthService,
  EncoderId,
  EncoderInfo,
  ExportService,
  ImportedMedia,
  LocalExportProgress,
  LocalExportRecord,
  LocalExportRequest,
  LocalExportResult,
  LocalExportsService,
  LocalStorageService,
  LocalStorageUsage,
  MediaService,
  PlatformBridge,
  PlatformKind,
  ProjectLibraryStats,
  ProjectStorage,
  ProjectSummary,
  ProjectWriteOptions,
} from "./types";
export { arrayRemove, arrayUnion, deleteField, serverTimestamp } from "./field-value";
export type { DocPatch } from "./field-value";
export { LOCAL_OWNER, MEDIA_URL_PREFIX, isCloudOnlyVideo, isLocalProject } from "./local";
