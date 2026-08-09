/**
 * IPC handlers — the app's entire trust boundary.
 *
 * Every handler validates its arguments with the shared validators from
 * `@/lib/platform/desktop/ipc` BEFORE touching the database, the filesystem or
 * a child process, and every handler returns plain data (never a path, never a
 * handle to anything). Errors are converted to short user-facing messages: an
 * internal message could carry a path or a stack, and this string crosses into
 * the renderer.
 *
 * There is intentionally no generic passthrough channel, no "read file", no
 * "run command", and no way for the renderer to name a path.
 */
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { basename, dirname } from "node:path";
import { eq } from "drizzle-orm";
import {
  ACCEPTED_VIDEO_EXTENSIONS,
  IPC,
  IpcValidationError,
  validateByteCount,
  validateDownloadUrl,
  validateExportRequest,
  validateExternalUrl,
  validateHandle,
  validateConflictChoices,
  validateDocument,
  validateOwnerUid,
  validateRevision,
  validateTimestamp,
  validatePatch,
  validateRecordingBytes,
  validateRecordingName,
  validateTitle,
} from "@/lib/platform/desktop/ipc";
import type {
  AppInfo,
  EncoderInfo,
  ImportedMedia,
  MediaTransferSnapshot,
  MediaUploadJobView,
  ProjectSummary,
} from "@/lib/platform/types";
import type { LocalDb } from "./db/client";
import { exports as exportsTable } from "./db/schema";
import type { Library } from "./library";
import type { SyncStore } from "./sync-store";
import { logger, reportError } from "./logger";
import { fireAndForget as runFireAndForget } from "./db/write";
import { MediaValidationError, toImportedMedia, type MediaStore } from "./media";
import { APP_ORIGIN, mediaUrl } from "./protocol";
import { detectEncoders, pickEncoder } from "./export/encoders";
import { ExportService } from "./export/service";
import { newId } from "./ids";
import type { ExportsStore } from "./exports-store";
import type { StorageService } from "./storage-usage";
import type { MediaUploadsStore, MediaUploadSnapshot } from "./media-uploads";
import type { MediaDownloadsStore, MediaDownloadSnapshot } from "./media-downloads";
import type { DownloadRunner } from "./download-runner";
import { cancelGoogleSignIn, startGoogleSignIn } from "./auth/google-desktop";

export interface IpcContext {
  db: LocalDb;
  library: Library;
  mediaStore: MediaStore;
  exportService: ExportService;
  exportsStore: ExportsStore;
  storageService: StorageService;
  appInfo: AppInfo;
  ffmpeg: { ffmpeg: string; ffprobe: string };
  /** Absolute path of the bundled render CLI. */
  renderCliPath: string;
  /** Folder holding the SQLite library + saved recordings. */
  libraryDir: string;
  /** The crash-recovery snapshot taken at launch. See projectsPendingRecovery. */
  recoveryAtLaunch: RecoverySnapshot;
  /** Google DESKTOP OAuth client id. Public by design; there is no secret here. */
  googleClientId: string;
  mainWindow(): BrowserWindow | null;
  /**
   * Record which account the renderer is signed into. Main cannot discover this
   * on its own — the Firebase session lives in the renderer — and every queued
   * sync operation is stamped with it, so it is the authentication isolation
   * boundary for the whole queue.
   */
  setOwnerUid(uid: string | null): void;
  /** The account the renderer last reported. Null while signed out. */
  currentOwnerUid(): string | null;
  syncStore: SyncStore;
  /** The source video's queues, in each direction. */
  mediaUploads: MediaUploadsStore;
  mediaDownloads: MediaDownloadsStore;
  downloadRunner: DownloadRunner;
  /**
   * Stream a file to compute its checksums. Takes a PATH — main-process only,
   * and never a value that came from the renderer; `media-uploads.ts` supplies
   * it from its own media row.
   */
  digestFile(path: string): Promise<{ sha256: string; md5Base64: string; sizeBytes: number }>;
}

