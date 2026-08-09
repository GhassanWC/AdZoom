/**
 * The local project library — create, read, patch, list, delete, autosave and
 * crash-recovery, all against the SQLite database.
 *
 * The document stored in `projects.doc` is a real `ProjectDoc`: the exact shape
 * Firestore holds, produced here by `newLocalProjectDoc` and mutated ONLY by
 * `applyPatch` (the shared, pure merge-patch implementation the web's Firestore
 * writes are modelled on). That is what makes "the same editor, the same edits,
 * the same render recipe" literally true rather than aspirational.
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { applyPatch } from "@/lib/platform/patch";
import { MEDIA_URL_PREFIX } from "@/lib/platform/desktop/ipc";
import type { DocPatch } from "@/lib/platform/field-value";
import { LOCAL_OWNER as SHARED_LOCAL_OWNER } from "@/lib/platform/local";
import { DEFAULT_EFFECTS_SETTINGS } from "@/lib/firebase/schema";
import type { ProjectLibraryStats, ProjectSummary } from "@/lib/platform/types";
import type { DatabaseSync } from "node:sqlite";
import type { LocalDb } from "./db/client";
import { autosaves, media, projects, type MediaRow, type ProjectRow } from "./db/schema";
import { newId } from "./ids";

/** Keep the last N autosave snapshots per project (bounded disk use). */
export const AUTOSAVE_HISTORY = 20;

/**
 * The `userId` written into a local document. It is NOT a Firebase uid — local
 * projects belong to whoever is at the machine — but the field is part of
 * `ProjectDoc`, and stamping it explicitly keeps a project that later syncs to
 * the cloud obviously distinguishable from one that was always cloud-owned.
 *
 * Re-exported from the SHARED definition so the renderer (which reads it to
 * decide whether a delete goes to SQLite or Firestore) and this writer can
 * never drift apart.
 */
export const LOCAL_OWNER = SHARED_LOCAL_OWNER;

export interface CreateProjectInput {
  mediaId: string;
  title: string;
  /** Injected for deterministic tests. */
  now?: number;
  id?: string;
}

/**
 * How a write reaches the sync queue.
 *
 * Injected rather than imported so `createLibrary` stays testable without a sync
 * store, and so the library never has to know what an outbox IS — it hands over
 * the patch it just applied and the revision it applied it against.
 */
export interface SyncHook {
  /** The signed-in uid, or null while signed out (nothing is queued then). */
  ownerUid(): string | null;
  deviceId(): string;
  /** Mint an operation id. Injected so tests can make it deterministic. */
  newOpId(): string;
  enqueue(op: {
    ownerUid: string;
    entityId: string;
    patch: DocPatch;
    baseRev: number;
    opId: string;
    deviceId: string;
    now: number;
  }): void;
}

/**
 * A brand-new local project document. Mirrors what `createProjectFromFile`
 * writes on the web (status/effects/preset defaults), with the local media
 * protocol URL in `originalVideoUrl` and no storage path — nothing is uploaded.
 */
export function newLocalProjectDoc(args: {
  id: string;
  title: string;
  mediaUrl: string;
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
  now: number;
}): Record<string, unknown> {
  return {
    id: args.id,
    userId: LOCAL_OWNER,
    title: args.title,
    originalVideoUrl: args.mediaUrl,
    storagePath: "",
    duration: args.durationSec,
    width: args.width,
    height: args.height,
    fileSize: args.sizeBytes,
    mimeType: "video/mp4",
    status: "uploaded",
    effectsSettings: { ...DEFAULT_EFFECTS_SETTINGS },
    createdAt: args.now,
    updatedAt: args.now,
  };
}

export interface Library {
  create(input: CreateProjectInput & { mediaUrl: string }): Promise<Record<string, unknown>>;
  get(projectId: string): Promise<Record<string, unknown> | null>;
  getRow(projectId: string): Promise<ProjectRow | null>;
  write(projectId: string, patch: DocPatch, now?: number): Promise<Record<string, unknown>>;
  list(): Promise<ProjectSummary[]>;
  /** Counts only — the dashboard's numbers without the dashboard's documents. */
  stats(): Promise<ProjectLibraryStats>;
  remove(projectId: string): Promise<void>;
  markOpen(projectId: string, open: boolean): Promise<void>;
  /** Record the Firestore project this local one was synced to. */
  linkCloud(projectId: string, cloudProjectId: string): Promise<void>;
  /** Attach a video now on this disk. Does NOT touch the synced document. */
  attachMedia(projectId: string, mediaId: string): Promise<void>;
  closeAllSessions(): Promise<void>;
  /**
   * The SYNCHRONOUS variant, for `before-quit`.
   *
   * Drizzle's proxy driver is async, so an awaited update scheduled during quit
   * loses the race against `db.close()` — the flags stay set and the next
   * launch wrongly offers crash recovery after a perfectly clean exit. Shutdown
   * has to touch the connection directly.
   */
  closeAllSessionsSync(): void;
  pendingRecovery(): Promise<ProjectSummary[]>;
  resolveRecovery(projectId: string, action: "keep" | "discard"): Promise<Record<string, unknown> | null>;
  mediaFor(projectId: string): Promise<MediaRow | null>;
}

