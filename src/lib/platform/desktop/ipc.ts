/**
 * The desktop IPC contract — channels, payload types, and the VALIDATORS the
 * main process runs on every inbound message.
 *
 * This module is imported by all three processes (renderer via `@/lib/platform`,
 * preload, and main via the `@/` alias in desktop/tsconfig.json), which is what
 * keeps them in lockstep: a channel can't be renamed on one side only, and the
 * renderer can't send a shape main doesn't expect.
 *
 * Security posture (see docs/desktop/security.md):
 *   • The renderer is sandboxed with contextIsolation ON and nodeIntegration
 *     OFF, so this is the ONLY surface it can reach.
 *   • Every handler validates its input HERE before touching the filesystem or
 *     the database. Validation is pure and unit-tested (test/ipc-security).
 *   • The renderer never sends or receives absolute paths. It holds opaque
 *     handles (`mediaId`, `outputId`); the main process owns the path table.
 *   • There is deliberately NO generic "invoke(channel, args)", no shell
 *     execution, no path-taking API, and no filesystem read/write channel.
 */
import type {
  AppInfo,
  EncoderId,
  EncoderInfo,
  ImportedMedia,
  LocalExportProgress,
  LocalExportRecord,
  LocalExportResult,
  LocalStorageUsage,
  MediaTransferSnapshot,
  MediaUploadJobView,
  ProjectLibraryStats,
  ProjectSummary,
} from "../types";
import type { DocPatch } from "../field-value";
import { MEDIA_URL_PREFIX } from "../local";
import type { SerializedRenderRecipe } from "@/lib/firebase/schema";

/** Bumped when the contract changes shape; the renderer refuses a mismatch. */
export const DESKTOP_API_VERSION = 2;

/**
 * Electron rejects a failed `invoke` with
 * `Error invoking remote method '<channel>': Error: <our message>` — a sentence
 * about our own plumbing, glued in front of the sentence written for the user.
 * It reaches the screen verbatim wherever a component renders `err.message`.
 *
 * Strip both the channel wrapper and the error CLASS name that Electron carries
 * over from the remote stack, leaving the message the main process meant to
 * send. Pure and exported so it can be tested without Electron.
 */
const REMOTE_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/;
// Matches a bare `Error:` as well as `SignInError:` / `IpcValidationError:`.
const ERROR_CLASS_PREFIX = /^[\w$]*(?:Error|Exception):\s*/;

export function ipcErrorMessage(value: unknown): string {
  const raw =
    value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const text = raw.replace(REMOTE_INVOKE_PREFIX, "").replace(ERROR_CLASS_PREFIX, "").trim();
  return text || "Framevo couldn't complete that action.";
}

/** The single global the preload script installs. */
export const DESKTOP_API_KEY = "framevo";

