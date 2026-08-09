/**
 * The local export library — the files this machine produced.
 *
 * The renderer never learns a path. It holds `outputId`s; this module owns the
 * mapping and answers with the file NAME plus the containing FOLDER name, which
 * is what "Exports" needs to show a user where something went without leaking
 * their directory layout into the page.
 *
 * "Delete" here means: forget the record, and — only when the user asked for it
 * — remove the file Framevo itself wrote. The user's source video is never a
 * candidate; the app does not own it.
 */
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { desc, eq } from "drizzle-orm";
import type { LocalExportRecord, LocalExportStatus } from "@/lib/platform/types";
import type { LocalDb } from "./db/client";
import { exports as exportsTable, type ExportRow } from "./db/schema";
import { logger } from "./logger";

const KNOWN_STATUSES: LocalExportStatus[] = [
  "pending",
  "rendering",
  "ready",
  "failed",
  "canceled",
];

function normalizeStatus(raw: string): LocalExportStatus {
  return (KNOWN_STATUSES as string[]).includes(raw)
    ? (raw as LocalExportStatus)
    : "failed";
}

/** Row → the renderer-facing shape. Never includes `path`. */
export function toRecord(row: ExportRow): LocalExportRecord {
  let sizeBytes = row.sizeBytes;
  let fileExists = false;
  try {
    const stat = statSync(row.path);
    fileExists = stat.isFile();
    // Trust the disk over the stored number: the file may have been replaced.
    if (fileExists) sizeBytes = stat.size;
  } catch {
    fileExists = false;
  }
  return {
    outputId: row.id,
    projectId: row.projectId,
    fileName: row.fileName || basename(row.path),
    sizeBytes,
    encoder: row.encoder,
    status: normalizeStatus(row.status),
    createdAt: row.createdAt,
    fileExists,
    folderName: basename(dirname(row.path)),
  };
}

/**
 * Decide what an unfinished row REALLY is, now that the app has restarted.
 *
 * A render lives in one process. So a row still marked `pending` or `rendering`
 * at launch cannot be in flight — whatever was producing it is gone. The file on
 * disk settles it: present means the render finished (and something failed to
 * record that), absent means it never did.
 *
 * Pure, so the rule is testable without a database or a filesystem.
 */
export function resolveStaleStatus(
  status: LocalExportStatus,
  fileExists: boolean
): LocalExportStatus | null {
  if (status !== "pending" && status !== "rendering") return null;
  return fileExists ? "ready" : "failed";
}

export interface ExportsStore {
  list(): Promise<LocalExportRecord[]>;
  /** Absolute path for an id, or null when unknown. Main-process only. */
  pathFor(outputId: string): Promise<string | null>;
  remove(outputId: string, deleteFile: boolean): Promise<void>;
  /** Drop records whose file no longer exists. */
  purgeStale(): Promise<{ removed: number }>;
  /**
   * Settle rows left mid-render by a previous run. Called once at startup —
   * without it a finished export can sit on a spinner forever, which is exactly
   * what an un-executed status write left behind (see db/write.ts).
   */
  reconcileOnLaunch(): Promise<{ repaired: number }>;
}

export function createExportsStore(db: LocalDb): ExportsStore {
  const readRow = async (outputId: string): Promise<ExportRow | null> => {
    const rows = await db
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, outputId))
      .limit(1);
    return rows[0] ?? null;
  };

  return {
    async list() {
      const rows = await db
        .select()
        .from(exportsTable)
        .orderBy(desc(exportsTable.createdAt));
      // A row is created the moment the user picks a destination, so a save
      // dialog they abandoned mid-flow would otherwise show as a ghost export.
      return rows
        .map(toRecord)
        .filter((r) => r.status !== "pending" || r.fileExists);
    },

    async pathFor(outputId) {
      return (await readRow(outputId))?.path ?? null;
    },

    async remove(outputId, deleteFile) {
      const row = await readRow(outputId);
      if (!row) return;
      if (deleteFile) {
        try {
          await rm(row.path, { force: true });
        } catch (err) {
          // A locked or already-gone file must not block forgetting the record.
          logger.warn("could not delete export file", {
            outputId,
            error: (err as Error).message,
          });
        }
      }
      await db.delete(exportsTable).where(eq(exportsTable.id, outputId));
      logger.info("export record removed", { outputId, deletedFile: deleteFile });
    },

    async purgeStale() {
      const rows = await db.select().from(exportsTable);
      let removed = 0;
      for (const row of rows) {
        if (toRecord(row).fileExists) continue;
        await db.delete(exportsTable).where(eq(exportsTable.id, row.id));
        removed += 1;
      }
      if (removed) logger.info("stale export records purged", { removed });
      return { removed };
    },

    async reconcileOnLaunch() {
      const rows = await db.select().from(exportsTable);
      let repaired = 0;
      for (const row of rows) {
        const record = toRecord(row);
        const settled = resolveStaleStatus(record.status, record.fileExists);
        if (!settled) continue;
        await db
          .update(exportsTable)
          .set({
            status: settled,
            // The row's byte count was written before the render finished; the
            // file on disk is the only honest number.
            ...(settled === "ready" ? { sizeBytes: record.sizeBytes } : {}),
          })
          .where(eq(exportsTable.id, row.id));
        repaired += 1;
      }
      if (repaired) logger.info("unfinished export rows settled", { repaired });
      return { repaired };
    },
  };
}
