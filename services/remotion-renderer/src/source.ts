/**
 * Make the job's source recording available to `<OffthreadVideo src>`.
 *
 * Default ("download"): pull the object from GCS (ADC, no signing needed) to a
 * local file and pass a `file://` URL — most reliable for renderMedia (no
 * signed-URL expiry, no network mid-render). Set REMOTION_SOURCE_MODE=signed to
 * instead pass a short-lived signed read URL (avoids the local copy; needs the SA
 * to have signing rights). Either way the worker authenticates via ADC.
 */
import { join, extname } from "node:path";
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

export async function resolveSource(
  job: ExportJobDoc,
  workDir: string,
  signedTtlMs: number
): Promise<ResolvedSource> {
  const file = bucket().file(job.sourceStoragePath);
  if ((process.env.REMOTION_SOURCE_MODE || "download").toLowerCase() === "signed") {
    const [url] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + Math.max(60_000, signedTtlMs),
    });
    return { src: url, bytes: 0 };
  }
  const ext = extname(job.sourceStoragePath) || ".mp4";
  const localPath = join(workDir, `source${ext}`);
  await file.download({ destination: localPath });
  const [meta] = await file.getMetadata().catch(() => [{ size: 0 }] as const);
  const bytes = Number((meta as { size?: number | string }).size ?? 0) || 0;
  return { src: pathToFileURL(localPath).href, localPath, bytes };
}
