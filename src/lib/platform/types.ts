/**
 * The platform ports — the ONE contract that lets the same Framevo editor run
 * against the cloud (browser) and against local files (desktop).
 *
 * Rules of the road:
 *   • These interfaces are pure TypeScript: no Electron, no Firebase, no DOM
 *     beyond what the web already uses. They are imported by the renderer AND
 *     (via the `@/` alias) by the Electron main/preload bundles, so the IPC
 *     contract and the UI can never drift apart.
 *   • UI code never asks "am I in Electron?" — it asks the platform for a
 *     capability (`platform.media.canPickLocalFiles`, `platform.export`) and
 *     branches on that. `window.framevo` is touched in exactly one file
 *     (./desktop/bridge.ts).
 *   • A capability the current platform genuinely lacks is `null` / `false`,
 *     never a fake implementation that silently no-ops.
 */
import type { ProjectDoc } from "@/lib/firebase/schema";
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";
import type { DocPatch } from "./field-value";

/** Which shell the app is running in. */
export type PlatformKind = "web" | "desktop";

// ── Project storage ─────────────────────────────────────────────────────────

/** A row in the project library (cheap to list; not the full document). */
export interface ProjectSummary {
  id: string;
  title: string;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  durationSec?: number;
  width?: number;
  height?: number;
  /**
   * Playable URL for the card preview. Local projects carry their media
   * protocol URL, which is same-origin — so the existing `<video>` in
   * `RealProjectCard` renders a real frame rather than "No preview".
   */
  previewUrl?: string;
  /** Local only: the media reference is missing/moved on disk. */
  mediaMissing?: boolean;
  /**
   * Local only: the project is here but its VIDEO is only in the cloud.
   *
   * The normal state of a project synced from another machine — the timeline
   * arrived in a second, the recording did not. It plays over the network and
   * becomes fully offline once downloaded.
   */
  cloudOnly?: boolean;
  /** Local only: this project has unsaved recovery data from a crash. */
  hasRecovery?: boolean;
  /**
   * Local only: the Firestore project id this row was synced from / to.
   *
   * This is the DEDUP KEY. A project that exists in both places must appear
   * ONCE in the library, and the local row is the copy that can be opened
   * offline — so the merge keys on `cloudProjectId ?? id` and keeps the local
   * one. Null for a project that has never touched the cloud.
   */
  cloudProjectId?: string;
}

/**
 * The library's numbers WITHOUT its documents.
 *
 * The dashboard shows counts, not projects — and a count is the one question a
 * library can answer without materialising anything. Listing 30 projects to
 * display "30" costs a row, a media join and a preview URL per project (and, on
 * the cards that used to follow, a `<video>` decode per project); this is one
 * aggregate query. Anything that needs a project must call `list()`.
 */
export interface ProjectLibraryStats {
  /** Projects in this library. */
  projectCount: number;
  /**
   * How many of them are linked to a cloud twin.
   *
   * The OVERLAP, so a merged total can be computed without merging: a project
   * the user has in both places must be counted once (see merge-projects.ts).
   */
  linkedCount: number;
  /** Bytes of source media referenced by this library, on this disk. */
  mediaBytes: number;
}

export interface ProjectWriteOptions {
  /**
   * Route the write through the per-project serialized queue instead of issuing
   * it directly. Queued writes never reject — a failure is retried, then logged
   * and swallowed so a persistence race can't crash the editor. Direct writes
   * (the default) reject, so the caller can surface an error to the user.
   * This mirrors exactly which call sites used the queue before the port
   * existed; see lib/firebase/project-writer.ts.
   */
  queue?: boolean;
  /**
   * Latest-wins tag (implies `queue`). While a write with this tag is still
   * queued, a newer one supersedes it. ONLY safe for writes that persist a full
   * snapshot, never for partial merges whose fields differ.
   */
  coalesceTag?: string;
  /** Diagnostic label for the write queue log. */
  label?: string;
}

/**
 * Where the editor's document lives. `subscribe` is the read path (realtime on
 * both backends), `write` is the ONLY write path — every editor mutation is a
 * merge patch built from ./field-value sentinels.
 */
