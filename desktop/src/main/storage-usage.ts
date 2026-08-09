/**
 * What Framevo is using on this computer, and what of it is safe to reclaim.
 *
 * The distinction that matters throughout: Framevo REFERENCES the user's own
 * videos (imported with the file picker — never copied, never deletable from
 * here) and OWNS the files it wrote itself (screen recordings saved into the
 * library folder, and exports the user asked for). Only owned files are ever
 * offered for deletion, and exports only with an explicit confirmation.
 */
import { statfsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { and, desc, eq, lt } from "drizzle-orm";
import type { DatabaseSync } from "node:sqlite";
import type { LocalStorageUsage } from "@/lib/platform/types";
import type { LocalDb } from "./db/client";
import {
  autosaves,
  exports as exportsTable,
  media,
  mediaUploads,
  projects,
} from "./db/schema";
import { logger } from "./logger";

function fileSize(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/**
 * Free bytes on the volume holding `path`.
 *
 * A number the user cares about but that no feature depends on — an
 * unsupported filesystem omits it rather than failing the whole usage report.
 */
export function freeSpaceFor(path: string): number | undefined {
  try {
    const info = statfsSync(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return undefined;
  }
}

export interface StorageService {
  usage(): Promise<LocalStorageUsage>;
  purgeMissingMedia(): Promise<{ removed: number }>;
  /**
   * Media that is safe to delete: owned by Framevo, present on disk, and
   * verified in the cloud. Empty until cloud sync has actually uploaded
   * something — the guard fails closed.
   */
  reclaimableMedia(): Promise<{ mediaId: string; sizeBytes: number }[]>;
  compactAutosaves(): Promise<{ removedSnapshots: number; freedBytes: number }>;
}

/**
 * Media whose bytes exist ONLY on this machine.
 *
 * Duplicated deliberately from media-uploads.ts rather than imported: the
 * storage service is constructed before the upload store in some code paths,
 * and a cleanup guard must not be able to fail open because of a wiring order.
 */
async function unsyncedMediaIdsFor(db: LocalDb): Promise<Set<string>> {
  const all = await db.select({ id: media.id }).from(media);
  const uploaded = await db
    .select({ mediaId: mediaUploads.mediaId })
    .from(mediaUploads)
    .where(eq(mediaUploads.state, "uploaded"));
  const safe = new Set(uploaded.map((r) => r.mediaId));
  return new Set(all.map((r) => r.id).filter((id) => !safe.has(id)));
}

export function createStorageService(options: {
  db: LocalDb;
  /** The raw connection — VACUUM cannot run through the async proxy driver. */
  raw: DatabaseSync;
  /** Folder holding the SQLite library + saved recordings. */
  libraryDir: string;
  databasePath: string;
}): StorageService {
  const { db, raw, libraryDir, databasePath } = options;

  return {
    async usage(): Promise<LocalStorageUsage> {
      const mediaRows = await db.select().from(media);
      let mediaBytes = 0;
      let missingMediaCount = 0;
      let recordingBytes = 0;
      let recordingCount = 0;
      for (const row of mediaRows) {
        const size = fileSize(row.path);
        if (size === null) {
          missingMediaCount += 1;
          continue;
        }
        if (row.owned) {
          recordingBytes += size;
          recordingCount += 1;
        } else {
          mediaBytes += size;
        }
      }

      const exportRows = await db.select().from(exportsTable);
      let exportBytes = 0;
      let exportCount = 0;
      let staleExportCount = 0;
      for (const row of exportRows) {
        const size = fileSize(row.path);
        if (size === null) {
          staleExportCount += 1;
          continue;
        }
        exportBytes += size;
        exportCount += 1;
      }

      // The database plus its WAL/SHM siblings — all three are the library.
      const databaseBytes =
        (fileSize(databasePath) ?? 0) +
        (fileSize(`${databasePath}-wal`) ?? 0) +
        (fileSize(`${databasePath}-shm`) ?? 0);

      return {
        mediaBytes,
        mediaCount: mediaRows.length - missingMediaCount - recordingCount,
        missingMediaCount,
        exportBytes,
        exportCount,
        staleExportCount,
        recordingBytes,
        recordingCount,
        databaseBytes,
        freeDiskBytes: freeSpaceFor(libraryDir),
        libraryFolderName: basename(libraryDir),
      };
    },

    /**
     * Forget media rows whose file is gone. The projects that pointed at them
     * survive (they keep their edit history and can be re-linked by re-importing
     * the video), they simply read as "source missing" — which is already how
     * the library renders them.
     */
    async purgeMissingMedia() {
      const rows = await db.select().from(media);
      let removed = 0;
      for (const row of rows) {
        if (fileSize(row.path) !== null) continue;
        await db.update(projects).set({ mediaId: null }).where(eq(projects.mediaId, row.id));
        await db.delete(media).where(eq(media.id, row.id));
        removed += 1;
      }
      if (removed) logger.info("missing media rows purged", { removed });
      return { removed };
    },

    /**
     * Media this machine could safely delete: the file exists, Framevo owns it
     * (a recording we wrote, never a file the user merely pointed us at), AND a
     * VERIFIED copy is in the cloud.
     *
     * The last condition is the one that matters. "Free up space" must never
     * remove the only copy of something, so this fails CLOSED: media with no
     * upload record at all is treated as unsynced, not as safe. A user who has
     * never turned on cloud sync therefore has nothing reclaimable here, which
     * is the correct and boring answer.
     */
    async reclaimableMedia() {
      const unsynced = await unsyncedMediaIdsFor(db);
      const rows = await db.select().from(media);
      return rows
        .filter((row) => row.owned && fileSize(row.path) !== null && !unsynced.has(row.id))
        .map((row) => ({ mediaId: row.id, sizeBytes: fileSize(row.path) ?? 0 }));
    },

    /**
     * Keep the newest autosave per project and drop the rest.
     *
     * Crash recovery only ever offers the newest snapshot, so the older ones
     * are pure history — worth reclaiming when a long editing session has piled
     * them up, and safe because the committed document is untouched.
     */
    async compactAutosaves() {
      const before = fileSize(databasePath) ?? 0;
      const rows = await db.select({ id: projects.id }).from(projects);
      let removedSnapshots = 0;
      for (const { id } of rows) {
        const newest = (
          await db
            .select({ createdAt: autosaves.createdAt })
            .from(autosaves)
            .where(eq(autosaves.projectId, id))
            .orderBy(desc(autosaves.createdAt))
            .limit(1)
        )[0];
        if (!newest) continue;
        const doomed = await db
          .select({ id: autosaves.id })
          .from(autosaves)
          .where(and(eq(autosaves.projectId, id), lt(autosaves.createdAt, newest.createdAt)));
        if (!doomed.length) continue;
        await db
          .delete(autosaves)
          .where(and(eq(autosaves.projectId, id), lt(autosaves.createdAt, newest.createdAt)));
        removedSnapshots += doomed.length;
      }
      if (removedSnapshots) {
        // VACUUM is what actually returns the pages to the filesystem; without
        // it the file stays exactly as large and the screen reports no gain.
        // It runs on the raw connection: VACUUM cannot execute inside a
        // transaction, and it is a statement with no rows to map.
        raw.exec("VACUUM");
      }
      const after = fileSize(databasePath) ?? 0;
      logger.info("autosaves compacted", { removedSnapshots });
      return { removedSnapshots, freedBytes: Math.max(0, before - after) };
    },
  };
}