export const IPC = {
  appInfo: "framevo:app:info",
  projectsList: "framevo:projects:list",
  projectsStats: "framevo:projects:stats",
  projectsGet: "framevo:projects:get",
  projectsCreate: "framevo:projects:create",
  projectsWrite: "framevo:projects:write",
  projectsDelete: "framevo:projects:delete",
  projectsRecover: "framevo:projects:recover",
  projectsPendingRecovery: "framevo:projects:pending-recovery",
  projectsLinkCloud: "framevo:projects:link-cloud",
  projectsChanged: "framevo:projects:changed", // main → renderer
  mediaPick: "framevo:media:pick",
  mediaImportFile: "framevo:media:import-file",
  mediaResolve: "framevo:media:resolve",
  mediaReveal: "framevo:media:reveal",
  mediaSaveRecording: "framevo:media:save-recording",
  authGoogleStart: "framevo:auth:google-start",
  authGoogleCancel: "framevo:auth:google-cancel",
  exportsList: "framevo:exports:list",
  exportsPlay: "framevo:exports:play",
  exportsRemove: "framevo:exports:remove",
  storageUsage: "framevo:storage:usage",
  storageOpenFolder: "framevo:storage:open-folder",
  storagePurgeMedia: "framevo:storage:purge-media",
  storagePurgeExports: "framevo:storage:purge-exports",
  storageCompact: "framevo:storage:compact",
  exportChooseOutput: "framevo:export:choose-output",
  exportEncoders: "framevo:export:encoders",
  exportStart: "framevo:export:start",
  exportCancel: "framevo:export:cancel",
  exportProgress: "framevo:export:progress", // main → renderer
  exportDone: "framevo:export:done", // main → renderer
  exportFailed: "framevo:export:failed", // main → renderer
  exportCanceled: "framevo:export:canceled", // main → renderer
  shellOpenExternal: "framevo:shell:open-external",
  /**
   * Tell the main process which account is signed in.
   *
   * Sync's durable queue lives in SQLite (main) but the authenticated session
   * lives in the renderer, so main cannot discover the uid on its own. Every
   * queued operation is stamped with — and later claimed by — this value, which
   * is what keeps one account's pending work from ever being pushed under
   * another's credentials. `null` means signed out: nothing is queued and
   * nothing is drained, but nothing already queued is discarded either.
   */
  syncSetOwner: "framevo:sync:set-owner",
  syncClaim: "framevo:sync:claim",
  syncAck: "framevo:sync:ack",
  syncFail: "framevo:sync:fail",
  syncSupersede: "framevo:sync:supersede",
  syncApplyRemote: "framevo:sync:apply-remote",
  syncPendingDeletes: "framevo:sync:pending-deletes",
  syncMarkDeleteSynced: "framevo:sync:mark-delete-synced",
  syncProgress: "framevo:sync:progress",
  syncStatus: "framevo:sync:status",
  syncRetry: "framevo:sync:retry",
  syncResolveConflict: "framevo:sync:resolve-conflict",
  syncChanged: "framevo:sync:changed", // main → renderer
  /**
   * Moving the SOURCE VIDEO — the half of sync that is measured in gigabytes.
   *
   * Uploads are performed by the renderer (it holds the Firebase session) and
   * queued by main; downloads are performed entirely by main, because a
   * download URL carries its own token and streaming to disk beats sending
   * gigabytes back across this bridge. Hence the asymmetry in these channels.
   */
  mediaUploadRequest: "framevo:media:upload-request",
  mediaUploadClaim: "framevo:media:upload-claim",
  mediaUploadProgress: "framevo:media:upload-progress",
  mediaUploadComplete: "framevo:media:upload-complete",
  mediaUploadFail: "framevo:media:upload-fail",
  mediaDownloadRequest: "framevo:media:download-request",
  mediaDownloadCancel: "framevo:media:download-cancel",
  mediaTransferRetry: "framevo:media:transfer-retry",
  mediaTransferList: "framevo:media:transfer-list",
  mediaTransferChanged: "framevo:media:transfer-changed", // main → renderer
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ── Payloads ────────────────────────────────────────────────────────────────

export interface CreateProjectRequest {
  mediaId: string;
  title: string;
}

export interface WriteProjectRequest {
  projectId: string;
  patch: DocPatch;
}

export interface StartExportRequest {
  jobId: string;
  projectId: string;
  projectTitle: string;
  mediaId: string;
  outputId: string;
  recipe: SerializedRenderRecipe;
  encoder?: EncoderId | "auto";
}

export interface SaveRecordingRequest {
  /** The finished take. Structured-cloned across the bridge, never a path. */
  bytes: ArrayBuffer;
  /** Suggested file name; sanitised and re-extensioned by the main process. */
  fileName: string;
}

export interface ProjectChangedEvent {
  projectId: string;
  /** The full document after the write (materialized by the renderer). */
  doc: Record<string, unknown> | null;
}

export type ExportProgressEvent = { jobId: string } & LocalExportProgress;
export type ExportDoneEvent = { jobId: string; result: LocalExportResult };
export type ExportFailedEvent = { jobId: string; message: string; code?: string };
export type ExportCanceledEvent = { jobId: string };

/**
 * The typed surface `preload.ts` exposes on `window.framevo`. Renderer code
 * NEVER references this directly — it goes through the platform bridge.
 */
export interface DesktopApi {
  readonly version: number;
  app: { info(): Promise<AppInfo> };
  projects: {
    list(): Promise<ProjectSummary[]>;
    /**
     * Counts only, for the dashboard. Deliberately NOT `list().length`: that
     * ships every row, its media join and a preview URL across the bridge to
     * render a number.
     */
    stats(): Promise<ProjectLibraryStats>;
    get(projectId: string): Promise<Record<string, unknown> | null>;
    create(request: CreateProjectRequest): Promise<Record<string, unknown>>;
    write(request: WriteProjectRequest): Promise<void>;
    delete(projectId: string): Promise<void>;
    /** Accept ("keep") or discard the crash-recovery snapshot for a project. */
    recover(projectId: string, action: "keep" | "discard"): Promise<Record<string, unknown> | null>;
    /**
     * Projects that were mid-edit when the PREVIOUS session died, captured once
     * at launch. Deliberately not re-derived from the live "open" flags: a
     * project the user has open right now is flagged open, so a page reload
     * would otherwise accuse a perfectly healthy session of having crashed.
     */
    pendingRecovery(): Promise<ProjectSummary[]>;
    /**
     * Record that this local project now also exists in Firestore.
     *
     * The id is what makes the merged library show ONE entry for a project the
     * user has in both places (see src/lib/projects/merge-projects.ts).
     */
    linkCloud(projectId: string, cloudProjectId: string): Promise<void>;
    onChanged(handler: (event: ProjectChangedEvent) => void): () => void;
  };
  media: {
    pick(): Promise<ImportedMedia | null>;
    /**
     * Import a file the user DROPPED on the window.
     *
     * It takes the `File`, not a path, on purpose. The preload turns it into a
     * path with `webUtils.getPathForFile` and passes only that to main, so the
     * renderer never names a file on disk — it can only hand over something the
     * OS already gave the page. A synthetic `File` yields an empty path and is
     * rejected by the same validator the OS picker's result goes through.
     */
    importFile(file: File): Promise<ImportedMedia>;
    resolve(mediaId: string): Promise<ImportedMedia | null>;
    reveal(outputId: string): Promise<void>;
    saveRecording(request: SaveRecordingRequest): Promise<ImportedMedia>;
  };
  auth: {
    /** Runs the system-browser Google flow. Rejects with a user-facing message. */
    googleSignIn(): Promise<{ idToken: string }>;
    cancel(): Promise<void>;
  };
  localExports: {
    list(): Promise<LocalExportRecord[]>;
    play(outputId: string): Promise<void>;
    remove(outputId: string, deleteFile: boolean): Promise<void>;
  };
  storage: {
    usage(): Promise<LocalStorageUsage>;
    openFolder(): Promise<void>;
    purgeMissingMedia(): Promise<{ removed: number }>;
    purgeStaleExports(): Promise<{ removed: number }>;
    compactAutosaves(): Promise<{ removedSnapshots: number; freedBytes: number }>;
  };
  export: {
    chooseOutput(
      suggestedName: string
    ): Promise<{ outputId: string; fileName: string } | null>;
    encoders(): Promise<EncoderInfo[]>;
    start(request: StartExportRequest): Promise<void>;
    cancel(jobId: string): Promise<void>;
    onProgress(handler: (event: ExportProgressEvent) => void): () => void;
    onDone(handler: (event: ExportDoneEvent) => void): () => void;
    onFailed(handler: (event: ExportFailedEvent) => void): () => void;
    onCanceled(handler: (event: ExportCanceledEvent) => void): () => void;
  };
  shell: { openExternal(url: string): Promise<void> };
  /**
   * The durable sync queue, reached from the renderer.
   *
   * Every method is main-process state; the renderer supplies only the network.
   * See src/lib/sync/engine.ts for how they compose.
   */
  sync: {
    setOwner(uid: string | null): Promise<void>;
    claim(ownerUid: string, now: number, limit?: number, entities?: string[]): Promise<unknown[]>;
    ack(opId: string, now: number): Promise<void>;
    fail(opId: string, error: { message: string; code?: string }, now: number): Promise<void>;
    supersede(args: unknown): Promise<void>;
    applyRemote(remote: unknown, ownerUid: string, now: number): Promise<unknown>;
    pendingDeletes(ownerUid: string): Promise<{ entityId: string }[]>;
    markDeleteSynced(entityId: string): Promise<void>;
    progress(ownerUid: string): Promise<unknown>;
    status(projectId: string): Promise<unknown>;
    /** Re-arm every parked operation for a record (the user pressed Retry). */
    retry(projectId: string): Promise<number>;
    resolveConflict(projectId: string, choices: Record<string, "local" | "remote">): Promise<void>;
    /** Main → renderer: this record's sync state changed. */
    onChanged(handler: (event: { projectId: string }) => void): () => void;
    /** The source video's own transfers. See `MediaTransferBridge`. */
    media: {
      requestUpload(projectId: string): Promise<{ queued: boolean; reason?: string }>;
      requestDownload(projectId: string): Promise<{ queued: boolean; reason?: string }>;
      cancelDownload(projectId: string): Promise<void>;
      retry(projectId: string): Promise<void>;
      list(): Promise<MediaTransferSnapshot[]>;
      claimUpload(ownerUid: string): Promise<MediaUploadJobView[]>;
      uploadProgress(mediaId: string, bytesSent: number): Promise<void>;
      completeUpload(request: CompleteUploadRequest): Promise<void>;
      failUpload(mediaId: string, error: { message: string; code?: string }): Promise<void>;
      onChanged(handler: (event: MediaTransferSnapshot) => void): () => void;
    };
  };
}

export interface CompleteUploadRequest {
  mediaId: string;
  /** The `getDownloadURL()` result — what the document will point at. */
  downloadUrl: string;
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Thrown by the validators; the main process maps it to a rejected invoke. */
export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcValidationError";
  }
}

