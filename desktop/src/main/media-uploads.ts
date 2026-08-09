/**
 * Source media on its way to Firebase Storage.
 *
 * WHY THIS IS A SEPARATE QUEUE
 * ----------------------------
 * A project document is kilobytes and always syncs. A screen recording is
 * gigabytes and syncs only when the user asks (or when a cloud feature that
 * genuinely needs the source, like AI analysis, is invoked). Putting both
 * through one queue would mean a 4 GB upload blocking a title change behind it.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD
 * --------------------------------------
 * A project's `storagePath` / `originalVideoUrl` is repointed at the cloud copy
 * ONLY after the uploaded object has been verified against the local file's
 * checksum. Until then the project keeps pointing at the file on this disk. A
 * half-uploaded object can therefore never become a project's source — which is
 * the difference between "sync is slow" and "sync ate my video".
 */
import { and, eq, inArray, lte } from "drizzle-orm";
import { decideRetry, rearm } from "@/lib/sync/backoff";
import type { LocalDb } from "./db/client";
import { media, mediaUploads, projects } from "./db/schema";

/**
 * local     — on this machine only. The resting state; NOT a problem.
 * pending   — the user asked for it; waiting for a worker.
 * uploading — bytes are moving.
 * uploaded  — verified and the project now points at the cloud copy.
 * failed    — parked with a reason; the local file is untouched.
 */
export type MediaUploadState = "local" | "pending" | "uploading" | "uploaded" | "failed";

export interface MediaUploadJob {
  mediaId: string;
  projectId: string;
  ownerUid: string;
  /** Storage object path the bytes must land at. */
  storagePath: string;
  bytesTotal: number;
  checksumSha256: string | null;
  checksumMd5: string | null;
  attempts: number;
}

/** One project's upload state, as the UI renders it. */
export interface MediaUploadSnapshot {
  projectId: string;
  mediaId: string;
  state: MediaUploadState;
  bytesSent: number;
  bytesTotal: number;
  lastError?: string;
}

export interface MediaUploadsStoreOptions {
  /**
   * Apply the repoint to the project document.
   *
   * MUST be the library's own write. The new `originalVideoUrl` has to reach
   * the CLOUD document — that is the entire point of uploading — and
   * `library.write` is the one path that puts a document change and its sync
   * operation in a single transaction. Writing the row directly here would
   * leave a project whose local copy names the uploaded object and whose cloud
   * copy still names nothing, with no record that it owed anyone a write.
   */
  repoint(
    projectId: string,
    patch: { storagePath: string; originalVideoUrl: string }
  ): Promise<void>;
}

export interface MediaUploadsStore {
  /**
   * Mark a project's source for upload. Idempotent — asking twice does not
   * queue twice, and asking for something already uploaded does nothing.
   */
  request(args: {
    projectId: string;
    ownerUid: string;
    now: number;
    /** Injected: hashing is I/O and belongs to the caller that owns the path. */
    digest: (path: string) => Promise<{ sha256: string; md5Base64: string; sizeBytes: number }>;
  }): Promise<{ queued: boolean; reason?: string }>;
  claim(ownerUid: string, now: number, limit?: number): Promise<MediaUploadJob[]>;
  progress(mediaId: string, bytesSent: number, now: number): Promise<void>;
  /**
   * The object is uploaded AND verified. Repoints the project at the cloud copy
   * — the only place that ever happens.
   */
  complete(args: {
    mediaId: string;
    downloadUrl: string;
    now: number;
  }): Promise<void>;
  fail(
    mediaId: string,
    error: { message: string; code?: string },
    now: number
  ): Promise<void>;
  retry(mediaId: string, now: number): Promise<void>;
  stateOf(mediaId: string): Promise<MediaUploadState | null>;
  /** One project's upload, for the UI. Null when it has never been asked for. */
  stateForProject(projectId: string): Promise<MediaUploadSnapshot | null>;
  /** Every upload this account has a record of. */
  list(ownerUid: string): Promise<MediaUploadSnapshot[]>;
  /**
   * Media whose bytes exist ONLY on this machine.
   *
   * The cleanup guard: anything in here must never be deleted by a "free up
   * space" action, because the cloud does not have a copy to restore from.
   */
  unsyncedMediaIds(): Promise<Set<string>>;
}

