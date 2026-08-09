/**
 * Preload — the ONLY bridge between the sandboxed renderer and the main
 * process.
 *
 * It runs with `contextIsolation: true` and `sandbox: true`, so it has no Node
 * API beyond `ipcRenderer`/`contextBridge` — by construction it cannot leak
 * `fs`, `child_process` or `process` into the page. What it exposes is a fixed,
 * hand-written list of functions: no dynamic channel names, no `invoke(channel,
 * …)` passthrough, and event subscriptions that hand the listener a plain
 * payload (never the Electron event, which carries `sender`).
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  DESKTOP_API_KEY,
  DESKTOP_API_VERSION,
  IPC,
  ipcErrorMessage,
  type DesktopApi,
} from "../../../src/lib/platform/desktop/ipc";

/**
 * Call a main-process handler, re-throwing its failure as the message the user
 * should read.
 *
 * Electron prefixes every rejected `invoke` with `Error invoking remote method
 * '<channel>':` — plumbing detail that ends up in dialogs and error banners,
 * because components render `err.message`. The channel name is still in the
 * main-process log, where it belongs.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    throw new Error(ipcErrorMessage(err));
  }
}

/** Subscribe to a main→renderer channel, stripping the IpcRendererEvent. */
function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: DesktopApi = {
  version: DESKTOP_API_VERSION,

  app: {
    info: () => invoke(IPC.appInfo),
  },

  projects: {
    list: () => invoke(IPC.projectsList),
    stats: () => invoke(IPC.projectsStats),
    get: (projectId) => invoke(IPC.projectsGet, projectId),
    create: (request) => invoke(IPC.projectsCreate, request),
    write: (request) => invoke(IPC.projectsWrite, request),
    delete: (projectId) => invoke(IPC.projectsDelete, projectId),
    recover: (projectId, action) => invoke(IPC.projectsRecover, projectId, action),
    pendingRecovery: () => invoke(IPC.projectsPendingRecovery),
    linkCloud: (projectId, cloudProjectId) =>
      invoke(IPC.projectsLinkCloud, projectId, cloudProjectId),
    onChanged: (handler) => on(IPC.projectsChanged, handler),
  },

  media: {
    pick: () => invoke(IPC.mediaPick),
    // The ONE place a `File` becomes a path. `webUtils.getPathForFile` is the
    // only way to read it in Electron 32+ (`File.path` was removed), and doing
    // it here means the renderer never holds — or gets to invent — a path: it
    // can only forward a file the OS handed the page via a drop.
    importFile: (file) => invoke(IPC.mediaImportFile, webUtils.getPathForFile(file)),
    resolve: (mediaId) => invoke(IPC.mediaResolve, mediaId),
    reveal: (outputId) => invoke(IPC.mediaReveal, outputId),
    saveRecording: (request) => invoke(IPC.mediaSaveRecording, request),
  },

  auth: {
    googleSignIn: () => invoke(IPC.authGoogleStart),
    cancel: () => invoke(IPC.authGoogleCancel),
  },

  localExports: {
    list: () => invoke(IPC.exportsList),
    play: (outputId) => invoke(IPC.exportsPlay, outputId),
    remove: (outputId, deleteFile) =>
      invoke(IPC.exportsRemove, outputId, deleteFile),
  },

  storage: {
    usage: () => invoke(IPC.storageUsage),
    openFolder: () => invoke(IPC.storageOpenFolder),
    purgeMissingMedia: () => invoke(IPC.storagePurgeMedia),
    purgeStaleExports: () => invoke(IPC.storagePurgeExports),
    compactAutosaves: () => invoke(IPC.storageCompact),
  },

  export: {
    chooseOutput: (suggestedName) => invoke(IPC.exportChooseOutput, suggestedName),
    encoders: () => invoke(IPC.exportEncoders),
    start: (request) => invoke(IPC.exportStart, request),
    cancel: (jobId) => invoke(IPC.exportCancel, jobId),
    onProgress: (handler) => on(IPC.exportProgress, handler),
    onDone: (handler) => on(IPC.exportDone, handler),
    onFailed: (handler) => on(IPC.exportFailed, handler),
    onCanceled: (handler) => on(IPC.exportCanceled, handler),
  },

  shell: {
    openExternal: (url) => invoke(IPC.shellOpenExternal, url),
  },
  sync: {
    setOwner: (uid) => invoke(IPC.syncSetOwner, uid),
    claim: (ownerUid, now, limit, entities) =>
      invoke(IPC.syncClaim, { ownerUid, now, limit, entities }),
    ack: (opId, now) => invoke(IPC.syncAck, { opId, now }),
    fail: (opId, error, now) => invoke(IPC.syncFail, { opId, error, now }),
    supersede: (args) => invoke(IPC.syncSupersede, args),
    applyRemote: (remote, ownerUid, now) =>
      invoke(IPC.syncApplyRemote, { remote, ownerUid, now }),
    pendingDeletes: (ownerUid) => invoke(IPC.syncPendingDeletes, ownerUid),
    markDeleteSynced: (entityId) => invoke(IPC.syncMarkDeleteSynced, entityId),
    progress: (ownerUid) => invoke(IPC.syncProgress, ownerUid),
    status: (projectId) => invoke(IPC.syncStatus, projectId),
    retry: (projectId) => invoke(IPC.syncRetry, projectId),
    resolveConflict: (projectId, choices) =>
      invoke(IPC.syncResolveConflict, { projectId, choices }),
    onChanged: (handler) => on(IPC.syncChanged, handler),
    media: {
      requestUpload: (projectId) => invoke(IPC.mediaUploadRequest, projectId),
      requestDownload: (projectId) => invoke(IPC.mediaDownloadRequest, projectId),
      cancelDownload: (projectId) => invoke(IPC.mediaDownloadCancel, projectId),
      retry: (projectId) => invoke(IPC.mediaTransferRetry, projectId),
      list: () => invoke(IPC.mediaTransferList),
      claimUpload: (ownerUid) => invoke(IPC.mediaUploadClaim, ownerUid),
      uploadProgress: (mediaId, bytesSent) =>
        invoke(IPC.mediaUploadProgress, { mediaId, bytesSent }),
      completeUpload: (request) => invoke(IPC.mediaUploadComplete, request),
      failUpload: (mediaId, error) =>
        invoke(IPC.mediaUploadFail, { mediaId, error }),
      onChanged: (handler) => on(IPC.mediaTransferChanged, handler),
    },
  },
};

contextBridge.exposeInMainWorld(DESKTOP_API_KEY, api);