/**
 * Projects the previous session left mid-edit, held for THIS run.
 *
 * Captured before the window opens, so nothing the user does in this session
 * can get into it — and drained as they answer, so the prompt appears once
 * however many times the page reloads.
 */
export class RecoverySnapshot {
  private pending: ProjectSummary[];

  constructor(pending: ProjectSummary[]) {
    this.pending = pending;
  }

  list(): ProjectSummary[] {
    return this.pending;
  }

  resolve(projectId: string): void {
    this.pending = this.pending.filter((p) => p.id !== projectId);
  }
}

/** A message safe to show a user and safe to cross the process boundary. */
function toUserMessage(err: unknown): string {
  if (err instanceof IpcValidationError) return "That request wasn't valid.";
  if (err instanceof MediaValidationError) return err.message;
  if (err instanceof Error && err.message.length < 200 && !/[\\/]/.test(err.message)) {
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

/** Wrap a handler so it logs richly on this side and answers thinly on the other. */
/** A write nothing awaits — see db/write.ts for why this cannot be `void db…`. */
function fireAndForget(query: PromiseLike<unknown>, what: string): void {
  runFireAndForget(query, what, (message, meta) => logger.warn(message, meta));
}

function handle<T>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T>
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      if (err instanceof IpcValidationError) {
        logger.warn("ipc rejected", { channel, reason: err.message });
      } else {
        reportError(err, { channel });
      }
      throw new Error(toUserMessage(err));
    }
  });
}