/**
 * THE TWO-COPY RULE — read this before touching `originalVideoUrl` anywhere.
 *
 * A project can have its source video in two places at once, and each place is
 * recorded somewhere different ON PURPOSE:
 *
 *   doc.originalVideoUrl  — the CLOUD copy. Part of the document, so it SYNCS.
 *                           It is what the website plays and what another
 *                           machine downloads.
 *   projects.media_id     — the copy on THIS disk. A column, so it never syncs.
 *
 * The desktop always prefers its own copy when READING, and never writes that
 * preference back into the document. Get this backwards — repoint
 * `originalVideoUrl` at `framevo://app/__media/…` because it is what this
 * machine wants — and the next push tells every other device that the video
 * lives at a URL only this computer can resolve. The web app would show a
 * broken project, and nothing would look wrong here.
 *
 * A pleasant consequence: `localMediaId(doc.originalVideoUrl)` — how the
 * renderer finds the file to export — keeps working for a project downloaded
 * from the cloud, with no special case anywhere downstream.
 */
function withLocalMedia(
  doc: Record<string, unknown>,
  mediaId: string | null,
  mediaPresent: boolean
): Record<string, unknown> {
  if (!mediaId || !mediaPresent) return doc;
  const local = `${MEDIA_URL_PREFIX}${mediaId}`;
  if (doc.originalVideoUrl === local) return doc;
  return { ...doc, originalVideoUrl: local };
}

