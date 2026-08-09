/**
 * Locally rendered exports on their way to the cloud record.
 *
 * THE ONE PROPERTY THAT MATTERS
 * -----------------------------
 * A retry must NEVER re-render. Rendering a 4K export is minutes of the user's
 * CPU (and, on a metered plan, one of their monthly exports); the upload is
 * seconds of network that fails for boring, transient reasons. Those two must
 * not share a failure domain.
 *
 * That is why this is a separate table keyed on `outputId` — the file already on
 * disk — carrying the `exportDocId` of the permit that was issued for it. A
 * failed upload leaves both in place, so resuming costs one HTTP request and
 * reuses the SAME permit rather than burning another one.
 *
 * THE LIFECYCLE
 * -------------
 *   pending    → render finished; a permit has not been requested yet
 *   permitting → asking the server for a permit (this is what spends quota)
 *   uploading  → bytes are moving to Storage
 *   patching   → bytes are up; the Firestore record is being completed
 *   done       → the cloud record says `ready`
 *   failed     → parked with a reason; the local file is untouched and playable
 *
 * `permitting` is its own state precisely because a permit is not free. Knowing
 * an export already HAS one is what stops a retry loop from consuming a user's
 * whole monthly allowance on a flaky connection.
 */
import { and, eq, inArray, lte } from "drizzle-orm";
import { decideRetry, rearm } from "@/lib/sync/backoff";
import type { LocalDb } from "./db/client";
import { exportUploads, exports as exportsTable } from "./db/schema";

export type ExportUploadState =
  | "pending"
  | "permitting"
  | "uploading"
  | "patching"
  | "done"
  | "failed";

export interface ExportUploadJob {
  outputId: string;
  projectId: string;
  ownerUid: string;
  /** Present once a permit has been issued — reuse it, never ask twice. */
  exportDocId: string | null;
  storagePath: string | null;
  attempts: number;
  lastError: string | null;
}

export interface ExportUploadsStore {
  /** Queue a finished local render for upload. Idempotent per `outputId`. */
  enqueue(args: { outputId: string; projectId: string; ownerUid: string; now: number }): Promise<void>;
  claim(ownerUid: string, now: number, limit?: number): Promise<ExportUploadJob[]>;
  /**
   * Record the permit BEFORE any bytes move, so a crash between "permit issued"
   * and "upload started" does not orphan the permit and spend another one on the
   * next attempt.
   */
  recordPermit(args: {
    outputId: string;
    exportDocId: string;
    storagePath: string;
    now: number;
  }): Promise<void>;
  advance(outputId: string, state: ExportUploadState, now: number): Promise<void>;
  complete(outputId: string, now: number): Promise<void>;
  fail(outputId: string, error: { message: string; code?: string }, now: number): Promise<void>;
  retry(outputId: string, now: number): Promise<void>;
  stateOf(outputId: string): Promise<ExportUploadState | null>;
  /** Everything not yet in the cloud, for the Exports screen. */
  pending(ownerUid: string): Promise<ExportUploadJob[]>;
}

export function createExportUploadsStore(db: LocalDb): ExportUploadsStore {
  const rowFor = async (outputId: string) => {
    const rows = await db
      .select()
      .from(exportUploads)
      .where(eq(exportUploads.outputId, outputId))
      .limit(1);
    return rows[0] ?? null;
  };

  const toJob = (r: typeof exportUploads.$inferSelect): ExportUploadJob => ({
    outputId: r.outputId,
    projectId: r.projectId,
    ownerUid: r.ownerUid,
    exportDocId: r.exportDocId,
    storagePath: r.storagePath,
    attempts: r.attempts,
    lastError: r.lastError,
  });

  return {
    async enqueue({ outputId, projectId, ownerUid, now }) {
      const existing = await rowFor(outputId);
      // Already known: a second call is a re-request, not a second upload. Its
      // permit (if any) is deliberately preserved.
      if (existing) {
        if (existing.state === "done") return;
        await db
          .update(exportUploads)
          .set({ state: "pending", nextAttemptAt: 0, updatedAt: now })
          .where(eq(exportUploads.outputId, outputId));
        return;
      }
      await db.insert(exportUploads).values({
        outputId,
        projectId,
        ownerUid,
        state: "pending",
        attempts: 0,
        nextAttemptAt: 0,
        updatedAt: now,
      });
    },

    async claim(ownerUid, now, limit = 1) {
      const due = await db
        .select()
        .from(exportUploads)
        .where(
          and(
            eq(exportUploads.ownerUid, ownerUid),
            eq(exportUploads.state, "pending"),
            lte(exportUploads.nextAttemptAt, now)
          )
        )
        .limit(limit);
      if (due.length === 0) return [];

      // Claimed rows move straight to `permitting`: the next thing the worker
      // does is either request a permit or, if one exists, skip to uploading.
      await db
        .update(exportUploads)
        .set({ state: "permitting", updatedAt: now })
        .where(inArray(exportUploads.outputId, due.map((r) => r.outputId)));
      return due.map(toJob);
    },

    async recordPermit({ outputId, exportDocId, storagePath, now }) {
      await db
        .update(exportUploads)
        .set({ exportDocId, storagePath, state: "uploading", updatedAt: now })
        .where(eq(exportUploads.outputId, outputId));
    },

    async advance(outputId, state, now) {
      await db
        .update(exportUploads)
        .set({ state, updatedAt: now })
        .where(eq(exportUploads.outputId, outputId));
    },

    async complete(outputId, now) {
      await db
        .update(exportUploads)
        .set({ state: "done", lastError: null, updatedAt: now })
        .where(eq(exportUploads.outputId, outputId));
      // The local record stays exactly as it was: the file is still on this
      // machine and still the thing "Reveal in folder" opens. Uploading is an
      // addition, not a migration.
      await db
        .update(exportsTable)
        .set({ status: "ready" })
        .where(eq(exportsTable.id, outputId));
    },

    async fail(outputId, error, now) {
      const row = await rowFor(outputId);
      if (!row) return;
      const decision = decideRetry({
        attempts: row.attempts,
        now,
        message: error.message,
        code: error.code,
      });
      await db
        .update(exportUploads)
        .set({
          state: decision.state === "failed" ? "failed" : "pending",
          attempts: decision.attempts,
          nextAttemptAt: decision.nextAttemptAt,
          lastError: decision.lastError,
          // `exportDocId` and `storagePath` are deliberately NOT cleared — they
          // are the permit this export already paid for.
          updatedAt: now,
        })
        .where(eq(exportUploads.outputId, outputId));
    },

    async retry(outputId, now) {
      const armed = rearm(now);
      await db
        .update(exportUploads)
        .set({
          state: "pending",
          attempts: armed.attempts,
          nextAttemptAt: armed.nextAttemptAt,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(exportUploads.outputId, outputId));
    },

    async stateOf(outputId) {
      const row = await rowFor(outputId);
      return (row?.state as ExportUploadState) ?? null;
    },

    async pending(ownerUid) {
      const rows = await db
        .select()
        .from(exportUploads)
        .where(eq(exportUploads.ownerUid, ownerUid));
      return rows.filter((r) => r.state !== "done").map(toJob);
    },
  };
}
