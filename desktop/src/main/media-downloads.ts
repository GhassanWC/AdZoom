/**
 * A project's source video coming DOWN from the cloud onto this machine.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Project documents sync on their own — a project edited on the web shows up in
 * the desktop library within a second, because it is kilobytes. Its VIDEO does
 * not, because it is gigabytes. So a cloud project on a fresh machine is a real
 * timeline pointing at a URL: it opens, it plays over the network, and it cannot
 * be edited on a train.
 *
 * "Load my previous work" is this file: fetch that video onto the disk, probe
 * it, and attach it to the project as ordinary library media. Afterwards the
 * project is indistinguishable from one imported here in the first place.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD
 * --------------------------------------
 * A download attaches to the project ONLY after the whole file has arrived and
 * FFprobe has agreed it is a video. Until then the project keeps pointing at the
 * cloud URL. A truncated file can therefore never become a project's source —
 * the same rule `media-uploads.ts` holds in the other direction, for the same
 * reason: a half-transferred video that LOOKS attached is worse than no
 * download at all.
 *
 * `doc.originalVideoUrl` IS NEVER REWRITTEN HERE
 * ----------------------------------------------
 * That field is the CLOUD copy and it syncs. Pointing it at `framevo://` would
 * push a URL that means nothing to any other device — the web app would show a
 * broken project the moment this machine synced. The local copy is recorded in
 * the `projects.media_id` COLUMN instead, and `library.get`/`list` prefer it at
 * read time. One field for what the account owns, one column for what this disk
 * owns; see the note in library.ts.
 */
import { and, eq, inArray, lte } from "drizzle-orm";
import { decideRetry, rearm } from "@/lib/sync/backoff";
import type { LocalDb } from "./db/client";
import { mediaDownloads, projects } from "./db/schema";

/**
 * pending     — queued; waiting for a worker.
 * downloading — bytes are moving.
 * done        — verified, probed, and attached to the project.
 * failed      — parked with a reason; the project still plays from the cloud.
 */
export type MediaDownloadState = "pending" | "downloading" | "done" | "failed";

export interface MediaDownloadJob {
  projectId: string;
  ownerUid: string;
  /** The https download URL taken from the project document. */
  sourceUrl: string;
  fileName: string;
  attempts: number;
}

/** What the UI renders for one project's download. */
export interface MediaDownloadSnapshot {
  projectId: string;
  state: MediaDownloadState;
  bytesReceived: number;
  bytesTotal: number;
  lastError?: string;
}

export interface MediaDownloadsStore {
  /**
   * Ask for a project's cloud video. Idempotent — asking twice does not queue
   * twice, and asking for something already on this disk does nothing.
   *
   * The URL is read from the project's OWN document here rather than accepted
   * from the caller. That is deliberate: the renderer can then never name an
   * arbitrary host for the main process to fetch.
   */
  request(args: {
    projectId: string;
    ownerUid: string;
    now: number;
  }): Promise<{ queued: boolean; reason?: string }>;
  claim(ownerUid: string, now: number, limit?: number): Promise<MediaDownloadJob[]>;
  progress(projectId: string, bytesReceived: number, bytesTotal: number, now: number): Promise<void>;
  /**
   * The file is on disk, probed, and in the media table. Attaches it to the
   * project — the only place that ever happens.
   */
  complete(args: { projectId: string; mediaId: string; now: number }): Promise<void>;
  fail(projectId: string, error: { message: string; code?: string }, now: number): Promise<void>;
  /**
   * The user stopped it. NOT a failure: no attempt is spent, no backoff is
   * scheduled, and the partial file stays. Running `decideRetry` here instead
   * would punish someone for pausing — eight pauses and the download parks
   * itself as broken.
   */
  pause(projectId: string, now: number): Promise<void>;
  retry(projectId: string, now: number): Promise<void>;
  stateFor(projectId: string): Promise<MediaDownloadSnapshot | null>;
  /** Every download this account has a record of, for the library view. */
  list(ownerUid: string): Promise<MediaDownloadSnapshot[]>;
}

