"use client";

/**
 * THE only file in the app that touches `window.framevo`.
 *
 * Everything above it (editor, export panel, library) talks to the platform
 * ports in ../types. That is the rule that keeps desktop support from leaking
 * `window.electron`-style checks across 460 source files: if you find yourself
 * wanting one somewhere else, add a capability to the port instead.
 *
 * The desktop `ProjectStorage` mirrors the Firestore one exactly — same
 * `ProjectDoc` (materialized by the SAME whitelist mapper the web uses), same
 * merge-patch write path, same per-project write queue — so the editor cannot
 * tell which backend it is bound to.
 */
import { materializeProject } from "@/lib/firebase/materialize-project";
import { enqueueProjectWrite } from "@/lib/firebase/project-writer";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { isLocalProject } from "../local";
import type {
  DesktopAuthService,
  ExportService,
  LocalExportsService,
  LocalStorageService,
  MediaService,
  PlatformBridge,
  ProjectLibraryStats,
  ProjectStorage,
  ProjectSummary,
  SyncStatusSnapshot,
} from "../types";
import { DESKTOP_API_KEY, DESKTOP_API_VERSION, type DesktopApi } from "./ipc";
import type { ApplyRemoteResult, LocalSyncPort } from "@/lib/sync/ports";
import type { SyncOp, SyncProgress, SyncStatus } from "@/lib/sync/types";

declare global {
  interface Window {
    /** Installed by the Electron preload script. Absent in the browser. */
    [DESKTOP_API_KEY]?: DesktopApi;
  }
}

/**
 * The desktop API, or null in a browser. Also returns null (loudly) when the
 * preload contract is a different major version than this bundle expects —
 * better a clear message than a half-working app after a partial update.
 */
export function getDesktopApi(): DesktopApi | null {
  if (typeof window === "undefined") return null;
  const api = window[DESKTOP_API_KEY];
  if (!api) return null;
  if (api.version !== DESKTOP_API_VERSION) {
    console.error(
      `[desktop] preload API v${api.version} does not match renderer v${DESKTOP_API_VERSION}`
    );
    return null;
  }
  return api;
}

export function isDesktopRuntime(): boolean {
  return getDesktopApi() !== null;
}

function createDesktopProjectStorage(api: DesktopApi): ProjectStorage {
  return {
    kind: "local",
    label: "Local library",

    subscribe(projectId, onChange) {
      let live = true;
      // Initial read, then live updates. Main broadcasts the full document after
      // every committed write, so the editor's optimistic UI is confirmed by the
      // same "document changed" path Firestore's onSnapshot provides.
      void api.projects
        .get(projectId)
        .then((raw) => {
          if (!live) return;
          onChange(raw ? materializeProject(projectId, raw) : null);
        })
        .catch((err) => {
          console.error("[desktop-storage] initial read failed", err);
          if (live) onChange(null);
        });

      const off = api.projects.onChanged((event) => {
        if (!live || event.projectId !== projectId) return;
        onChange(event.doc ? materializeProject(projectId, event.doc) : null);
      });

      return () => {
        live = false;
        off();
      };
    },

    async get(projectId): Promise<ProjectDoc | null> {
      const raw = await api.projects.get(projectId);
      return raw ? materializeProject(projectId, raw) : null;
    },

    async write(projectId, patch, options = {}) {
      const commit = () => api.projects.write({ projectId, patch });
      if (!options.queue && !options.coalesceTag) {
        await commit();
        return;
      }
      await enqueueProjectWrite(
        projectId,
        options.label ?? "project-write",
        commit,
        options.coalesceTag ? { coalesceTag: options.coalesceTag } : undefined
      );
    },

    list(): Promise<ProjectSummary[]> {
      return api.projects.list();
    },

    stats(): Promise<ProjectLibraryStats> {
      return api.projects.stats();
    },

    onLibraryChanged(handler) {
      return api.projects.onChanged(() => handler());
    },

    async create(mediaId, title): Promise<ProjectDoc> {
      const raw = await api.projects.create({ mediaId, title });
      return materializeProject(String(raw.id), raw);
    },

    delete(projectId): Promise<void> {
      return api.projects.delete(projectId);
    },

    async resolveRecovery(projectId, action): Promise<ProjectDoc | null> {
      const raw = await api.projects.recover(projectId, action);
      return raw ? materializeProject(projectId, raw) : null;
    },

    pendingRecovery(): Promise<ProjectSummary[]> {
      return api.projects.pendingRecovery();
    },

    linkCloud(projectId, cloudProjectId): Promise<void> {
      return api.projects.linkCloud(projectId, cloudProjectId);
    },
  };
}

function createDesktopMediaService(api: DesktopApi): MediaService {
  return {
    canPickLocalFiles: true,
    pickVideo: () => api.media.pick(),
    // Present only when the MAIN bundle actually has the handler. The two
    // halves are built separately, so a renderer newer than main is a real
    // state — and leaving this undefined there means the UI shows no drop
    // target instead of one that throws when you use it.
    importDroppedFile:
      typeof api.media.importFile === "function"
        ? (file: File) => api.media.importFile(file)
        : undefined,
    resolve: (mediaId) => api.media.resolve(mediaId),
    revealOutput: (outputId) => api.media.reveal(outputId),
    saveRecording: (bytes, fileName) => api.media.saveRecording({ bytes, fileName }),
  };
}

function createDesktopAuthService(api: DesktopApi): DesktopAuthService {
  return {
    signInWithGoogle: () => api.auth.googleSignIn(),
    cancel: () => api.auth.cancel(),
  };
}