function fail(message: string): never {
  throw new IpcValidationError(message);
}

/** Opaque handles: our own ids, so a strict charset is safe and cheap. */
const HANDLE_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function validateHandle(value: unknown, label: string): string {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) {
    fail(`${label} must match ${HANDLE_RE}`);
  }
  return value;
}

/** Video containers the app accepts — mirrors `isVideoAccepted` on the web. */
export const ACCEPTED_VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".m4v",
] as const;

export function hasAcceptedVideoExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * The origin + path prefix the media protocol serves local files from.
 *
 * Re-exported from the SHARED definition rather than restated: UI code asks the
 * same question through `isCloudOnlyVideo`, and two copies of this string is
 * exactly the kind of drift that turns into "the desktop shows no preview".
 */
export { MEDIA_URL_PREFIX };

/**
 * Recover the media handle from a local project's `originalVideoUrl`.
 *
 * A local project stores `framevo://app/__media/<mediaId>` there, which is what
 * lets the SAME editor/preview/export code path treat a file on disk exactly
 * like a cloud download URL. Returns null for a cloud (https) project — the
 * caller then knows it cannot be rendered locally.
 */
export function localMediaId(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.startsWith(MEDIA_URL_PREFIX)) return null;
  const id = url.slice(MEDIA_URL_PREFIX.length).split(/[/?#]/)[0] ?? "";
  return HANDLE_RE.test(id) ? id : null;
}

/** Titles are stored and displayed — bound the length and strip control chars. */
export function validateTitle(value: unknown): string {
  if (typeof value !== "string") fail("title must be a string");
  const cleaned = Array.from(value)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  if (!cleaned) fail("title must not be empty");
  if (cleaned.length > 200) fail("title must be ≤ 200 characters");
  return cleaned;
}

/** Keys that would let a patch walk up the prototype chain. */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PATCH_DEPTH = 16;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

/**
 * A merge patch must be a plain JSON tree. This rejects prototype-pollution
 * keys, functions/symbols (which structured-clone would refuse anyway), runaway
 * nesting, and oversized payloads — BEFORE the patch reaches the database.
 */
export function validatePatch(value: unknown): DocPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("patch must be an object");
  }
  const walk = (node: unknown, depth: number, path: string): void => {
    if (depth > MAX_PATCH_DEPTH) fail(`patch nests deeper than ${MAX_PATCH_DEPTH} at ${path}`);
    if (node === null) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, depth + 1, `${path}[${i}]`));
      return;
    }
    switch (typeof node) {
      case "string":
      case "number":
      case "boolean":
      case "undefined":
        return;
      case "object": {
        for (const key of Object.keys(node as Record<string, unknown>)) {
          if (FORBIDDEN_KEYS.has(key)) fail(`patch key "${key}" is not allowed`);
          walk((node as Record<string, unknown>)[key], depth + 1, `${path}.${key}`);
        }
        return;
      }
      default:
        fail(`patch value at ${path} is not serializable (${typeof node})`);
    }
  };
  walk(value, 0, "$");

  let size = 0;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    fail("patch is not JSON-serializable");
  }
  if (size > MAX_PATCH_BYTES) fail(`patch is larger than ${MAX_PATCH_BYTES} bytes`);
  return value as DocPatch;
}