/** Only a real https URL can be downloaded — never file://, never a custom scheme. */
export function isDownloadableUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A file name for the downloaded video.
 *
 * Derived from the project title rather than the storage path, because the
 * storage path is a sanitised token the user has never seen and the Downloads
 * folder is somewhere they might actually look. Everything unsafe is stripped;
 * the extension is taken from the URL only when it is one we accept.
 */
export function downloadFileName(title: string, sourceUrl: string): string {
  // Separators are the part that matters: with `/` and `\` gone there is no
  // traversal left to perform. Runs of dots are collapsed and leading ones
  // dropped anyway — a file called `.. .. etc passwd` is legal and reads like
  // an exploit, and nobody should have to work out whether it is one.
  const stem =
    title
      .replace(/[^\w \-.]+/g, " ")
      .replace(/\.{2,}/g, ".")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[.\s]+/, "")
      .trim()
      .slice(0, 60) || "Project";
  let ext = ".mp4";
  try {
    const path = decodeURIComponent(new URL(sourceUrl).pathname);
    const match = /\.(mp4|mov|webm|mkv|m4v)$/i.exec(path);
    if (match) ext = match[0].toLowerCase();
  } catch {
    // Keep the default. A URL we cannot parse is not a URL we will fetch either.
  }
  return `${stem}${ext}`;
}

