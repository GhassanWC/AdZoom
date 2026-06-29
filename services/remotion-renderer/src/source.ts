/**
 * Resolve the job's source recording into an HTTP(S) URL for the Remotion
 * composition's `<OffthreadVideo src>`.
 *
 * CRITICAL: Remotion's compositor can ONLY fetch assets over http(s) — a
 * `file://` path (the old "download to /tmp" approach) makes renderMedia throw
 * `Can only download URLs starting with http:// or https://`. So the RENDER src
 * is ALWAYS a short-lived V4 signed HTTPS URL.
 *
 * Validation and the render-src path are deliberately SEPARATE: we first read
 * the object's metadata (proves it exists, is accessible to this SA, and is
 * non-empty) so a missing/empty source fails fast as `source_unavailable`
 * BEFORE the expensive render — then we mint the signed URL Remotion downloads.
 *
 * Signing note: on Cloud Run with ADC (no private key), `getSignedUrl` uses the
 * IAM `signBlob` API, so the runtime SA needs `roles/iam.serviceAccountTokenCreator`
 * on itself. If signing fails, we raise `SourceUnavailableError`.
 */
import { bucket } from "./firebase.js";
import { SourceUnavailableError } from "./errors.js";
import type { ExportJobDoc } from "@/lib/firebase/schema";

export interface ResolvedSource {
  /** HTTPS URL passed to `<OffthreadVideo src>`. NEVER a file:// path. */
  renderUrl: string;
  /** Source object size in bytes (0 if the metadata didn't report it). */
  bytes: number;
}

export interface ResolveSourceOpts {
  /** Lifetime of the signed render URL — must comfortably outlast the render
   *  (Remotion downloads the asset near the start, but be generous). */
  signedTtlMs: number;
  /** Hard cap on the metadata-read + URL-signing control-plane calls so a hung
   *  GCS API can't wedge the job before the render even starts. */
  resolveTimeoutMs: number;
  /** Aborts the resolve on cancel / the worker's hard timeout (the render's own
   *  cancelSignal can't reach this pre-render stage). */
  signal?: AbortSignal;
}

/** Bound a promise by a timeout + an optional abort signal. The underlying GCS
 *  call may keep running in the background, but the worker then fails + exits
 *  (process teardown), so the job can never hang here. */
function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${label} timed out after ${ms}ms`))),
      ms
    );
    const onAbort = () => finish(() => reject(new Error(`${label} aborted`)));
    if (signal) {
      if (signal.aborted) {
        finish(() => reject(new Error(`${label} aborted`)));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e))
    );
  });
}

export async function resolveSource(
  job: ExportJobDoc,
  opts: ResolveSourceOpts
): Promise<ResolvedSource> {
  const file = bucket().file(job.sourceStoragePath);

  // ── Validation path: object exists + readable by this SA + non-empty ──────
  let bytes = 0;
  try {
    const [meta] = await withDeadline(
      file.getMetadata(),
      opts.resolveTimeoutMs,
      opts.signal,
      "source metadata read"
    );
    bytes = Number((meta as { size?: number | string }).size ?? 0) || 0;
  } catch (err) {
    throw new SourceUnavailableError(
      `source metadata read failed for ${job.sourceStoragePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!(bytes > 0)) {
    throw new SourceUnavailableError(
      `source object ${job.sourceStoragePath} is empty or has no readable size`
    );
  }

  // ── Render-src path: short-lived signed HTTPS URL for <OffthreadVideo> ─────
  let renderUrl: string;
  try {
    const [url] = await withDeadline(
      file.getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + Math.max(60_000, opts.signedTtlMs),
      }),
      opts.resolveTimeoutMs,
      opts.signal,
      "source URL signing"
    );
    renderUrl = url;
  } catch (err) {
    throw new SourceUnavailableError(
      `failed to sign source URL for ${job.sourceStoragePath} (the renderer SA may lack iam.serviceAccountTokenCreator): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Hard guard: never hand a non-http(s) URL to the compositor.
  if (!/^https?:\/\//i.test(renderUrl)) {
    throw new SourceUnavailableError(
      `resolved render URL is not http(s): ${renderUrl.slice(0, 16)}…`
    );
  }

  return { renderUrl, bytes };
}