export interface ProjectStorage {
  readonly kind: "cloud" | "local";
  /** Human label for diagnostics ("Firestore", "Local library"). */
  readonly label: string;
  /** Realtime document subscription. Returns an unsubscribe function. */
  subscribe(projectId: string, onChange: (doc: ProjectDoc | null) => void): () => void;
  /** One-shot read (used by the analysis repair path). */
  get(projectId: string): Promise<ProjectDoc | null>;
  /** Merge-write a patch. Resolves once the write is durable. */
  write(projectId: string, patch: DocPatch, options?: ProjectWriteOptions): Promise<void>;
  /** List the library. Local-only backends implement this; cloud lists elsewhere. */
  list?(): Promise<ProjectSummary[]>;
  /**
   * Counts only — what the dashboard needs. Local-only: the cloud's counts come
   * from a Firestore aggregate query, which is likewise document-free.
   */
  stats?(): Promise<ProjectLibraryStats>;
  /**
   * Create a project around already-imported media. Local-only: the web creates
   * projects through the upload flow (lib/firebase/projects.ts), which needs a
   * File and a Storage upload rather than a durable local reference.
   */
  create?(mediaId: string, title: string): Promise<ProjectDoc>;
  /** Delete a project (never deletes the user's source video file). */
  delete?(projectId: string): Promise<void>;
  /**
   * Fires whenever ANY project in this backend changed — the signal a library
   * listing needs. Distinct from `subscribe`, which is scoped to one document.
   * Local-only: Firestore listings use their own collection listener.
   */
  onLibraryChanged?(handler: () => void): () => void;
  /**
   * Resolve a crash-recovery prompt: adopt the newest autosave ("keep") or drop
   * it ("discard"). Local-only — the cloud document is never in this state.
   */
  resolveRecovery?(projectId: string, action: "keep" | "discard"): Promise<ProjectDoc | null>;
  /**
   * What the PREVIOUS session left unfinished, snapshotted at launch.
   *
   * Distinct from filtering `list()` on `hasRecovery`: that flag is also true
   * for a project open right now, so re-deriving it on every page load would
   * make a simple refresh claim the app had crashed.
   */
  pendingRecovery?(): Promise<ProjectSummary[]>;
  /**
   * Record that this local project now also lives in Firestore, so the merged
   * library lists it once. Local-only.
   */
  linkCloud?(projectId: string, cloudProjectId: string): Promise<void>;
}

// ── Media ───────────────────────────────────────────────────────────────────

/** A local video the user picked. The renderer only ever sees `url` + `mediaId`. */
export interface ImportedMedia {
  /** Opaque handle. The absolute path stays in the main process. */
  mediaId: string;
  /** A protocol URL the <video> element and mediabunny can both read. */
  url: string;
  /** File name only — never the full path (see docs/desktop/security.md). */
  fileName: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  /** Container/codec summary from ffprobe, e.g. "h264 · aac". */
  codecSummary?: string;
}

export interface MediaService {
  /**
   * False in the browser: a web page cannot hold a durable reference to a file
   * on disk (a File handle dies with the tab), which is exactly why the local
   * project library is a desktop capability.
   */
  readonly canPickLocalFiles: boolean;
  /** Open the OS picker. Resolves null when the user cancels. */
  pickVideo(): Promise<ImportedMedia | null>;
  /**
   * Import a file dropped on the window, keeping it where it is — the drag
   * equivalent of `pickVideo`.
   *
   * Absent in the browser, where a drop yields bytes to upload rather than a
   * file to reference. UI that offers a drop target must branch on this being
   * present, not on the platform: a dashed border that swallows a drop is a
   * promise the app didn't keep.
   */
  importDroppedFile?(file: File): Promise<ImportedMedia>;
  /** Re-validate a stored reference (file moved/deleted since last open). */
  resolve(mediaId: string): Promise<ImportedMedia | null>;
  /** Ask the OS to reveal a produced file (export output) in its folder. */
  revealOutput(outputId: string): Promise<void>;
  /**
   * Persist a just-finished screen recording to the library folder and import
   * it, so Record produces a real local project instead of an upload. Null in
   * the browser, where a recording has nowhere durable to go and is uploaded to
   * Firebase Storage exactly as before.
   */
  saveRecording?(
    bytes: ArrayBuffer,
    fileName: string
  ): Promise<ImportedMedia>;
}

// ── Export ──────────────────────────────────────────────────────────────────

export type LocalExportStage = "preparing" | "rendering" | "encoding" | "finalizing";

export interface LocalExportProgress {
  stage: LocalExportStage;
  /** 0..1 within the whole job. */
  progress: number;
  /** Milliseconds remaining, when the render loop has enough samples. */
  etaMs?: number;
  currentFrame?: number;
  totalFrames?: number;
}