export const ENCODER_IDS: readonly EncoderId[] = [
  "h264_nvenc",
  "h264_qsv",
  "h264_amf",
  "h264_videotoolbox",
  "libx264",
];

const RESOLUTIONS = new Set(["720p", "1080p", "4K"]);

/**
 * Validate an export request. The recipe is the SAME structure the cloud job
 * stores, so this check doubles as the guard that a malformed timeline can
 * never reach the renderer subprocess.
 */
export function validateExportRequest(value: unknown): StartExportRequest {
  if (typeof value !== "object" || value === null) fail("export request must be an object");
  const r = value as Record<string, unknown>;
  const jobId = validateHandle(r.jobId, "jobId");
  const projectId = validateHandle(r.projectId, "projectId");
  const mediaId = validateHandle(r.mediaId, "mediaId");
  const outputId = validateHandle(r.outputId, "outputId");
  const projectTitle = validateTitle(r.projectTitle);

  const recipe = r.recipe;
  if (typeof recipe !== "object" || recipe === null) fail("recipe must be an object");
  const rec = recipe as Record<string, unknown>;
  const num = (key: string): number => {
    const n = rec[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) fail(`recipe.${key} must be ≥ 0`);
    return n;
  };
  const width = num("sourceWidth");
  const height = num("sourceHeight");
  if (width < 16 || height < 16 || width > 16384 || height > 16384) {
    fail("recipe source dimensions are out of range");
  }
  num("sourceDuration");
  if (rec.fps !== 30 && rec.fps !== 60) fail("recipe.fps must be 30 or 60");
  if (typeof rec.resolution !== "string" || !RESOLUTIONS.has(rec.resolution)) {
    fail("recipe.resolution must be 720p, 1080p or 4K");
  }
  if (!Array.isArray(rec.moments)) fail("recipe.moments must be an array");
  if (rec.moments.length > 20000) fail("recipe.moments is unreasonably large");
  if (typeof rec.effects !== "object" || rec.effects === null) fail("recipe.effects must be an object");
  // The recipe travels into the render subprocess as JSON — run it through the
  // same structural guard as a project patch (prototype keys, depth, size).
  validatePatch(recipe);

  const encoder = r.encoder;
  if (
    encoder !== undefined &&
    encoder !== "auto" &&
    !ENCODER_IDS.includes(encoder as EncoderId)
  ) {
    fail("encoder is not a supported value");
  }

  return {
    jobId,
    projectId,
    projectTitle,
    mediaId,
    outputId,
    recipe: recipe as unknown as SerializedRenderRecipe,
    encoder: encoder as EncoderId | "auto" | undefined,
  };
}

