/**
 * The local library schema (Drizzle ORM, SQLite).
 *
 * DESIGN RULE: no video bytes ever live in this database. `media` stores a
 * VALIDATED absolute path plus identity metadata (size + mtime) so the app can
 * tell "moved/deleted" from "edited externally"; the frames themselves are read
 * straight off the user's disk by the media protocol and by FFmpeg.
 *
 * `projects.doc` holds the SAME `ProjectDoc` JSON the cloud stores in Firestore.
 * Keeping it as one document (rather than shredding moments into rows) is what
 * lets the identical editor, the identical merge patches and the identical
 * render recipe work against either backend — and it means a local project can
 * be pushed to the cloud later without a translation step.
 */
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const media = sqliteTable("media", {
  /** Opaque handle exposed to the renderer (never the path). */
  id: text("id").primaryKey(),
  /** Absolute path on this machine. Main-process only. */
  path: text("path").notNull(),
  fileName: text("file_name").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  /** File mtime (epoch ms) at import — detects "replaced since import". */
  mtimeMs: integer("mtime_ms").notNull(),
  /** Fractional seconds — REAL, not INTEGER (a 12.4s clip is not 12s). */
  durationSec: real("duration_sec").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  videoCodec: text("video_codec").notNull().default(""),
  audioCodec: text("audio_codec").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  /**
   * True when Framevo WROTE this file (a screen recording saved into the
   * library folder) rather than merely referencing a file the user already had.
   * Only owned files may ever be deleted from the Storage screen.
   */
  owned: integer("owned", { mode: "boolean" }).notNull().default(false),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    mediaId: text("media_id").references(() => media.id, { onDelete: "set null" }),
    /** The full ProjectDoc as JSON — identical shape to the Firestore document. */
    doc: text("doc", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Epoch ms of the last time this project was opened in the editor. */
    openedAt: integer("opened_at"),
    /**
     * Set while a session has the project open, cleared on clean close. A row
     * still marked open at startup means the app died with unsaved work — the
     * recovery snapshot is offered to the user. See recovery.ts.
     */
    sessionOpen: integer("session_open", { mode: "boolean" }).notNull().default(false),
    /** Monotonic write counter — cheap way to tell snapshots apart. */
    revision: integer("revision").notNull().default(0),
    /**
     * The Firestore project id this row mirrors, when there is one.
     *
     * This is the library's DEDUP KEY: a project the user has in both places
     * must appear once, and the local copy is the one that opens with no
     * network. NULL for a project that has never left this computer.
     */
    cloudProjectId: text("cloud_project_id"),

    // ── Sync state ──────────────────────────────────────────────────────────
    /**
     * The Firebase uid this row belongs to. NULL for a project created before
     * sync, or while signed out.
     *
     * This is the AUTHENTICATION ISOLATION key: every outbox claim and every
     * pull is filtered on it, so signing out and in as somebody else on the
     * same machine can never push one account's queued work into another's
     * Firestore. Signing out does not delete these rows — it only stops them
     * being drained.
     */
    ownerUid: text("owner_uid"),
    /** synced | pending | syncing | conflict | failed — see lib/sync/types.ts. */
    syncState: text("sync_state").notNull().default("pending"),
    /**
     * The last document this machine and the cloud AGREED on — the common
     * ancestor for the three-way merge. Without it, a simultaneous edit cannot
     * be told from a plain download, and every reconnect would look like a
     * conflict. NULL until the project has synced once.
     */
    baseDoc: text("base_doc", { mode: "json" }).$type<Record<string, unknown>>(),
    /** `rev` of `baseDoc` — what a push compare-and-sets against. */
    baseRev: integer("base_rev").notNull().default(0),
    /** `updatedAt` last seen on the remote, for staleness display. */
    remoteUpdatedAt: integer("remote_updated_at"),
    lastSyncedAt: integer("last_synced_at"),
    /** Why the last attempt failed, retained so the UI can offer real detail. */
    lastError: text("last_error"),
    /** Unresolved `FieldConflict[]`, present only while syncState = 'conflict'. */
    conflicts: text("conflicts", { mode: "json" }).$type<unknown[]>(),
  },
  (t) => [
    index("projects_updated_at_idx").on(t.updatedAt),
    index("projects_cloud_id_idx").on(t.cloudProjectId),
    index("projects_sync_idx").on(t.ownerUid, t.syncState),
  ]
);

/**
 * The durable outbox — every local change that the cloud has not accepted yet.
 *
 * This table IS the "pending changes survive restart and offline use"
 * requirement. A row is written in the SAME transaction as the document it
 * describes (see library.write), so there is no window in which an edit is on
 * disk but its intent to sync is not. A row is deleted only once Firestore has
 * acknowledged it.
 */
export const syncOutbox = sqliteTable(
  "sync_outbox",
  {
    /** Idempotency key, minted at ENQUEUE time so retries reuse it. */
    opId: text("op_id").primaryKey(),
    ownerUid: text("owner_uid").notNull(),
    /** project | media | export */
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    /** patch | delete | upload */
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    /** The revision this op was composed against (compare-and-set). */
    baseRev: integer("base_rev").notNull().default(0),
    deviceId: text("device_id").notNull(),
    createdAt: integer("created_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Epoch ms before which this row must not be claimed (backoff). */
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    /** queued | inflight | failed | done */
    state: text("state").notNull().default("queued"),
    lastError: text("last_error"),
  },
  (t) => [
    // The drain query: "claimable ops for this account, oldest first".
    index("outbox_claim_idx").on(t.ownerUid, t.state, t.nextAttemptAt),
    index("outbox_entity_idx").on(t.entity, t.entityId),
  ]
);

/**
 * Deletion tombstones.
 *
 * A deleted row cannot carry its own "please delete me remotely" flag, so the
 * intent outlives the record here. Without this, deleting a project offline
 * would simply make it reappear on the next pull — the cloud still has it, and
 * nothing local remembers that the user said no.
 */
export const tombstones = sqliteTable(
  "tombstones",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    ownerUid: text("owner_uid"),
    deletedAt: integer("deleted_at").notNull(),
    deviceId: text("device_id").notNull(),
    /** Cleared once the remote delete is confirmed; the row is then prunable. */
    synced: integer("synced", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("tombstones_entity_idx").on(t.entity, t.entityId)]
);

/**
 * Source media awaiting (or having completed) upload to Firebase Storage.
 *
 * Media is NOT uploaded automatically — a recording can be tens of gigabytes.
 * A row sits in `local` until the user asks for the project to be available on
 * the web, or a cloud feature that needs the source (AI analysis) is invoked.
 */
export const mediaUploads = sqliteTable(
  "media_uploads",
  {
    mediaId: text("media_id").primaryKey(),
    projectId: text("project_id").notNull(),
    ownerUid: text("owner_uid").notNull(),
    /** local | pending | uploading | uploaded | failed */
    state: text("state").notNull().default("local"),
    /**
     * SHA-256 of the file, streamed at enqueue time. Verified against the
     * uploaded object before the project's `storagePath` is repointed, so a
     * truncated upload can never become a project's source.
     */
    checksumSha256: text("checksum_sha256"),
    /**
     * BASE64 MD5 — the only digest Firebase Storage reports back, so it is what
     * makes post-upload verification a real comparison instead of a guess.
     */
    checksumMd5: text("checksum_md5"),
    bytesTotal: integer("bytes_total").notNull().default(0),
    bytesSent: integer("bytes_sent").notNull().default(0),
    storagePath: text("storage_path"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("media_uploads_state_idx").on(t.ownerUid, t.state)]
);

/**
 * Locally rendered exports awaiting upload + their cloud record.
 *
 * Separate from `exports` (which is "a file this machine produced") because the
 * cloud half has its own lifecycle: a permit is issued, bytes are uploaded, then
 * the Firestore doc is patched to `ready`. Keeping `exportDocId` and the local
 * path here is what lets a failed upload RESUME rather than re-render — the
 * expensive half is already on disk.
 */
export const exportUploads = sqliteTable(
  "export_uploads",
  {
    outputId: text("output_id").primaryKey(),
    projectId: text("project_id").notNull(),
    ownerUid: text("owner_uid").notNull(),
    /** The permitted Firestore export doc, once the permit has been issued. */
    exportDocId: text("export_doc_id"),
    /** pending | permitting | uploading | patching | done | failed */
    state: text("state").notNull().default("pending"),
    storagePath: text("storage_path"),
    checksumSha256: text("checksum_sha256"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("export_uploads_state_idx").on(t.ownerUid, t.state)]
);

/**
 * Rolling autosave snapshots. One row per save point, pruned to the newest N per
 * project. This is the crash-recovery record: the newest snapshot for a project
 * whose `sessionOpen` survived a hard shutdown is what the user is offered.
 */
export const autosaves = sqliteTable(
  "autosaves",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    doc: text("doc", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    revision: integer("revision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("autosaves_project_idx").on(t.projectId, t.createdAt)]
);

/**
 * A project's source video coming DOWN from the cloud.
 *
 * The mirror of `media_uploads`, and a separate table for the same reason: a
 * multi-gigabyte transfer must never share a queue with a title change.
 *
 * One row per PROJECT (not per media), because the download is what CREATES the
 * media row — until the bytes land and probe cleanly there is no media id to key
 * on. `mediaId` is filled in at completion and is what the project is then
 * attached to.
 */
export const mediaDownloads = sqliteTable(
  "media_downloads",
  {
    projectId: text("project_id").primaryKey(),
    ownerUid: text("owner_uid").notNull(),
    /** pending | downloading | done | failed */
    state: text("state").notNull().default("pending"),
    /** The library media row this download became. Null until it succeeds. */
    mediaId: text("media_id"),
    fileName: text("file_name").notNull().default(""),
    bytesTotal: integer("bytes_total").notNull().default(0),
    bytesReceived: integer("bytes_received").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("media_downloads_state_idx").on(t.ownerUid, t.state)]
);

/** Where finished exports went, so "Reveal in folder" works after a restart. */
export const exports = sqliteTable("exports", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  /** Denormalised: an export outlives the project it was made from. */
  projectTitle: text("project_title").notNull().default(""),
  path: text("path").notNull(),
  fileName: text("file_name").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  encoder: text("encoder").notNull().default(""),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at").notNull(),
});

/** Small key/value store for app state (last opened project, migrations, …). */
export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .default(sql`0`),
});

export type ProjectRow = typeof projects.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type ExportRow = typeof exports.$inferSelect;

export type SyncOutboxRow = typeof syncOutbox.$inferSelect;
export type TombstoneRow = typeof tombstones.$inferSelect;
export type MediaUploadRow = typeof mediaUploads.$inferSelect;
export type MediaDownloadRow = typeof mediaDownloads.$inferSelect;
export type ExportUploadRow = typeof exportUploads.$inferSelect;
