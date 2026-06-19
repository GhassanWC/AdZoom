/**
 * Live subscription helpers for the user's cloud export jobs collection
 * (`users/{uid}/exportJobs`). Same shape as `subscribeExports` in `exports.ts`
 * (the browser/Free path) — the Exports page subscribes to BOTH and merges them
 * so cloud + browser exports appear in one list without coupling their
 * Firestore contracts.
 *
 * Materialising the Firestore doc into a typed `ExportJobDoc` happens here so
 * consumers don't reimplement the timestamp dance. The heavy `renderRecipe`
 * field is intentionally dropped from the materialised shape — the UI never
 * needs it, only the worker does.
 */
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebase } from "./client";
import type { ExportJobDoc } from "./schema";

/** The UI-facing view of an export job — everything except `renderRecipe`. */
export type ExportJobView = Omit<ExportJobDoc, "renderRecipe">;

/**
 * UI staleness window — slightly larger than the server reconciler's 10-min
 * threshold so the client only flags a job "stuck" after the server has had a
 * chance to fail it cleanly.
 */
export const STALE_UI_MS = 12 * 60_000;

const ACTIVE_FOR_STALE: ExportJobView["status"][] = [
  "queued",
  "rendering",
  "uploading",
];

/**
 * Derived (never stored): an active job whose last update is older than the
 * staleness window — the worker most likely died, so the UI should stop showing
 * a frozen "Rendering 0%" and offer a retry. Re-evaluate on a timer, since
 * `updatedAt` stops changing once the worker is gone.
 */
export function isJobStale(job: ExportJobView, now: number = Date.now()): boolean {
  return ACTIVE_FOR_STALE.includes(job.status) && now - job.updatedAt > STALE_UI_MS;
}

function millis(v: unknown): number | undefined {
  const t = v as { toMillis?: () => number } | undefined;
  return t?.toMillis?.();
}

export function materializeExportJob(
  id: string,
  data: Record<string, unknown>
): ExportJobView {
  return {
    id,
    userId: (data.userId as string) ?? "",
    projectId: (data.projectId as string) ?? "",
    projectTitle: (data.projectTitle as string) ?? "Untitled",
    status: (data.status as ExportJobDoc["status"]) ?? "queued",
    plan: (data.plan as ExportJobDoc["plan"]) ?? "pro",
    priority: (data.priority as ExportJobDoc["priority"]) ?? "normal",
    sourceStoragePath: (data.sourceStoragePath as string) ?? "",
    outputPath: (data.outputPath as string) ?? "",
    downloadUrl: data.downloadUrl as string | undefined,
    format: "mp4",
    outputWidth: (data.outputWidth as number) ?? 0,
    outputHeight: (data.outputHeight as number) ?? 0,
    fps: (data.fps as ExportJobDoc["fps"]) ?? 30,
    durationSeconds: (data.durationSeconds as number) ?? 0,
    estimatedExportMinutes: (data.estimatedExportMinutes as number) ?? 0,
    consumedExportMinutes: data.consumedExportMinutes as number | undefined,
    progress: (data.progress as number) ?? 0,
    stage: data.stage as ExportJobDoc["stage"],
    errorMessage: data.errorMessage as string | undefined,
    errorCode: data.errorCode as string | undefined,
    cancelRequested: data.cancelRequested as boolean | undefined,
    warnings: data.warnings as string[] | undefined,
    monthlyBucket: (data.monthlyBucket as string) ?? "",
    createdAt: millis(data.createdAt) ?? Date.now(),
    updatedAt: millis(data.updatedAt) ?? Date.now(),
    startedAt: millis(data.startedAt),
    completedAt: millis(data.completedAt),
    canceledAt: millis(data.canceledAt),
  };
}

export function subscribeExportJobs(
  uid: string,
  onChange: (jobs: ExportJobView[]) => void
): Unsubscribe {
  const { db } = getFirebase();
  const q = query(
    collection(db, "users", uid, "exportJobs"),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => materializeExportJob(d.id, d.data())));
  });
}

/** Subscribe to a single export job doc (drives the live in-editor status). */
export function subscribeExportJob(
  uid: string,
  jobId: string,
  onChange: (job: ExportJobView | null) => void
): Unsubscribe {
  const { db } = getFirebase();
  return onSnapshot(doc(db, "users", uid, "exportJobs", jobId), (snap) => {
    onChange(snap.exists() ? materializeExportJob(snap.id, snap.data()) : null);
  });
}