/** Only real web links may be handed to the OS browser — never file:// or custom schemes. */
export function validateExternalUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) fail("url must be a short string");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("url is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail("only http(s) links can be opened externally");
  }
  return parsed.toString();
}

/**
 * A finished screen recording crossing the bridge.
 *
 * The renderer names the file, so the name is treated as hostile: only the base
 * name survives, control characters and separators are stripped, and the
 * extension is forced to one the app can actually decode. The byte length is
 * capped so a runaway take cannot fill the disk through this channel.
 */
export const MAX_RECORDING_BYTES = 4 * 1024 * 1024 * 1024;

export function validateRecordingName(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  // Strip any directory component BEFORE sanitising — "../../x.webm" must not
  // survive as a relative path, and neither must a Windows drive prefix.
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = Array.from(base)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(/[<>:"|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80);
  const stem = cleaned.replace(/\.[^.]*$/, "").trim() || "Recording";
  const ext = hasAcceptedVideoExtension(cleaned)
    ? cleaned.slice(cleaned.lastIndexOf(".")).toLowerCase()
    : ".webm";
  return `${stem}${ext}`;
}

export function validateRecordingBytes(value: unknown): ArrayBuffer {
  const buffer =
    value instanceof ArrayBuffer
      ? value
      : ArrayBuffer.isView(value)
        ? (value.buffer.slice(
            value.byteOffset,
            value.byteOffset + value.byteLength
          ) as ArrayBuffer)
        : null;
  if (!buffer) fail("recording must be transferred as bytes");
  if (buffer.byteLength === 0) fail("that recording is empty");
  if (buffer.byteLength > MAX_RECORDING_BYTES) {
    fail("that recording is too large to save");
  }
  return buffer;
}

/** `.webm` is what MediaRecorder produces, so recordings accept it too. */
export const RECORDING_EXTENSIONS = [".webm", ".mp4"] as const;

export type {
  AppInfo,
  EncoderInfo,
  ImportedMedia,
  LocalExportProgress,
  LocalExportRecord,
  LocalExportResult,
  LocalStorageUsage,
  MediaTransferSnapshot,
  MediaUploadJobView,
  ProjectLibraryStats,
  ProjectSummary,
};

/**
 * A Firebase Storage download URL, as reported back by the renderer after an
 * upload.
 *
 * This value is written into the project document and thence to every other
 * device, so it is checked rather than trusted: https only, and only the host
 * Firebase actually serves objects from. A renderer that has been compromised
 * must not be able to repoint a user's project at an attacker's video.
 */
const STORAGE_HOSTS = new Set([
  "firebasestorage.googleapis.com",
  "storage.googleapis.com",
]);

export function validateDownloadUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) fail("download url must be a short string");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("download url is not a valid URL");
  }
  if (parsed.protocol !== "https:") fail("download url must be https");
  if (!STORAGE_HOSTS.has(parsed.hostname)) fail("download url is not a Firebase Storage URL");
  return parsed.toString();
}

