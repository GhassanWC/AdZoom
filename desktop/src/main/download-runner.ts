/**
 * The half of "load my previous work" that touches the network and the disk.
 *
 * WHY THIS ONE RUNS IN MAIN AND THE UPLOAD RUNS IN THE RENDERER
 * ------------------------------------------------------------
 * Every other piece of sync deliberately puts the network in the renderer,
 * because that is where the authenticated Firebase session lives. A download
 * needs no session: `originalVideoUrl` is a Firebase download URL and carries
 * its own access token. So the choice is free, and streaming a multi-gigabyte
 * body straight to disk in Node beats marshalling it through IPC in chunks by
 * every measure that matters — memory, copies, and how much code has to be
 * right.
 *
 * The renderer never supplies the URL. `MediaDownloadsStore.claim` reads it from
 * the project's own document, so there is no channel through which a compromised
 * renderer could ask this process to fetch an arbitrary host.
 *
 * RESUME
 * ------
 * A partial file is kept and continued with a Range request. Losing 3 GB of
 * progress to a dropped Wi-Fi connection is the difference between a feature
 * people use and one they try once. The server having ignored the Range header
 * is detected (200 instead of 206) and restarts cleanly rather than appending
 * the whole body onto the partial one.
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "./logger";
import type { MediaDownloadsStore } from "./media-downloads";
import type { MediaStore } from "./media";

/** How often progress reaches the database and the UI. */
const PROGRESS_INTERVAL_MS = 400;

export interface DownloadProgressEvent {
  projectId: string;
  bytesReceived: number;
  bytesTotal: number;
}

export interface DownloadRunnerOptions {
  store: MediaDownloadsStore;
  mediaStore: MediaStore;
  /** Where partial and finished downloads live. Created on demand. */
  downloadsDir: string;
  onProgress?: (event: DownloadProgressEvent) => void;
  /** May be async; the runner does not wait for it before taking the next job. */
  onSettled?: (event: {
    projectId: string;
    ok: boolean;
    error?: string;
  }) => void | Promise<void>;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface DownloadRunner {
  /** Run every queued download for this account. Safe to call concurrently. */
  drain(ownerUid: string): Promise<void>;
  /** Stop an in-flight download. The partial file is kept for a later resume. */
  cancel(projectId: string): void;
  isRunning(projectId: string): boolean;
}

export function createDownloadRunner(options: DownloadRunnerOptions): DownloadRunner {
  const { store, mediaStore, downloadsDir } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());

  const inFlight = new Map<string, AbortController>();
  /** Serialises drains per account: two would claim each other's work. */
  const draining = new Map<string, Promise<void>>();

