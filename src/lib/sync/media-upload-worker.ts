"use client";

/**
 * The worker that puts a project's source video in the cloud.
 *
 * WHY IT LIVES IN THE RENDERER
 * ---------------------------
 * A Storage write needs the authenticated Firebase session, and that session is
 * here — main deliberately has no Firebase dependency at all. So main owns the
 * queue, the file and the checksums, and hands over one job at a time; this
 * file supplies nothing but the network.
 *
 * WHY THE BYTES ARE NOT SENT OVER IPC
 * -----------------------------------
 * The job carries a `framevo://app/__media/<id>` URL — the SAME same-origin URL
 * the editor plays the video from — so the renderer fetches the file through the
 * protocol handler rather than having gigabytes structured-cloned across the
 * bridge. `uploadBytesResumable` then slices the resulting Blob itself, so the
 * whole recording never has to be resident.
 *
 * THE VERIFICATION STEP IS NOT OPTIONAL
 * ------------------------------------
 * Main hashed the file BEFORE any bytes moved. After the upload, Storage reports
 * `md5Hash` for the object it actually stored, and the two are compared. Only
 * then is `completeUpload` called — which is the single moment a project's
 * document is repointed at the cloud copy. An upload that transferred without
 * error but arrived corrupt fails here, and the project keeps pointing at the
 * file on this disk.
 */
import { getDownloadURL, ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { getFirebase } from "@/lib/firebase/client";
import type { MediaTransferBridge, MediaUploadJobView } from "@/lib/platform/types";

/** Reported often enough to look alive, rarely enough not to flood IPC. */
const PROGRESS_INTERVAL_MS = 500;

export interface MediaUploadWorker {
  /** Upload everything queued for this account. Concurrent calls collapse. */
  drain(): Promise<void>;
  /** Abort whatever is in flight. The queue keeps the job for a later attempt. */
  stop(): void;
}

export interface MediaUploadWorkerOptions {
  bridge: MediaTransferBridge;
  ownerUid: string;
  /** Injected for tests; defaults to the browser's own fetch. */
  fetchImpl?: typeof fetch;
  onError?: (error: Error) => void;
  now?: () => number;
}

export function createMediaUploadWorker(
  options: MediaUploadWorkerOptions
): MediaUploadWorker {
  const { bridge, ownerUid } = options;
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? (() => Date.now());

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let cancelCurrent: (() => void) | null = null;

  const uploadOne = async (job: MediaUploadJobView): Promise<void> => {
    const { storage } = getFirebase();

    // Read through the media protocol: same origin, Range-capable, and the file
    // never passes through the main process's memory on its way out.
    const response = await doFetch(job.mediaUrl);
    if (!response.ok) throw new Error("Framevo couldn't read that video from disk.");
    const blob = await response.blob();

    const reference = storageRef(storage, job.storagePath);
    const task = uploadBytesResumable(reference, blob, {
      // A bare video type. The Storage rules require `video/*` (or
      // octet-stream), and a `codecs=` parameter — which MediaRecorder puts in
      // the type of a saved recording — makes the header unparseable for
      // downstream typed downloads.
      contentType: contentTypeFor(job.fileName, blob.type),
    });
    cancelCurrent = () => task.cancel();

    let lastReport = 0;
    await new Promise<void>((resolve, reject) => {
      task.on(
        "state_changed",
        (snapshot) => {
          const at = now();
          if (at - lastReport < PROGRESS_INTERVAL_MS) return;
          lastReport = at;
          void bridge.uploadProgress(job.mediaId, snapshot.bytesTransferred).catch(() => undefined);
        },
        (error) => reject(error),
        () => resolve()
      );
    });
    cancelCurrent = null;

    // What Storage says it stored, against what main hashed before sending.
    const stored = task.snapshot.metadata;
    const remoteMd5 = (stored as { md5Hash?: string }).md5Hash ?? null;
    if (job.checksumMd5 && remoteMd5 && remoteMd5 !== job.checksumMd5) {
      throw new Error("The uploaded video doesn't match the original. Please try again.");
    }
    if (typeof stored.size === "number" && job.bytesTotal && stored.size !== job.bytesTotal) {
      throw new Error("The upload was incomplete. Please try again.");
    }

    const downloadUrl = await getDownloadURL(reference);
    // The one call that repoints the project — and thence every other device —
    // at the cloud copy. Everything above exists so it only happens on a
    // verified object.
    await bridge.completeUpload({ mediaId: job.mediaId, downloadUrl });
  };

  const runDrain = async (): Promise<void> => {
    while (!stopped) {
      const jobs = await bridge.claimUpload(ownerUid);
      if (jobs.length === 0) return;
      for (const job of jobs) {
        if (stopped) return;
        try {
          await uploadOne(job);
        } catch (err) {
          const error = err as { message?: string; code?: string };
          const cancelled = error?.code === "storage/canceled";
          await bridge
            .failUpload(job.mediaId, {
              // A cancelled upload is reported plainly. It still costs an
              // attempt — unlike a paused download, there is no partial object
              // to resume from, so this genuinely is a fresh start next time.
              message: cancelled
                ? "Upload stopped."
                : (error?.message ?? "The upload failed."),
              code: error?.code,
            })
            .catch(() => undefined);
          if (!cancelled) options.onError?.(toError(err));
          if (cancelled) return;
        }
      }
    }
  };

  return {
    drain() {
      if (inFlight) return inFlight;
      stopped = false;
      inFlight = runDrain()
        .catch((err) => options.onError?.(toError(err)))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },

    stop() {
      stopped = true;
      cancelCurrent?.();
    },
  };
}

/**
 * A Content-Type Storage will accept and a downstream decoder can parse.
 *
 * The blob's own type is preferred when it is a plain `video/*`, but a saved
 * recording's type carries `;codecs=…`, and the extension is a better signal
 * than a header nobody downstream can read.
 */
export function contentTypeFor(fileName: string, blobType: string): string {
  const bare = blobType.split(";")[0]?.trim() ?? "";
  if (bare.startsWith("video/")) return bare;
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    default:
      // Accepted by the Storage rules, and honest about not knowing.
      return "application/octet-stream";
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