export function registerIpc(ctx: IpcContext): void {
  const broadcast = (channel: string, payload: unknown) => {
    const win = ctx.mainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // ── App ───────────────────────────────────────────────────────────────────
  handle(IPC.appInfo, async () => ctx.appInfo);

  // ── Projects ──────────────────────────────────────────────────────────────
  handle(IPC.projectsList, async () => ctx.library.list());

  /**
   * Counts, not projects. The dashboard asks this instead of `list()` so
   * showing "31" never costs 31 rows, 31 media joins and 31 preview URLs.
   */
  handle(IPC.projectsStats, async () => ctx.library.stats());

  handle(IPC.projectsGet, async (_e, rawId) => {
    const projectId = validateHandle(rawId, "projectId");
    const doc = await ctx.library.get(projectId);
    if (doc) await ctx.library.markOpen(projectId, true);
    return doc;
  });

  handle(IPC.projectsCreate, async (_e, raw) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    const mediaId = validateHandle(input.mediaId, "mediaId");
    const title = validateTitle(input.title);
    const media = await ctx.mediaStore.get(mediaId);
    if (!media) throw new MediaValidationError("That video is no longer available.");
    const doc = await ctx.library.create({ mediaId, title, mediaUrl: mediaUrl(mediaId) });
    logger.info("project created", { projectId: doc.id });
    return doc;
  });

  handle(IPC.projectsWrite, async (_e, raw) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    const projectId = validateHandle(input.projectId, "projectId");
    const patch = validatePatch(input.patch);
    const doc = await ctx.library.write(projectId, patch);
    // Mirrors Firestore's onSnapshot: the write is confirmed by a document
    // broadcast, so the editor's subscription is the single source of truth.
    broadcast(IPC.projectsChanged, { projectId, doc });
  });

  handle(IPC.projectsDelete, async (_e, rawId) => {
    const projectId = validateHandle(rawId, "projectId");
    await ctx.library.remove(projectId);
    logger.info("project deleted", { projectId });
    broadcast(IPC.projectsChanged, { projectId, doc: null });
  });

  handle(IPC.projectsRecover, async (_e, rawId, rawAction) => {
    const projectId = validateHandle(rawId, "projectId");
    if (rawAction !== "keep" && rawAction !== "discard") {
      throw new IpcValidationError("recovery action must be keep or discard");
    }
    const doc = await ctx.library.resolveRecovery(projectId, rawAction);
    // Answered — drop it from the launch snapshot so a later page load (a
    // refresh, a deep link) does not raise the same prompt again.
    ctx.recoveryAtLaunch.resolve(projectId);
    logger.info("recovery resolved", { projectId, action: rawAction });
    broadcast(IPC.projectsChanged, { projectId, doc });
    return doc;
  });

  /**
   * What the PREVIOUS run left unfinished — computed ONCE during bootstrap,
   * before any project could be opened in this session. Re-deriving it here
   * would include whatever the user has open right now, and every reload would
   * announce a crash that never happened.
   */
  handle(IPC.projectsPendingRecovery, async () => ctx.recoveryAtLaunch.list());

  handle(IPC.projectsLinkCloud, async (_e, rawId, rawCloudId) => {
    const projectId = validateHandle(rawId, "projectId");
    // Firestore auto-ids are 20 chars of the same alphabet our handles use, so
    // the same validator covers them.
    const cloudProjectId = validateHandle(rawCloudId, "cloudProjectId");
    await ctx.library.linkCloud(projectId, cloudProjectId);
    logger.info("project linked to cloud", { projectId, cloudProjectId });
    broadcast(IPC.projectsChanged, {
      projectId,
      doc: await ctx.library.get(projectId),
    });
  });

  // ── Media ─────────────────────────────────────────────────────────────────
  handle(IPC.mediaPick, async (): Promise<ImportedMedia | null> => {
    const win = ctx.mainWindow();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Import a video",
      properties: ["openFile"],
      filters: [
        {
          name: "Video",
          extensions: ACCEPTED_VIDEO_EXTENSIONS.map((e) => e.slice(1)),
        },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    // The path came from the OS dialog, but it is still validated + probed —
    // a picker result is user input like any other.
    const row = await ctx.mediaStore.importPath(result.filePaths[0]);
    return toImportedMedia(row, mediaUrl);
  });

  /**
   * Import a dropped file.
   *
   * The path arrives from the preload's `webUtils.getPathForFile`, so it names
   * a file the OS itself handed the window. That is the same provenance as the
   * dialog result above and gets the same treatment: `importPath` validates it
   * (absolute, accepted extension, exists, non-empty) and probes it before any
   * row is written. Nothing here trusts the string because of where it came
   * from.
   */
  handle(IPC.mediaImportFile, async (_e, rawPath): Promise<ImportedMedia> => {
    if (typeof rawPath !== "string" || !rawPath) {
      throw new MediaValidationError("That item isn't a file Framevo can open.");
    }
    const row = await ctx.mediaStore.importPath(rawPath);
    return toImportedMedia(row, mediaUrl);
  });

  handle(IPC.mediaResolve, async (_e, rawId): Promise<ImportedMedia | null> => {
    const mediaId = validateHandle(rawId, "mediaId");
    const check = await ctx.mediaStore.revalidate(mediaId);
    if (!check || !check.ok) return null;
    return toImportedMedia(check.row, mediaUrl);
  });

  handle(IPC.mediaReveal, async (_e, rawId) => {
    const outputId = validateHandle(rawId, "outputId");
    const path = await ctx.exportsStore.pathFor(outputId);
    if (!path) throw new Error("Framevo no longer has a record of that file.");
    shell.showItemInFolder(path);
  });

  handle(IPC.mediaSaveRecording, async (_e, raw): Promise<ImportedMedia> => {
    const input = (raw ?? {}) as Record<string, unknown>;
    const bytes = validateRecordingBytes(input.bytes);
    const fileName = validateRecordingName(input.fileName);
    const row = await ctx.mediaStore.saveRecording(bytes, fileName);
    return toImportedMedia(row, mediaUrl);
  });

  // ── Authentication ────────────────────────────────────────────────────────
  // The interactive half runs in the user's real browser; this process only
  // brokers it. No credential is stored here — the Firebase SDK in the renderer
  // owns the session (see docs/desktop/auth.md).
  handle(IPC.authGoogleStart, async () => {
    const window = ctx.mainWindow();
    // Firebase would reject the token anyway; say why here rather than let the
    // user go through Google to be told "invalid credential" by name only.
    if (ctx.appInfo.buildMismatch) throw new Error(ctx.appInfo.buildMismatch);
    return startGoogleSignIn({
      clientId: ctx.googleClientId,
      apiBaseUrl: ctx.appInfo.apiBaseUrl,
      openExternal: (url) => shell.openExternal(url),
      // The browser tab is in front of the app by now; pull the window back so
      // the user sees the result of what they just did.
      onCallbackReceived: () => {
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore();
          window.focus();
        }
      },
      deepLink: `${APP_ORIGIN}/dashboard`,
    });
  });

  handle(IPC.authGoogleCancel, async () => {
    cancelGoogleSignIn();
  });

  // ── Local export library ──────────────────────────────────────────────────
  handle(IPC.exportsList, async () => ctx.exportsStore.list());

  handle(IPC.exportsPlay, async (_e, rawId) => {
    const outputId = validateHandle(rawId, "outputId");
    const path = await ctx.exportsStore.pathFor(outputId);
    if (!path) throw new Error("Framevo no longer has a record of that file.");
    // openPath resolves with a NON-EMPTY string when the OS refused it.
    const failure = await shell.openPath(path);
    if (failure) throw new Error("Your system couldn't open that file.");
  });

  handle(IPC.exportsRemove, async (_e, rawId, rawDeleteFile) => {
    const outputId = validateHandle(rawId, "outputId");
    if (typeof rawDeleteFile !== "boolean") {
      throw new IpcValidationError("deleteFile must be a boolean");
    }
    await ctx.exportsStore.remove(outputId, rawDeleteFile);
  });

  // ── Local storage ─────────────────────────────────────────────────────────
  handle(IPC.storageUsage, async () => ctx.storageService.usage());

  handle(IPC.storageOpenFolder, async () => {
    const failure = await shell.openPath(ctx.libraryDir);
    if (failure) throw new Error("Your system couldn't open that folder.");
  });

  handle(IPC.storagePurgeMedia, async () => ctx.storageService.purgeMissingMedia());

  handle(IPC.storagePurgeExports, async () => ctx.exportsStore.purgeStale());

  handle(IPC.storageCompact, async () => ctx.storageService.compactAutosaves());

  // ── Export ────────────────────────────────────────────────────────────────
  handle(IPC.exportEncoders, async (): Promise<EncoderInfo[]> =>
    detectEncoders(ctx.ffmpeg.ffmpeg)
  );

  handle(IPC.exportChooseOutput, async (_e, rawName) => {
    const suggested = validateTitle(rawName ?? "Framevo export");
    const win = ctx.mainWindow();
    const safeName = `${suggested.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Framevo export"}.mp4`;
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      title: "Export video",
      defaultPath: safeName,
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (result.canceled || !result.filePath) return null;
    // The chosen path is recorded against an opaque id; the renderer only ever
    // learns the FILE NAME, never the folder the user picked.
    const outputId = newId();
    await ctx.db.insert(exportsTable).values({
      id: outputId,
      projectId: "",
      projectTitle: suggested,
      path: result.filePath,
      fileName: basename(result.filePath),
      sizeBytes: 0,
      encoder: "",
      status: "pending",
      createdAt: Date.now(),
    });
    return { outputId, fileName: basename(result.filePath) };
  });

  handle(IPC.exportStart, async (_e, raw) => {
    const request = validateExportRequest(raw);

    const media = await ctx.mediaStore.revalidate(request.mediaId);
    if (!media) throw new MediaValidationError("That video is no longer in the library.");
    if (!media.ok) throw new MediaValidationError(media.reason ?? "The source video is unavailable.");

    const rows = await ctx.db
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, request.outputId))
      .limit(1);
    const output = rows[0];
    if (!output) throw new Error("Choose where to save the export first.");

    const encoders = await detectEncoders(ctx.ffmpeg.ffmpeg);
    const encoder = pickEncoder(encoders, request.encoder);

    await ctx.db
      .update(exportsTable)
      .set({
        projectId: request.projectId,
        projectTitle: request.projectTitle,
        encoder: encoder.id,
        status: "rendering",
      })
      .where(eq(exportsTable.id, request.outputId));

    ctx.exportService.start(
      {
        jobId: request.jobId,
        projectTitle: request.projectTitle,
        sourcePath: media.row.path,
        outputPath: output.path,
        recipe: request.recipe,
        encoder: encoder.id,
        cliPath: ctx.renderCliPath,
        ffmpegPath: ctx.ffmpeg.ffmpeg,
        ffprobePath: ctx.ffmpeg.ffprobe,
      },
      {
        onProgress: (progress) =>
          broadcast(IPC.exportProgress, { jobId: request.jobId, ...progress }),
        onDone: (result) => {
          fireAndForget(
            ctx.db
              .update(exportsTable)
              .set({ status: "ready", sizeBytes: result.sizeBytes })
              .where(eq(exportsTable.id, request.outputId)),
            "mark export ready"
          );
          // The renderer reveals the file by outputId, so hand back the id it
          // can act on rather than the job id.
          broadcast(IPC.exportDone, {
            jobId: request.jobId,
            result: { ...result, outputId: request.outputId },
          });
          logger.info("export complete", {
            jobId: request.jobId,
            encoder: result.encoder,
            sizeBytes: result.sizeBytes,
          });
        },
        onFailed: (error) => {
          fireAndForget(
            ctx.db
              .update(exportsTable)
              .set({ status: "failed" })
              .where(eq(exportsTable.id, request.outputId)),
            "mark export failed"
          );
          broadcast(IPC.exportFailed, { jobId: request.jobId, ...error });
        },
        onCanceled: () => {
          fireAndForget(
            ctx.db
              .update(exportsTable)
              .set({ status: "canceled" })
              .where(eq(exportsTable.id, request.outputId)),
            "mark export canceled"
          );
          broadcast(IPC.exportCanceled, { jobId: request.jobId });
        },
      }
    );
  });

  handle(IPC.exportCancel, async (_e, rawId) => {
    const jobId = validateHandle(rawId, "jobId");
    ctx.exportService.cancel(jobId);
  });

  // ── Shell ─────────────────────────────────────────────────────────────────
  handle(IPC.syncSetOwner, async (_e, rawUid) => {
    const uid = validateOwnerUid(rawUid);
    ctx.setOwnerUid(uid);
  });

  // ── Sync ──────────────────────────────────────────────────────────────────
  // The renderer supplies the network; every piece of durable state is here.
  // `requireOwner` is the isolation boundary: a caller cannot NAME an account,
  // only use the one the auth gate reported. Without it the renderer could ask
  // for another account's queued operations by passing its uid.
  const requireOwner = (claimed: unknown): string => {
    const uid = validateOwnerUid(claimed);
    const current = ctx.currentOwnerUid();
    if (!current || !uid || uid !== current) {
      throw new IpcValidationError("sync is not available for that account");
    }
    return current;
  };

  /**
   * The same boundary for calls that don't name an account at all.
   *
   * Transfers are always "mine" — there is no uid in the request, so there is
   * nothing to compare, only the reported session to require. Signed out, a
   * transfer has no owner to stamp and nowhere to put the bytes.
   */
  const requireSignedIn = (): string => {
    const current = ctx.currentOwnerUid();
    if (!current) throw new IpcValidationError("nobody is signed in");
    return current;
  };

  handle(IPC.syncClaim, async (_e, raw) => {
    const { ownerUid, now, limit, entities } = (raw ?? {}) as Record<string, unknown>;
    const uid = requireOwner(ownerUid);
    return ctx.syncStore.claim(
      uid,
      validateTimestamp(now),
      typeof limit === "number" ? Math.min(Math.max(1, limit), 200) : undefined,
      Array.isArray(entities) ? entities.filter((e): e is string => typeof e === "string") : undefined
    );
  });

  handle(IPC.syncAck, async (_e, raw) => {
    const { opId, now } = (raw ?? {}) as Record<string, unknown>;
    await ctx.syncStore.ack(validateHandle(opId, "opId"), validateTimestamp(now));
  });

  handle(IPC.syncFail, async (_e, raw) => {
    const { opId, error, now } = (raw ?? {}) as Record<string, unknown>;
    const detail = (error ?? {}) as { message?: unknown; code?: unknown };
    await ctx.syncStore.fail(
      validateHandle(opId, "opId"),
      {
        message: typeof detail.message === "string" ? detail.message.slice(0, 500) : "Sync failed",
        code: typeof detail.code === "string" ? detail.code.slice(0, 100) : undefined,
      },
      validateTimestamp(now)
    );
  });

  handle(IPC.syncSupersede, async (_e, raw) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    await ctx.syncStore.supersede({
      projectId: validateHandle(args.projectId, "projectId"),
      ownerUid: requireOwner(args.ownerUid),
      baseRev: validateRevision(args.baseRev),
      doc: validateDocument(args.doc),
      deviceId: validateHandle(args.deviceId, "deviceId"),
      now: validateTimestamp(args.now),
    });
  });

  handle(IPC.syncApplyRemote, async (_e, raw) => {
    const { remote, ownerUid, now } = (raw ?? {}) as Record<string, unknown>;
    const snapshot = (remote ?? {}) as Record<string, unknown>;
    return ctx.syncStore.applyRemote(
      {
        projectId: validateHandle(snapshot.projectId, "projectId"),
        doc: snapshot.doc === null ? null : validateDocument(snapshot.doc),
        rev: validateRevision(snapshot.rev),
        lastOpId: typeof snapshot.lastOpId === "string" ? snapshot.lastOpId : undefined,
        updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
      },
      requireOwner(ownerUid),
      validateTimestamp(now)
    );
  });

  handle(IPC.syncPendingDeletes, async (_e, rawUid) => {
    const uid = requireOwner(rawUid);
    const rows = await ctx.syncStore.unsyncedTombstones(uid);
    return rows.filter((r) => r.entity === "project").map((r) => ({ entityId: r.entityId }));
  });

  handle(IPC.syncMarkDeleteSynced, async (_e, rawId) => {
    await ctx.syncStore.markTombstoneSynced("project", validateHandle(rawId, "projectId"));
  });

  handle(IPC.syncProgress, async (_e, rawUid) => ctx.syncStore.progress(requireOwner(rawUid)));

  handle(IPC.syncStatus, async (_e, rawId) =>
    ctx.syncStore.statusFor(validateHandle(rawId, "projectId"))
  );

  handle(IPC.syncRetry, async (_e, rawId) => {
    const projectId = validateHandle(rawId, "projectId");
    const n = await ctx.syncStore.retry("project", projectId, Date.now());
    broadcast(IPC.syncChanged, { projectId });
    return n;
  });

  handle(IPC.syncResolveConflict, async (_e, raw) => {
    const { projectId, choices } = (raw ?? {}) as Record<string, unknown>;
    const id = validateHandle(projectId, "projectId");
    const uid = ctx.currentOwnerUid();
    if (!uid) throw new IpcValidationError("sign in to resolve a conflict");
    await ctx.syncStore.resolveConflict({
      projectId: id,
      choices: validateConflictChoices(choices),
      ownerUid: uid,
      deviceId: await ctx.syncStore.deviceId(),
      now: Date.now(),
    });
    broadcast(IPC.syncChanged, { projectId: id });
  });

  // ── The source video's own transfers ──────────────────────────────────────
  // Everything above this point moves kilobytes. Everything below moves the
  // recording itself, which is why it has its own queues, its own progress, and
  // its own way of failing without taking the document sync down with it.
  //
  // The two directions are deliberately asymmetric. An UPLOAD is performed by
  // the renderer, because Storage writes need the authenticated session that
  // lives there; main only queues the work and hands over one job at a time. A
  // DOWNLOAD is performed entirely here, because a Firebase download URL
  // carries its own token and streaming gigabytes to disk in Node beats
  // marshalling them back across this bridge.

  const announce = (snapshot: MediaTransferSnapshot) => {
    broadcast(IPC.mediaTransferChanged, snapshot);
  };

  const fromUpload = (s: MediaUploadSnapshot): MediaTransferSnapshot => ({
    projectId: s.projectId,
    direction: "upload",
    state:
      s.state === "uploading"
        ? "active"
        : s.state === "uploaded"
          ? "done"
          : s.state === "local"
            ? "local"
            : s.state,
    bytesTransferred: s.bytesSent,
    bytesTotal: s.bytesTotal,
    lastError: s.lastError,
  });

  const fromDownload = (s: MediaDownloadSnapshot): MediaTransferSnapshot => ({
    projectId: s.projectId,
    direction: "download",
    state: s.state === "downloading" ? "active" : s.state,
    bytesTransferred: s.bytesReceived,
    bytesTotal: s.bytesTotal,
    lastError: s.lastError,
  });

  const announceUpload = async (projectId: string) => {
    const snapshot = await ctx.mediaUploads.stateForProject(projectId);
    if (snapshot) announce(fromUpload(snapshot));
  };

  const announceDownload = async (projectId: string) => {
    const snapshot = await ctx.mediaDownloads.stateFor(projectId);
    if (snapshot) announce(fromDownload(snapshot));
  };

  /** The upload queue is keyed on media, but the UI thinks in projects. */
  const announceUploadByMedia = async (mediaId: string): Promise<MediaUploadSnapshot | null> => {
    const rows = await ctx.mediaUploads.list(requireSignedIn());
    const mine = rows.find((r) => r.mediaId === mediaId) ?? null;
    if (mine) announce(fromUpload(mine));
    return mine;
  };

  handle(IPC.mediaUploadRequest, async (_e, rawId) => {
    const projectId = validateHandle(rawId, "projectId");
    const uid = requireSignedIn();
    const result = await ctx.mediaUploads.request({
      projectId,
      ownerUid: uid,
      now: Date.now(),
      digest: (path) => ctx.digestFile(path),
    });
    if (result.queued) logger.info("source video queued for upload", { projectId });
    await announceUpload(projectId);
    return result;
  });

  handle(IPC.mediaUploadClaim, async (_e, rawUid) => {
    const uid = requireOwner(rawUid);
    const jobs = await ctx.mediaUploads.claim(uid, Date.now());
    const views: MediaUploadJobView[] = [];
    for (const job of jobs) {
      const media = await ctx.mediaStore.get(job.mediaId);
      if (!media) {
        await ctx.mediaUploads.fail(
          job.mediaId,
          { message: "That video is no longer in the library." },
          Date.now()
        );
        continue;
      }
      views.push({
        mediaId: job.mediaId,
        projectId: job.projectId,
        // A same-origin protocol URL, never a path. The renderer reads the
        // bytes through the same channel the editor plays them through, which
        // is also what keeps the upload out of this process's memory.
        mediaUrl: mediaUrl(job.mediaId),
        storagePath: job.storagePath,
        bytesTotal: job.bytesTotal,
        checksumMd5: job.checksumMd5,
        fileName: media.fileName,
      });
      await announceUpload(job.projectId);
    }
    return views;
  });

  handle(IPC.mediaUploadProgress, async (_e, raw) => {
    const { mediaId, bytesSent } = (raw ?? {}) as Record<string, unknown>;
    const id = validateHandle(mediaId, "mediaId");
    await ctx.mediaUploads.progress(id, validateByteCount(bytesSent, "bytesSent"), Date.now());
    await announceUploadByMedia(id);
  });

  handle(IPC.mediaUploadComplete, async (_e, raw) => {
    const { mediaId, downloadUrl } = (raw ?? {}) as Record<string, unknown>;
    const id = validateHandle(mediaId, "mediaId");
    // The URL is written into the document and thence to every other device,
    // so it is checked rather than trusted — see validateDownloadUrl.
    const url = validateDownloadUrl(downloadUrl);
    await ctx.mediaUploads.complete({ mediaId: id, downloadUrl: url, now: Date.now() });
    const mine = await announceUploadByMedia(id);
    if (mine) {
      logger.info("source video uploaded", { projectId: mine.projectId });
      // The repoint is a document change like any other; the editor's
      // subscription has to hear about it or the project keeps showing the old
      // source until something else forces a reload.
      broadcast(IPC.projectsChanged, {
        projectId: mine.projectId,
        doc: await ctx.library.get(mine.projectId),
      });
    }
  });

  handle(IPC.mediaUploadFail, async (_e, raw) => {
    const { mediaId, error } = (raw ?? {}) as Record<string, unknown>;
    const id = validateHandle(mediaId, "mediaId");
    const detail = (error ?? {}) as { message?: unknown; code?: unknown };
    await ctx.mediaUploads.fail(
      id,
      {
        message:
          typeof detail.message === "string" ? detail.message.slice(0, 500) : "The upload failed.",
        code: typeof detail.code === "string" ? detail.code.slice(0, 100) : undefined,
      },
      Date.now()
    );
    await announceUploadByMedia(id);
  });

  handle(IPC.mediaDownloadRequest, async (_e, rawId) => {
    const projectId = validateHandle(rawId, "projectId");
    const uid = requireSignedIn();
    const result = await ctx.mediaDownloads.request({ projectId, ownerUid: uid, now: Date.now() });
    await announceDownload(projectId);
    if (!result.queued) return result;
    logger.info("cloud video queued for download", { projectId });
    // Fire and forget: the drain reports through `mediaTransferChanged`, and
    // making the caller await a multi-gigabyte transfer would hang the click.
    void ctx.downloadRunner.drain(uid);
    return result;
  });

  handle(IPC.mediaDownloadCancel, async (_e, rawId) => {
    const projectId = validateHandle(rawId, "projectId");
    ctx.downloadRunner.cancel(projectId);
  });

  handle(IPC.mediaTransferRetry, async (_e, rawId) => {
    const projectId = validateHandle(rawId, "projectId");
    const uid = requireSignedIn();
    const now = Date.now();
    // Re-arm whichever direction was parked. Both is fine — retrying something
    // that never failed is a no-op, and the alternative is asking the UI to
    // know which queue a project is in.
    const upload = await ctx.mediaUploads.stateForProject(projectId);
    if (upload) await ctx.mediaUploads.retry(upload.mediaId, now);
    await ctx.mediaDownloads.retry(projectId, now);
    await announceUpload(projectId);
    await announceDownload(projectId);
    void ctx.downloadRunner.drain(uid);
  });

  handle(IPC.mediaTransferList, async (): Promise<MediaTransferSnapshot[]> => {
    const uid = requireSignedIn();
    const [uploads, downloads] = await Promise.all([
      ctx.mediaUploads.list(uid),
      ctx.mediaDownloads.list(uid),
    ]);
    return [...uploads.map(fromUpload), ...downloads.map(fromDownload)];
  });

  handle(IPC.shellOpenExternal, async (_e, rawUrl) => {
    const url = validateExternalUrl(rawUrl);
    await shell.openExternal(url);
  });
}

/** Clear the "open" flags on a clean quit — synchronous, see Library. */
export function markProjectsClosed(library: Library): void {
  try {
    library.closeAllSessionsSync();
  } catch (err) {
    logger.warn("could not clear session flags", { error: (err as Error).message });
  }
}

export { dirname };