export function createLibrary(db: LocalDb, raw: DatabaseSync, sync?: SyncHook): Library {
  const readRow = async (projectId: string): Promise<ProjectRow | null> => {
    const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    return rows[0] ?? null;
  };

  /** Is this media row still backed by a file we recorded? */
  const mediaExists = async (mediaId: string | null): Promise<boolean> => {
    if (!mediaId) return false;
    const rows = await db.select({ id: media.id }).from(media).where(eq(media.id, mediaId)).limit(1);
    return rows.length > 0;
  };

  /** Snapshot the document, then prune anything older than the newest N. */
  const snapshot = async (projectId: string, doc: Record<string, unknown>, revision: number, now: number) => {
    await db.insert(autosaves).values({ projectId, doc, revision, createdAt: now });
    const keep = await db
      .select({ createdAt: autosaves.createdAt })
      .from(autosaves)
      .where(eq(autosaves.projectId, projectId))
      .orderBy(desc(autosaves.createdAt))
      .limit(AUTOSAVE_HISTORY);
    const oldest = keep[keep.length - 1]?.createdAt;
    if (oldest !== undefined && keep.length >= AUTOSAVE_HISTORY) {
      await db
        .delete(autosaves)
        .where(and(eq(autosaves.projectId, projectId), lt(autosaves.createdAt, oldest)));
    }
  };

  return {
    async create(input) {
      const now = input.now ?? Date.now();
      const id = input.id ?? newId();
      const mediaRow = (
        await db.select().from(media).where(eq(media.id, input.mediaId)).limit(1)
      )[0];
      if (!mediaRow) throw new Error("That video is no longer in the library.");

      const doc = newLocalProjectDoc({
        id,
        title: input.title,
        mediaUrl: input.mediaUrl,
        durationSec: mediaRow.durationSec,
        width: mediaRow.width,
        height: mediaRow.height,
        sizeBytes: mediaRow.sizeBytes,
        now,
      });
      await db.insert(projects).values({
        id,
        title: input.title,
        mediaId: input.mediaId,
        doc,
        createdAt: now,
        updatedAt: now,
        openedAt: now,
        sessionOpen: false,
        revision: 0,
      });
      return doc;
    },

    async get(projectId) {
      const row = await readRow(projectId);
      if (!row) return null;
      // Resolve-at-read, never stored. See `withLocalMedia`.
      return withLocalMedia(row.doc, row.mediaId, await mediaExists(row.mediaId));
    },

    getRow: readRow,

    /**
     * Point a project at a video now on this disk — the last step of a download
     * from the cloud.
     *
     * Only the COLUMN moves. The document keeps naming the cloud copy, which is
     * what every other device needs it to say.
     */
    async attachMedia(projectId, mediaId) {
      await db.update(projects).set({ mediaId }).where(eq(projects.id, projectId));
    },

    /**
     * Apply ONE merge patch and persist. Every editor change lands here, which
     * is why autosave needs no timer: the document on disk is never behind the
     * editor by more than the write in flight. The snapshot history is what
     * makes recovery meaningful.
     */
    async write(projectId, patch, now = Date.now()) {
      const row = await readRow(projectId);
      if (!row) throw new Error(`Project ${projectId} is not in this library.`);
      const next = applyPatch(row.doc, patch, now);
      // The document's own `id`/`userId` are structural — a patch must never
      // repoint a local project at another row or owner.
      next.id = projectId;
      next.userId = row.doc.userId ?? LOCAL_OWNER;
      const revision = row.revision + 1;
      const title = typeof next.title === "string" && next.title.trim() ? next.title : row.title;

      // ── The durability boundary ──────────────────────────────────────────
      // The document update and its outbox row are ONE transaction. Split them
      // and there is a window in which the edit is on disk with no record that
      // it still owes the cloud a write — a crash inside that window loses the
      // change silently, which is exactly the failure this whole design exists
      // to prevent. `raw` is used directly because the Drizzle proxy driver is
      // async and cannot participate in a synchronous SQLite transaction.
      const ownerUid = sync?.ownerUid() ?? null;
      const queueOp = ownerUid
        ? {
            ownerUid,
            entityId: projectId,
            patch,
            // The revision the cloud last agreed on — NOT the local counter.
            // This is what the push compare-and-sets against.
            baseRev: row.baseRev,
            opId: sync!.newOpId(),
            deviceId: sync!.deviceId(),
            now,
          }
        : null;

      raw.exec("BEGIN");
      try {
        raw
          .prepare(
            `UPDATE projects
                SET doc = ?, updated_at = ?, revision = ?, title = ?,
                    sync_state = CASE WHEN sync_state = 'conflict' THEN 'conflict'
                                      WHEN ? IS NULL THEN sync_state
                                      ELSE 'pending' END
              WHERE id = ?`
          )
          .run(JSON.stringify(next), now, revision, title, ownerUid, projectId);
        if (queueOp) {
          raw
            .prepare(
              `INSERT INTO sync_outbox
                 (op_id, owner_uid, entity, entity_id, kind, payload, base_rev,
                  device_id, created_at, attempts, next_attempt_at, state)
               VALUES (?, ?, 'project', ?, 'patch', ?, ?, ?, ?, 0, 0, 'queued')`
            )
            .run(
              queueOp.opId,
              queueOp.ownerUid,
              projectId,
              JSON.stringify(queueOp.patch),
              queueOp.baseRev,
              queueOp.deviceId,
              now
            );
        }
        raw.exec("COMMIT");
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }

      await snapshot(projectId, next, revision, now);
      // The RAW document is what was stored; what goes back to the renderer is
      // resolved against this disk, exactly as `get` would return it. If these
      // two disagreed, the editor's <video> would swap sources mid-edit every
      // time a write echoed back.
      return withLocalMedia(next, row.mediaId, await mediaExists(row.mediaId));
    },

    async list() {
      const rows = await db
        .select({
          id: projects.id,
          title: projects.title,
          createdAt: projects.createdAt,
          updatedAt: projects.updatedAt,
          doc: projects.doc,
          mediaId: projects.mediaId,
          sessionOpen: projects.sessionOpen,
          cloudProjectId: projects.cloudProjectId,
        })
        .from(projects)
        .orderBy(desc(projects.updatedAt));

      const mediaRows = await db.select().from(media);
      const byId = new Map(mediaRows.map((m) => [m.id, m]));

      return rows.map((r): ProjectSummary => {
        const doc = r.doc as {
          duration?: number;
          width?: number;
          height?: number;
          originalVideoUrl?: string;
        };
        const mediaPresent = Boolean(r.mediaId && byId.has(r.mediaId));
        // A project whose video only exists in the cloud is NOT "media missing"
        // — it plays perfectly well from its download URL, and marking it
        // missing would dress a healthy synced project up as broken.
        const cloudUrl =
          typeof doc.originalVideoUrl === "string" && doc.originalVideoUrl.startsWith("https:")
            ? doc.originalVideoUrl
            : undefined;
        return {
          id: r.id,
          title: r.title,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          durationSec: doc.duration,
          width: doc.width,
          height: doc.height,
          // The local copy wins when it is actually there; otherwise the cloud
          // one. Nothing is offered when neither is — a <video> pointed at a
          // missing source just logs a decode error on every card.
          previewUrl: mediaPresent ? `${MEDIA_URL_PREFIX}${r.mediaId}` : cloudUrl,
          mediaMissing: !mediaPresent && !cloudUrl,
          /** True when the video is only in the cloud — the "Download" case. */
          cloudOnly: !mediaPresent && Boolean(cloudUrl),
          hasRecovery: r.sessionOpen,
          // The dedup key for the merged library — see useProjectLibrary.
          cloudProjectId: r.cloudProjectId ?? undefined,
        };
      });
    },

    /**
     * The library's numbers, in two aggregate queries and no documents.
     *
     * `mediaBytes` sums the size RECORDED at import rather than stat-ing every
     * file: this answers a dashboard tile, and a filesystem walk per project is
     * what `storage.usage()` is for. The two can disagree after the user moves
     * or deletes a source video behind our back — the Storage screen is where
     * that precision is worth paying for, and it says so there.
     */
    async stats(): Promise<ProjectLibraryStats> {
      const [counts] = await db
        .select({
          // COUNT(column) skips NULLs, which is exactly the dedup overlap:
          // rows that name a cloud twin.
          projectCount: sql<number>`count(*)`,
          linkedCount: sql<number>`count(${projects.cloudProjectId})`,
        })
        .from(projects);

      const [bytes] = await db
        .select({ mediaBytes: sql<number>`coalesce(sum(${media.sizeBytes}), 0)` })
        .from(media);

      return {
        projectCount: Number(counts?.projectCount ?? 0),
        linkedCount: Number(counts?.linkedCount ?? 0),
        mediaBytes: Number(bytes?.mediaBytes ?? 0),
      };
    },

    async remove(projectId) {
      // The user's video file is NEVER touched — only the project row and its
      // autosaves (cascade). Media rows are shared and stay for other projects.
      await db.delete(projects).where(eq(projects.id, projectId));
    },

    /**
     * Point a local project at its cloud twin.
     *
     * Stored in a COLUMN, not inside `doc`: the library listing reads it to
     * dedupe, and a merge patch could otherwise clear it as a side effect of an
     * unrelated edit. The document itself stays a faithful `ProjectDoc`.
     */
    async linkCloud(projectId, cloudProjectId) {
      await db.update(projects).set({ cloudProjectId }).where(eq(projects.id, projectId));
    },

    async markOpen(projectId, open) {
      await db
        .update(projects)
        .set({ sessionOpen: open, ...(open ? { openedAt: Date.now() } : {}) })
        .where(eq(projects.id, projectId));
    },

    /** Clear every open flag — called on a clean quit. */
    async closeAllSessions() {
      await db.update(projects).set({ sessionOpen: false }).where(sql`1 = 1`);
    },

    closeAllSessionsSync() {
      raw.prepare("UPDATE projects SET session_open = 0 WHERE session_open = 1").run();
    },

    /**
     * Projects still flagged open at startup: the previous run did not shut
     * down cleanly, so the newest snapshot may be newer than what the user last
     * saw. They are offered a choice rather than silently overwritten.
     */
    async pendingRecovery() {
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.sessionOpen, true))
        .orderBy(desc(projects.updatedAt));
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        hasRecovery: true,
      }));
    },

    /**
     * "keep"    → adopt the newest autosave snapshot (the crash-time state).
     * "discard" → drop snapshots newer than the committed document.
     * Either way the open flag is cleared so the prompt doesn't return.
     */
    async resolveRecovery(projectId, action) {
      const row = await readRow(projectId);
      if (!row) return null;
      let doc = row.doc;
      if (action === "keep") {
        const latest = (
          await db
            .select()
            .from(autosaves)
            .where(eq(autosaves.projectId, projectId))
            .orderBy(desc(autosaves.createdAt))
            .limit(1)
        )[0];
        if (latest && latest.revision >= row.revision) {
          doc = latest.doc;
          await db
            .update(projects)
            .set({ doc, revision: latest.revision, updatedAt: Date.now() })
            .where(eq(projects.id, projectId));
        }
      }
      await db.update(projects).set({ sessionOpen: false }).where(eq(projects.id, projectId));
      return doc;
    },

    async mediaFor(projectId) {
      const row = await readRow(projectId);
      if (!row?.mediaId) return null;
      const rows = await db.select().from(media).where(eq(media.id, row.mediaId)).limit(1);
      return rows[0] ?? null;
    },
  };
}