function createLocalExportsService(api: DesktopApi): LocalExportsService {
  return {
    list: () => api.localExports.list(),
    play: (outputId) => api.localExports.play(outputId),
    reveal: (outputId) => api.media.reveal(outputId),
    remove: (outputId, deleteFile) => api.localExports.remove(outputId, deleteFile),
  };
}

function createLocalStorageService(api: DesktopApi): LocalStorageService {
  return {
    usage: () => api.storage.usage(),
    openLibraryFolder: () => api.storage.openFolder(),
    purgeMissingMedia: () => api.storage.purgeMissingMedia(),
    purgeStaleExports: () => api.storage.purgeStaleExports(),
    compactAutosaves: () => api.storage.compactAutosaves(),
  };
}

function createDesktopExportService(api: DesktopApi): ExportService {
  return {
    chooseOutput: (suggestedName) => api.export.chooseOutput(suggestedName),
    listEncoders: () => api.export.encoders(),
    start: (request) => api.export.start(request),
    cancel: (jobId) => api.export.cancel(jobId),
    onProgress: (handler) =>
      api.export.onProgress(({ jobId, ...progress }) => handler(jobId, progress)),
    onDone: (handler) => api.export.onDone(({ jobId, result }) => handler(jobId, result)),
    onFailed: (handler) =>
      api.export.onFailed(({ jobId, message, code }) => handler(jobId, { message, code })),
    onCanceled: (handler) => api.export.onCanceled(({ jobId }) => handler(jobId)),
  };
}

/**
 * Build the desktop bridge.
 *
 * `appInfo` is fetched once at boot by the provider so the synchronous
 * `platform.app` accessor the UI uses is never a promise. `cloudProjects` is
 * the signed-in user's Firestore storage — present only while signed in, and
 * the reason the desktop can open a project it did not create locally.
 */
export function createDesktopPlatform(
  api: DesktopApi,
  appInfo: PlatformBridge["app"],
  cloudProjects: ProjectStorage | null
): PlatformBridge {
  const local = createDesktopProjectStorage(api);
  /**
   * The engine's LocalSyncPort, one IPC hop away. Typed HERE (rather than in
   * platform/types.ts) so the platform contract stays free of sync internals —
   * this is the only file that needs to know the two shapes are the same.
   */
  // The IPC surface is deliberately typed `unknown` (structured clone erases
  // types anyway, and DesktopApi should not depend on the sync module). These
  // casts are the one place the two ends are asserted to agree; the shared
  // interfaces in lib/sync/ports.ts are what actually keeps them agreeing, and
  // the round trip is covered by desktop/test/sync-*.test.mts.
  const queue: LocalSyncPort = {
    claim: (ownerUid, now, limit, entities) =>
      api.sync.claim(ownerUid, now, limit, entities) as Promise<SyncOp[]>,
    ack: (opId, now) => api.sync.ack(opId, now),
    fail: (opId, error, now) => api.sync.fail(opId, error, now),
    supersede: (args) => api.sync.supersede(args),
    applyRemote: (remote, ownerUid, now) =>
      api.sync.applyRemote(remote, ownerUid, now) as Promise<ApplyRemoteResult>,
    pendingDeletes: (ownerUid) => api.sync.pendingDeletes(ownerUid),
    markDeleteSynced: (entityId) => api.sync.markDeleteSynced(entityId),
    progress: (ownerUid) => api.sync.progress(ownerUid) as Promise<SyncProgress>,
    status: (projectId) => api.sync.status(projectId) as Promise<SyncStatus | null>,
  };

  return {
    kind: "desktop",
    projects: local,
    cloudProjects,
    // A document names its own home: the local sentinel uid means SQLite, a
    // Firebase uid means Firestore. Falling back to local keeps a brand-new,
    // not-yet-loaded document editable offline.
    storageFor(doc) {
      if (!doc) return local;
      return isLocalProject(doc) ? local : (cloudProjects ?? local);
    },
    media: createDesktopMediaService(api),
    export: createDesktopExportService(api),
    localExports: createLocalExportsService(api),
    storage: createLocalStorageService(api),
    auth: createDesktopAuthService(api),
    app: appInfo,
    sync: {
      setOwner: (uid) => api.sync.setOwner(uid),
      // The engine's LocalSyncPort, one IPC hop away. Shapes match by
      // construction: both sides import the same interface.
      queue,
      status: (projectId) => api.sync.status(projectId) as Promise<SyncStatusSnapshot | null>,
      retry: (projectId) => api.sync.retry(projectId),
      resolveConflict: (projectId, choices) => api.sync.resolveConflict(projectId, choices),
      onChanged: (handler) => api.sync.onChanged(handler),
      media: {
        requestUpload: (projectId) => api.sync.media.requestUpload(projectId),
        requestDownload: (projectId) => api.sync.media.requestDownload(projectId),
        cancelDownload: (projectId) => api.sync.media.cancelDownload(projectId),
        retry: (projectId) => api.sync.media.retry(projectId),
        list: () => api.sync.media.list(),
        claimUpload: (ownerUid) => api.sync.media.claimUpload(ownerUid),
        uploadProgress: (mediaId, bytesSent) =>
          api.sync.media.uploadProgress(mediaId, bytesSent),
        completeUpload: (args) => api.sync.media.completeUpload(args),
        failUpload: (mediaId, error) => api.sync.media.failUpload(mediaId, error),
        onChanged: (handler) => api.sync.media.onChanged(handler),
      },
    },
    libraryHref: "/dashboard/projects",
    // Pages that only exist on the website (admin, marketing, docs) open in the
    // real browser instead of dead-ending in the static bundle.
    webAppOrigin: appInfo?.apiBaseUrl || null,
    openExternal(url) {
      void api.shell.openExternal(url);
    },
  };
}
