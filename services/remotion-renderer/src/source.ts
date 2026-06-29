/**
 * Make the job's source recording available to `<OffthreadVideo src>`.
 *
 * Default ("download"): pull the object from GCS (ADC, no signing needed) to a
 * local file and pass a `file://` URL — most reliable for renderMedia (no
 * signed-URL expiry, no network mid-render). Set REMOTION_SOURCE_MODE=signed to
 * instead pass a short-lived signed read URL (avoids the local copy; needs the SA
 * to have signing rights). Either way the worker authenticates via ADC.
 */
import { createWriteStream } from "node:fs";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { bucket } from "./firebase.js";
import type { ExportJobDoc } from "@/lib/firebase/schema";

export interface ResolvedSource {
  /** Value for `<OffthreadVideo src>`. */
  src: string;
  /** Local file path when downloaded (for cleanup); undefined in signed mode. */
  localPath?: string;
  bytes: number;
}

export interface ResolveSourceOpts {
  /** TTL for the signed URL in `signed` mode. */
  signedTtlMs: number;
  /** Hard cap on the download stage (download mode). */
  downloadTimeoutMs: number;
  /** Aborts an in-flight download on cancel OR the worker's hard timeout — the
   *  render `cancelSignal` can't reach this stage (renderMedia hasn't started),
   *  so without this a hung GCS read would wedge the job before any render. */
  signal?: AbortSignal;
}

export async function resolveSource(
  job: ExportJobDoc,
  workDir: string,
  opts: ResolveSourceOpts
): Promise<ResolvedSource> {
  const file = bucket().file(job.sourceStoragePath);
  if ((process.env.REMOTION_SOURCE_MODE || "download").toLowerCase() === "signed") {
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + Math.max(60_000, opts.signedTtlMs),
    });
    return { src: url, bytes: 0 };
  }
  const ext = extname(job.sourceStoragePath) || ".mp4";
  const localPath = join(workDir, `source${ext}`);

  // Stream the object to disk through `stream.pipeline`, bounded by an
  // AbortSignal that fires on the download timeout OR an external cancel/hard
  // timeout. On abort, pipeline destroys both streams and rejects (AbortError),
  // so the job FAILS instead of hanging forever. `file.download()` exposes no
  // such cancellation, which is why we drive the read stream ourselves.
  const timeout = AbortSignal.timeout(Math.max(1, opts.downloadTimeoutMs));
  const combined = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;
  try {
    await pipeline(file.createReadStream(), createWriteStream(localPath), { signal: combined });
  } catch (err) {
    // An abort (download timeout, or the worker's cancel / hard timeout) or a
    // stream/GCS read error — surface as a clear source-download failure. When a
    // cancel or hard timeout caused it, the worker's wasCanceled/timedOut flags
    // already win the classification, so this message only reaches the user for a
    // genuine download timeout or IO error (mapped to a friendly reason upstream).
    const e = err as { name?: string; code?: string; message?: string };
    const aborted = e?.name === "AbortError" || e?.code === "ABORT_ERR";
    throw new Error(
      `source download ${aborted ? "timed out" : "failed"}: ${e?.message ?? String(err)}`
    );
  }

  const [meta] = await file.getMetadata().catch(() => [{ size: 0 }] as const);
  const bytes = Number((meta as { size?: number | string }).size ?? 0) || 0;
  return { src: pathToFileURL(localPath).href, localPath, bytes };
}