  const runOne = async (job: {
    projectId: string;
    sourceUrl: string;
    fileName: string;
  }): Promise<"done" | "failed" | "cancelled"> => {
    const controller = new AbortController();
    inFlight.set(job.projectId, controller);
    // `.part` is never probed and never attached — it exists so a resumed
    // download has somewhere to continue from, and so a partial file can never
    // be mistaken for a finished video by anything that scans the folder.
    const partPath = join(downloadsDir, `${job.projectId}.part`);
    const finalPath = join(downloadsDir, `${job.projectId} ${job.fileName}`);

    try {
      await mkdir(downloadsDir, { recursive: true });
      const from = await sizeOf(partPath);

      const response = await doFetch(job.sourceUrl, {
        signal: controller.signal,
        headers: from > 0 ? { Range: `bytes=${from}-` } : undefined,
      });
      if (!response.ok) {
        // 416 means the partial file is already the whole thing (or the object
        // shrank). Either way the range is meaningless — start over.
        if (response.status === 416) {
          await rm(partPath, { force: true });
          throw new Error("The download restarted. Please try again.");
        }
        throw new Error(describeHttp(response.status));
      }
      if (!response.body) throw new Error("The server sent no video data.");

      // A server that ignored the Range header sends 200 with the WHOLE body.
      // Appending that to the partial file would silently produce a corrupt
      // video that still probes, which is the worst possible outcome.
      const resumed = from > 0 && response.status === 206;
      const startAt = resumed ? from : 0;
      const bytesTotal = startAt + contentLength(response);

      let received = startAt;
      let lastReport = 0;
      const report = (force = false) => {
        const at = now();
        if (!force && at - lastReport < PROGRESS_INTERVAL_MS) return;
        lastReport = at;
        void store.progress(job.projectId, received, bytesTotal, at).catch(() => undefined);
        options.onProgress?.({ projectId: job.projectId, bytesReceived: received, bytesTotal });
      };
      report(true);

      const sink = createWriteStream(partPath, { flags: resumed ? "a" : "w" });
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      source.on("data", (chunk: Buffer) => {
        received += chunk.length;
        report();
      });
      await pipeline(source, sink);
      report(true);

      // Only now is there a whole file. Name it, probe it, and let the media
      // store decide whether it is really a video — a truncated body that
      // arrived without an error still fails here, which is the point.
      await rm(finalPath, { force: true });
      await rename(partPath, finalPath);
      const media = await mediaStore.adopt(finalPath);
      await store.complete({ projectId: job.projectId, mediaId: media.id, now: now() });

      logger.info("cloud video downloaded", {
        projectId: job.projectId,
        mediaId: media.id,
        sizeBytes: media.sizeBytes,
      });
      void options.onSettled?.({ projectId: job.projectId, ok: true });
      return "done";
    } catch (err) {
      const aborted = controller.signal.aborted;
      const message = aborted
        ? "Download paused."
        : err instanceof Error
          ? err.message
          : "The download failed.";
      // A cancelled download is NOT a failure: the partial file stays, no
      // attempt is spent, and pressing the button again resumes it.
      if (aborted) {
        await store.pause(job.projectId, now()).catch(() => undefined);
      } else {
        logger.warn("cloud video download failed", { projectId: job.projectId, message });
        await store.fail(job.projectId, { message }, now()).catch(() => undefined);
      }
      void options.onSettled?.({ projectId: job.projectId, ok: false, error: message });
      return aborted ? "cancelled" : "failed";
    } finally {
      inFlight.delete(job.projectId);
    }
  };

  const runDrain = async (ownerUid: string): Promise<void> => {
    // One job per pass, then look again: `claim` is what decides how many run
    // at once, and re-claiming keeps a queue of three moving without three
    // concurrent transfers fighting for the same connection.
    for (;;) {
      const jobs = await store.claim(ownerUid, now());
      if (jobs.length === 0) return;
      for (const job of jobs) {
        // A pause leaves the row due immediately, so it is claimable again the
        // instant this loop comes round — which would restart the very download
        // the user just stopped. Ending the pass is what makes cancel mean
        // cancel; `requestDownload` starts a new one when they ask.
        if ((await runOne(job)) === "cancelled") return;
      }
    }
  };

  return {
    drain(ownerUid) {
      const existing = draining.get(ownerUid);
      if (existing) return existing;
      const run = runDrain(ownerUid)
        .catch((err) => {
          logger.warn("download drain failed", {
            message: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          draining.delete(ownerUid);
        });
      draining.set(ownerUid, run);
      return run;
    },

    cancel(projectId) {
      inFlight.get(projectId)?.abort();
    },

    isRunning: (projectId) => inFlight.has(projectId),
  };
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function contentLength(response: Response): number {
  const raw = response.headers.get("content-length");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * HTTP status → something a user can act on.
 *
 * The raw status is in the log; what reaches the screen has to say whether this
 * is worth retrying, which "Request failed with status 403" does not.
 */
function describeHttp(status: number): string {
  if (status === 401 || status === 403) {
    return "Framevo isn't allowed to download this video. Try signing out and back in.";
  }
  if (status === 404) return "This video is no longer in the cloud.";
  if (status >= 500) return "The server is having trouble. Try again in a moment.";
  return "The video couldn't be downloaded.";
}