/** A byte count reported by a transfer. Bounded by the Storage rules' own cap. */
export function validateByteCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a non-negative number`);
  }
  if (value > MAX_RECORDING_BYTES) fail(`${label} is out of range`);
  return Math.floor(value);
}

/**
 * A Firebase uid, or null for "signed out".
 *
 * Deliberately strict: this value selects which queued operations may be sent,
 * so anything that isn't a plausible uid is rejected rather than coerced. Real
 * Firebase uids are 28 alphanumeric characters; the bound is loose enough to
 * survive a format change and tight enough to reject an injected path or an
 * object pretending to be a string.
 */
export function validateOwnerUid(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail("uid must be a string or null");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 128) fail("uid is too long");
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) fail("uid has invalid characters");
  return trimmed;
}

/** A wall-clock timestamp supplied by the renderer. */
export function validateTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("timestamp must be a non-negative number");
  }
  return Math.floor(value);
}

/** A document revision counter. */
export function validateRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("revision must be a non-negative number");
  }
  return Math.floor(value);
}

/**
 * A whole project document coming back from the cloud.
 *
 * Only the SHAPE is checked, not the contents: this is data the user's own
 * Firestore document already contains, and re-validating every field here would
 * duplicate the schema. What matters is that it is a plain JSON object of
 * bounded size, so a malformed payload cannot wedge the database.
 */
export function validateDocument(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("document must be an object");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail("document is not serialisable");
  }
  // Firestore's own per-document ceiling is 1 MiB; anything larger could not
  // have come from there and must not be written to SQLite either.
  if (serialized.length > 2 * 1024 * 1024) fail("document is too large");
  return value as Record<string, unknown>;
}

/** A conflict resolution map: dotted path → which side won. */
export function validateConflictChoices(
  value: unknown
): Record<string, "local" | "remote"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("choices must be an object");
  }
  const out: Record<string, "local" | "remote"> = {};
  for (const [path, choice] of Object.entries(value as Record<string, unknown>)) {
    if (typeof path !== "string" || path.length > 300) fail("invalid conflict path");
    if (choice !== "local" && choice !== "remote") fail("choice must be local or remote");
    out[path] = choice;
  }
  return out;
}