export interface LocalExportRequest {
  jobId: string;
  projectId: string;
  projectTitle: string;
  /** Opaque media handle — the main process maps it to the validated path. */
  mediaId: string;
  /** The SAME snapshot the cloud job stores, so both render identically. */
  recipe: SerializedRenderRecipe;
  /** Absolute output path chosen by the user via the OS save dialog. */
  outputId: string;
  /** "auto" picks the best available hardware encoder. */
  encoder?: EncoderId | "auto";
}

export interface LocalExportResult {
  outputId: string;
  /** File name only, for display. */
  fileName: string;
  sizeBytes: number;
  durationSec: number;
  /** Which encoder actually produced the file. */
  encoder: EncoderId;
  /** Non-fatal notices (e.g. audio dropped). */
  warnings: string[];
}

/** Hardware encoder identifiers, mirrored in the main process detector. */
export type EncoderId =
  | "h264_nvenc"
  | "h264_qsv"
  | "h264_amf"
  | "h264_videotoolbox"
  | "libx264";

export interface EncoderInfo {
  id: EncoderId;
  /** Display name, e.g. "NVIDIA NVENC". */
  label: string;
  /** Present in the bundled FFmpeg build AND usable on this machine. */
  available: boolean;
  /** Why it isn't available (probe failure reason), for diagnostics. */
  detail?: string;
  hardware: boolean;
}

export interface ExportService {
  /** Ask the user where to save. Resolves null when cancelled. */
  chooseOutput(suggestedName: string): Promise<{ outputId: string; fileName: string } | null>;
  /** Encoders this machine can actually use, best first. */
  listEncoders(): Promise<EncoderInfo[]>;
  start(request: LocalExportRequest): Promise<void>;
  cancel(jobId: string): Promise<void>;
  onProgress(handler: (jobId: string, progress: LocalExportProgress) => void): () => void;
  onDone(handler: (jobId: string, result: LocalExportResult) => void): () => void;
  onFailed(handler: (jobId: string, error: { message: string; code?: string }) => void): () => void;
  onCanceled(handler: (jobId: string) => void): () => void;
}

// ── Local export library ────────────────────────────────────────────────────

export type LocalExportStatus =
  | "pending"
  | "rendering"
  | "ready"
  | "failed"
  | "canceled";

/**
 * A file this machine produced. It is deliberately NOT an `ExportDoc`: a local
 * export has no cloud job, no download URL and no billing — it has a path (held
 * by the main process), a size and a state on disk.
 */
export interface LocalExportRecord {
  outputId: string;
  projectId: string;
  fileName: string;
  sizeBytes: number;
  encoder: string;
  status: LocalExportStatus;
  createdAt: number;
  /** False once the user has moved or deleted the file behind our back. */
  fileExists: boolean;
  /** Containing FOLDER name only — never the full path (see security.md). */
  folderName: string;
}

export interface LocalExportsService {
  list(): Promise<LocalExportRecord[]>;
  /** Hand the finished file to the OS default player. */
  play(outputId: string): Promise<void>;
  reveal(outputId: string): Promise<void>;
  /**
   * Forget the record. `deleteFile` also removes the produced file from disk —
   * never the user's source video, which the app does not own.
   */
  remove(outputId: string, deleteFile: boolean): Promise<void>;
}

// ── Local disk usage ────────────────────────────────────────────────────────

export interface LocalStorageUsage {
  /** Bytes of source video REFERENCED by the library (files we do not own). */
  mediaBytes: number;
  mediaCount: number;
  /** Source files that have gone missing since import. */
  missingMediaCount: number;
  /** Bytes of finished exports still on disk. */
  exportBytes: number;
  exportCount: number;
  /** Export records whose file is gone — safe to purge. */
  staleExportCount: number;
  /** Recordings Framevo itself wrote into the library folder. */
  recordingBytes: number;
  recordingCount: number;
  /** The SQLite library (documents + autosave history). */
  databaseBytes: number;
  /** Free space on the volume holding the library, when the OS reports it. */
  freeDiskBytes?: number;
  /** Display name of the library folder — not its path. */
  libraryFolderName: string;
}

export interface LocalStorageService {
  usage(): Promise<LocalStorageUsage>;
  /** Reveal the library folder in the OS file manager. */
  openLibraryFolder(): Promise<void>;
  /** Drop media rows whose file no longer exists. Returns how many went. */
  purgeMissingMedia(): Promise<{ removed: number }>;
  /** Drop export records whose file no longer exists. */
  purgeStaleExports(): Promise<{ removed: number }>;
  /** Trim autosave history to the newest snapshot per project. */
  compactAutosaves(): Promise<{ removedSnapshots: number; freedBytes: number }>;
}