export function createMediaDownloadsStore(db: LocalDb): MediaDownloadsStore {
  return {
    async request({ projectId, ownerUid, now }) {
      const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      const project = rows[0];
      if (!project) return { queued: false, reason: "That project is not in this library." };
      if (project.mediaId) {
        return { queued: false, reason: "This project's video is already on this computer." };
      }

      const sourceUrl = (project.doc as { originalVideoUrl?: unknown }).originalVideoUrl;
      if (!isDownloadableUrl(sourceUrl)) {
        // A project whose video was never uploaded. Not an error — there is
        // simply nothing in the cloud to fetch, and saying so is more useful
        // than a failed download.
        return {
          queued: false,
          reason: "This project's video hasn't been uploaded to the cloud yet.",
        };
      }

      const existing = (
        await db
          .select()
          .from(mediaDownloads)
          .where(eq(mediaDownloads.projectId, projectId))
          .limit(1)
      )[0];
      if (existing?.state === "downloading") return { queued: false, reason: "Already in progress." };

      const values = {
        projectId,
        ownerUid,
        state: "pending" as const,
        mediaId: null,
        fileName: downloadFileName(project.title, sourceUrl),
        bytesTotal: 0,
        bytesReceived: 0,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        updatedAt: now,
      };
      if (existing) {
        await db
          .update(mediaDownloads)
          .set(values)
          .where(eq(mediaDownloads.projectId, projectId));
      } else {
        await db.insert(mediaDownloads).values(values);
      }
      return { queued: true };
    },

    async claim(ownerUid, now, limit = 1) {
      // ONE at a time by default, for the same reason uploads are: two
      // concurrent multi-gigabyte transfers on a home connection make both
      // slower and neither finish.
      const due = await db
        .select()
        .from(mediaDownloads)
        .where(
          and(
            eq(mediaDownloads.ownerUid, ownerUid),
            eq(mediaDownloads.state, "pending"),
            lte(mediaDownloads.nextAttemptAt, now)
          )
        )
        .limit(limit);
      if (due.length === 0) return [];

      // The URL is re-read from the document at claim time, not stored on the
      // row: a project re-uploaded in the meantime has a new URL, and a stale
      // one would 404 for reasons no user could act on.
      const ids = due.map((r) => r.projectId);
      const docs = await db
        .select({ id: projects.id, doc: projects.doc })
        .from(projects)
        .where(inArray(projects.id, ids));
      const urlById = new Map(
        docs.map((p) => [p.id, (p.doc as { originalVideoUrl?: unknown }).originalVideoUrl])
      );

      await db
        .update(mediaDownloads)
        .set({ state: "downloading", updatedAt: now })
        .where(inArray(mediaDownloads.projectId, ids));

      const jobs: MediaDownloadJob[] = [];
      for (const row of due) {
        const url = urlById.get(row.projectId);
        if (!isDownloadableUrl(url)) {
          await this.fail(
            row.projectId,
            { message: "This project no longer has a video in the cloud." },
            now
          );
          continue;
        }
        jobs.push({
          projectId: row.projectId,
          ownerUid: row.ownerUid,
          sourceUrl: url,
          fileName: row.fileName,
          attempts: row.attempts,
        });
      }
      return jobs;
    },

    async progress(projectId, bytesReceived, bytesTotal, now) {
      await db
        .update(mediaDownloads)
        .set({ bytesReceived, bytesTotal, updatedAt: now })
        .where(eq(mediaDownloads.projectId, projectId));
    },

    async complete({ projectId, mediaId, now }) {
      const rows = await db
        .select()
        .from(mediaDownloads)
        .where(eq(mediaDownloads.projectId, projectId))
        .limit(1);
      const row = rows[0];
      if (!row) return;

      await db
        .update(mediaDownloads)
        .set({
          state: "done",
          mediaId,
          bytesReceived: row.bytesTotal || row.bytesReceived,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(mediaDownloads.projectId, projectId));

      // THE attach. Everything above exists so this happens exactly once, on a
      // complete and probed file.
      //
      // Note what is NOT touched: `doc`. The document keeps pointing at the
      // cloud copy, which is what every other device needs it to say; this
      // machine simply prefers its own copy when reading (see library.ts).
      await db.update(projects).set({ mediaId }).where(eq(projects.id, projectId));
    },

    async fail(projectId, error, now) {
      const rows = await db
        .select()
        .from(mediaDownloads)
        .where(eq(mediaDownloads.projectId, projectId))
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
        .update(mediaDownloads)
        .set({
          // A rescheduled download returns to `pending`; a parked one is `failed`.
          state: decision.state === "failed" ? "failed" : "pending",
          attempts: decision.attempts,
          nextAttemptAt: decision.nextAttemptAt,
          lastError: decision.lastError,
          updatedAt: now,
        })
        .where(eq(mediaDownloads.projectId, projectId));
    },

    async pause(projectId, now) {
      await db
        .update(mediaDownloads)
        .set({ state: "pending", nextAttemptAt: now, lastError: null, updatedAt: now })
        .where(eq(mediaDownloads.projectId, projectId));
    },

    async retry(projectId, now) {
      const armed = rearm(now);
      await db
        .update(mediaDownloads)
        .set({
          state: "pending",
          attempts: armed.attempts,
          nextAttemptAt: armed.nextAttemptAt,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(mediaDownloads.projectId, projectId));
    },

    async stateFor(projectId) {
      const rows = await db
        .select()
        .from(mediaDownloads)
        .where(eq(mediaDownloads.projectId, projectId))
        .limit(1);
      const row = rows[0];
      return row ? toSnapshot(row) : null;
    },

    async list(ownerUid) {
      const rows = await db
        .select()
        .from(mediaDownloads)
        .where(eq(mediaDownloads.ownerUid, ownerUid));
      return rows.map(toSnapshot);
    },
  };
}

function toSnapshot(row: {
  projectId: string;
  state: string;
  bytesReceived: number;
  bytesTotal: number;
  lastError: string | null;
}): MediaDownloadSnapshot {
  return {
    projectId: row.projectId,
    state: row.state as MediaDownloadState,
    bytesReceived: row.bytesReceived,
    bytesTotal: row.bytesTotal,
    lastError: row.lastError ?? undefined,
  };
}