/**
 * Where a project's source lives in Storage. Mirrors the web upload path —
 * `users/{uid}/projects/{projectId}/…` is the prefix the Storage rules enforce
 * ownership on, so the object is unreachable by anyone else by construction.
 *
 * The file name comes from the user's disk, so it is reduced to a safe token.
 * Separators are the part that matters: with `/` and `\` gone there is no
 * traversal to perform. Runs of dots are collapsed anyway, because a leading dot
 * or an embedded `..` in an object name is legal but reads like an exploit in a
 * bucket listing, and nobody should have to reason about whether it is one.
 */
export function mediaStoragePath(uid: string, projectId: string, fileName: string): string {
  const safe =
    fileName
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^\.+/, "")
      .slice(-120) || "source.mp4";
  return `users/${uid}/projects/${projectId}/${safe}`;
}

export function createMediaUploadsStore(
  db: LocalDb,
  options: MediaUploadsStoreOptions
): MediaUploadsStore {
  return {
    async request({ projectId, ownerUid, now, digest }) {
      const projectRows = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const project = projectRows[0];
      if (!project?.mediaId) return { queued: false, reason: "This project has no local video." };

      const mediaRows = await db
        .select()
        .from(media)
        .where(eq(media.id, project.mediaId))
        .limit(1);
      const row = mediaRows[0];
      if (!row) return { queued: false, reason: "That video is no longer in the library." };

      const existing = await db
        .select()
        .from(mediaUploads)
        .where(eq(mediaUploads.mediaId, row.id))
        .limit(1);
      const current = existing[0];
      if (current?.state === "uploaded") return { queued: false, reason: "Already uploaded." };
      if (current?.state === "pending" || current?.state === "uploading") {
        return { queued: false, reason: "Already in progress." };
      }

      // Hashed BEFORE anything is sent. Doing it afterwards would only prove the
      // file we happened to read at the end matched — not that the bytes on the
      // wire were the bytes the user has.
      const hash = await digest(row.path);
      const storagePath = mediaStoragePath(ownerUid, projectId, row.fileName);

      const values = {
        mediaId: row.id,
        projectId,
        ownerUid,
        state: "pending" as const,
        checksumSha256: hash.sha256,
        checksumMd5: hash.md5Base64,
        bytesTotal: hash.sizeBytes,
        bytesSent: 0,
        storagePath,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        updatedAt: now,
      };

      if (current) {
        await db.update(mediaUploads).set(values).where(eq(mediaUploads.mediaId, row.id));
      } else {
        await db.insert(mediaUploads).values(values);
      }
      return { queued: true };
    },

    async claim(ownerUid, now, limit = 1) {
      // ONE at a time by default. Two concurrent multi-gigabyte uploads on a
      // home connection make both slower and neither finish.
      const due = await db
        .select()
        .from(mediaUploads)
        .where(
          and(
            eq(mediaUploads.ownerUid, ownerUid),
            eq(mediaUploads.state, "pending"),
            lte(mediaUploads.nextAttemptAt, now)
          )
        )
        .limit(limit);
      if (due.length === 0) return [];

      await db
        .update(mediaUploads)
        .set({ state: "uploading", updatedAt: now })
        .where(inArray(mediaUploads.mediaId, due.map((r) => r.mediaId)));

      return due.map(
        (r): MediaUploadJob => ({
          mediaId: r.mediaId,
          projectId: r.projectId,
          ownerUid: r.ownerUid,
          storagePath: r.storagePath ?? "",
          bytesTotal: r.bytesTotal,
          checksumSha256: r.checksumSha256,
          checksumMd5: r.checksumMd5,
          attempts: r.attempts,
        })
      );
    },

    async progress(mediaId, bytesSent, now) {
      await db
        .update(mediaUploads)
        .set({ bytesSent, updatedAt: now })
        .where(eq(mediaUploads.mediaId, mediaId));
    },

    async complete({ mediaId, downloadUrl, now }) {
      const rows = await db
        .select()
        .from(mediaUploads)
        .where(eq(mediaUploads.mediaId, mediaId))
        .limit(1);
      const row = rows[0];
      if (!row) return;

      await db
        .update(mediaUploads)
        .set({
          state: "uploaded",
          bytesSent: row.bytesTotal,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(mediaUploads.mediaId, mediaId));

      // THE repoint. Everything above exists so that this happens exactly once,
      // after verification, and never on a partial object.
      //
      // It goes through the library rather than straight at the row so that the
      // document change and the sync operation carrying it to Firestore are one
      // transaction — otherwise the project would name its uploaded video here
      // and nowhere else, which is the same as not having uploaded it.
      //
      // Note what this does NOT do: clear `projects.media_id`. The file is
      // still on this disk and this machine still prefers it (see the two-copy
      // rule in library.ts). Uploading gives the video a second home; it does
      // not move it.
      const projectRows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, row.projectId))
        .limit(1);
      if (!projectRows[0]) return;
      await options.repoint(row.projectId, {
        storagePath: row.storagePath ?? "",
        originalVideoUrl: downloadUrl,
      });
    },

    async fail(mediaId, error, now) {
      const rows = await db
        .select()
        .from(mediaUploads)
        .where(eq(mediaUploads.mediaId, mediaId))
        .limit(1);
      const row = rows[0];
      if (!row) return;
      const decision = decideRetry({
        attempts: row.attempts,
        now,
        message: error.message,
        code: error.code,
      });
      await db
        .update(mediaUploads)
        .set({
          // A rescheduled upload returns to `pending`; a parked one is `failed`.
          state: decision.state === "failed" ? "failed" : "pending",
          attempts: decision.attempts,
          nextAttemptAt: decision.nextAttemptAt,
          lastError: decision.lastError,
          // Restart from zero: a resumable session that failed cannot be assumed
          // to still be valid, and reporting stale progress would be a lie.
          bytesSent: 0,
          updatedAt: now,
        })
        .where(eq(mediaUploads.mediaId, mediaId));
    },

    async retry(mediaId, now) {
      const armed = rearm(now);
      await db
        .update(mediaUploads)
        .set({
          state: "pending",
          attempts: armed.attempts,
          nextAttemptAt: armed.nextAttemptAt,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(mediaUploads.mediaId, mediaId));
    },

    async stateOf(mediaId) {
      const rows = await db
        .select({ state: mediaUploads.state })
        .from(mediaUploads)
        .where(eq(mediaUploads.mediaId, mediaId))
        .limit(1);
      return (rows[0]?.state as MediaUploadState) ?? null;
    },

    async stateForProject(projectId) {
      const rows = await db
        .select()
        .from(mediaUploads)
        .where(eq(mediaUploads.projectId, projectId))
        .limit(1);
      const row = rows[0];
      return row ? toUploadSnapshot(row) : null;
    },

    async list(ownerUid) {
      const rows = await db
        .select()
        .from(mediaUploads)
        .where(eq(mediaUploads.ownerUid, ownerUid));
      return rows.map(toUploadSnapshot);
    },

    async unsyncedMediaIds() {
      const all = await db.select({ id: media.id }).from(media);
      const uploaded = await db
        .select({ mediaId: mediaUploads.mediaId })
        .from(mediaUploads)
        .where(eq(mediaUploads.state, "uploaded"));
      const safe = new Set(uploaded.map((r) => r.mediaId));
      // Anything without a VERIFIED upload is unsynced. Note the default: a
      // media row with no upload record at all counts as unsynced, so the guard
      // fails closed rather than open.
      return new Set(all.map((r) => r.id).filter((id) => !safe.has(id)));
    },
  };
}

function toUploadSnapshot(row: {
  projectId: string;
  mediaId: string;
  state: string;
  bytesSent: number;
  bytesTotal: number;
  lastError: string | null;
}): MediaUploadSnapshot {
  return {
    projectId: row.projectId,
    mediaId: row.mediaId,
    state: row.state as MediaUploadState,
    bytesSent: row.bytesSent,
    bytesTotal: row.bytesTotal,
    lastError: row.lastError ?? undefined,
  };
}