// ── Native authentication ───────────────────────────────────────────────────

/**
 * Desktop sign-in.
 *
 * Electron must NEVER render Google's login page itself — Google refuses
 * embedded user agents, and an in-app login form is exactly the phishing shape
 * OAuth exists to avoid. `signInWithGoogle` therefore runs the whole flow in the
 * user's real browser (PKCE + loopback redirect) and hands back a Google OIDC
 * ID token, which the renderer turns into a Firebase session with
 * `signInWithCredential` — the SAME Firebase account the website signs into.
 *
 * No client secret and no Firebase Admin credential exists anywhere in the
 * desktop bundle: the authorization-code exchange happens on Framevo's server.
 */
export interface DesktopAuthService {
  /** Resolves the Google ID token, or rejects with a user-facing message. */
  signInWithGoogle(): Promise<{ idToken: string }>;
  /** Abandon a flow in progress (the user closed the sign-in screen). */
  cancel(): Promise<void>;
}

// ── Sync ────────────────────────────────────────────────────────────────────

/**
 * The renderer's half of local-first sync.
 *
 * The durable queue lives in SQLite (main process); the network calls run here,
 * because this is where the authenticated Firebase session is. Everything on
 * this port is about telling main WHO is signed in and draining what main has
 * queued — never about deciding what to sync, which the queue already knows.
 */
export interface SyncBridge {
  /**
   * Report the signed-in account. Called on every auth state change, `null` on
   * sign-out. Until this lands nothing is queued, so a write during startup can
   * never be stamped with the wrong account — and signing out does not discard
   * the previous account's pending work, it just stops draining it.
   */
  setOwner(uid: string | null): Promise<void>;
  /**
   * The durable queue, as the engine's `LocalSyncPort`.
   *
   * Typed as `unknown` here to keep this file free of sync internals; the
   * desktop bridge casts it to `LocalSyncPort` at the one place it is consumed
   * (src/lib/sync/engine.ts). The alternative — importing the sync types into
   * the platform contract — would make every shell depend on a subsystem only
   * one of them has.
   */
  readonly queue: unknown;
  /** Per-project sync state, for the badge. */
  status(projectId: string): Promise<SyncStatusSnapshot | null>;
  /** Re-arm every parked operation for a project. Returns how many. */
  retry(projectId: string): Promise<number>;
  /** Apply a human's conflict decisions and queue the reconciled document. */
  resolveConflict(
    projectId: string,
    choices: Record<string, "local" | "remote">
  ): Promise<void>;
  /** Main → renderer: this project's sync state changed. */
  onChanged(handler: (event: { projectId: string }) => void): () => void;
  /** Moving the SOURCE VIDEO, in both directions. See `MediaTransferBridge`. */
  readonly media: MediaTransferBridge;
}

/**
 * The source video's own two journeys.
 *
 * Kept apart from the document queue above because the two have nothing in
 * common but a destination. A document is kilobytes, syncs unasked, and is
 * finished before the user notices. A recording is gigabytes, moves only when
 * somebody asks for it, and needs progress, resumption and a way to give up.
 * One queue for both would mean a 4 GB upload sitting in front of a title
 * change.
 */
export interface MediaTransferBridge {
  /** Send this project's video to the cloud. Idempotent. */
  requestUpload(projectId: string): Promise<{ queued: boolean; reason?: string }>;
  /** Fetch this project's cloud video onto this computer. Idempotent. */
  requestDownload(projectId: string): Promise<{ queued: boolean; reason?: string }>;
  /** Stop an in-flight download. Progress is kept; asking again resumes it. */
  cancelDownload(projectId: string): Promise<void>;
  /** Re-arm a parked transfer of either kind. */
  retry(projectId: string): Promise<void>;
  /** Every transfer this account has a record of. */
  list(): Promise<MediaTransferSnapshot[]>;
  /** Main → renderer: a transfer moved. Fires often while bytes are flowing. */
  onChanged(handler: (event: MediaTransferSnapshot) => void): () => void;
  // ── The upload worker's half ─────────────────────────────────────────────
  // Main owns the queue and the file; the renderer owns the authenticated
  // Firebase session. These four are how the worker in the renderer drains
  // what main has queued — see src/lib/sync/media-upload-worker.ts.
  claimUpload(ownerUid: string): Promise<MediaUploadJobView[]>;
  uploadProgress(mediaId: string, bytesSent: number): Promise<void>;
  completeUpload(args: { mediaId: string; downloadUrl: string }): Promise<void>;
  failUpload(mediaId: string, error: { message: string; code?: string }): Promise<void>;
}

/** One project's transfer state, whichever direction it is going. */
export interface MediaTransferSnapshot {
  projectId: string;
  direction: "upload" | "download";
  /**
   * `local` is a RESTING state, not a problem: the video is on this disk and
   * nobody has asked for it to be anywhere else. A project with no transfer at
   * all simply has no snapshot — absence is the common case, not an error.
   */
  state: "local" | "pending" | "active" | "done" | "failed";
  bytesTransferred: number;
  bytesTotal: number;
  lastError?: string;
}

/** An upload the renderer has been handed to perform. */
export interface MediaUploadJobView {
  mediaId: string;
  projectId: string;
  /** Same-origin URL the renderer reads the bytes from (never a path). */
  mediaUrl: string;
  /** Where the object must land in Storage. */
  storagePath: string;
  bytesTotal: number;
  /** BASE64 MD5 of the local file — verified against the uploaded object. */
  checksumMd5: string | null;
  fileName: string;
}

/** What the UI needs to render a project's sync state. Mirrors lib/sync/types. */
export interface SyncStatusSnapshot {
  entityId: string;
  state: "synced" | "pending" | "syncing" | "conflict" | "failed";
  pendingOps: number;
  lastSyncedAt?: number;
  lastError?: string;
  conflicts?: {
    path: string;
    base: unknown;
    local: unknown;
    remote: unknown;
    momentId?: string;
  }[];
}

// ── App shell ───────────────────────────────────────────────────────────────

export interface AppInfo {
  version: string;
  platform: "win32" | "darwin" | "linux";
  /** Cloud API origin for the routes that must stay server-side. */
  apiBaseUrl: string;
  updateFeedConfigured: boolean;
  /** True when a Google desktop OAuth client id was baked into this build. */
  googleSignInConfigured: boolean;
  /**
   * Set when the main bundle and the renderer it serves were built for
   * different projects, which makes sign-in impossible (Firebase rejects a
   * Google token minted for another project's OAuth client). The text names
   * both halves and what to rebuild; null when they agree.
   */
  buildMismatch?: string | null;
}

export interface PlatformBridge {
  readonly kind: PlatformKind;
  /**
   * Storage for the project the editor is currently on.
   *
   * On the web this is always Firestore. On the desktop it is the LOCAL
   * library — but the desktop also reads cloud projects (see `cloudProjects`),
   * so "which storage owns this document" is decided per project by
   * `storageFor()`, not by the platform alone.
   */
  readonly projects: ProjectStorage;
  /**
   * The signed-in user's Firestore storage, when there is one. On the web this
   * IS `projects`. On the desktop it is a second backend that exists only while
   * signed in, so a cloud project opens in the same editor as a local one.
   */
  readonly cloudProjects: ProjectStorage | null;
  /** Pick the backend that owns a document (local sentinel uid vs. Firebase uid). */
  storageFor(doc: { userId?: string } | null | undefined): ProjectStorage;
  readonly media: MediaService;
  /** null in the browser — the browser exports via the existing engines. */
  readonly export: ExportService | null;
  /** The files this machine produced. null on web (nothing is stored locally). */
  readonly localExports: LocalExportsService | null;
  /** Local disk accounting. null on web. */
  readonly storage: LocalStorageService | null;
  /** Native sign-in. null on web, which signs in with a popup as before. */
  readonly auth: DesktopAuthService | null;
  /** Desktop app metadata; null on web. */
  readonly app: AppInfo | null;
  /**
   * Local-first sync. null on web, where Firestore IS the store and there is
   * nothing to reconcile.
   */
  readonly sync: SyncBridge | null;
  /**
   * Where "back to my projects" goes. Both shells now have a real route for it;
   * kept as a capability so a future shell can differ without touching callers.
   */
  readonly libraryHref: string;
  /**
   * Origin of the Framevo WEBSITE, for the handful of pages that exist only
   * there (admin, marketing, docs). Null on the web itself, where those are
   * ordinary in-app routes. Desktop uses it to open them in the real browser
   * rather than linking into a route the static bundle does not contain.
   */
  readonly webAppOrigin: string | null;
  /** Open an external link in the user's real browser (desktop) or a tab (web). */
  openExternal(url: string): void;
}
