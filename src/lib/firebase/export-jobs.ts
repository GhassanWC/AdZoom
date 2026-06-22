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
import type { ExportJobDoc, ExportUiStage } from "./schema";

/** The UI-facing view of an export job — everything except `renderRecipe`. */
export type ExportJobView = Omit<ExportJobDoc, "renderRecipe">;

/** Human labels for the friendly progress stages shown in the dialog. */
export const EXPORT_STAGE_LABEL: Record<ExportUiStage, string> = {
  queued: "Queued",
  preparing: "Preparing your video…",
  rendering: "Rendering",
  merging: "Merging",
  uploading: "Uploading",
  ready: "Ready",
};

/**
 * Friendly stage for the UI. Prefers the worker-written `progressStage`; falls
 * back to deriving it from `status` + the raw `stage` so older jobs still map
 * cleanly (and a job that's claimed/normalizing reads as "Preparing…", never a
 * frozen percentage).
 */
export function exportUiStage(
  job: Pick<ExportJobView, "status" | "stage" | "progressStage">
): ExportUiStage {
  if (job.progressStage) return job.progressStage;
  switch (job.status) {
    case "queued":
      return "queued";
    case "batch_submitted":
      // Batch task submitted; the container is provisioning. No render % yet, so
      // show the animated "Preparing…" rather than a frozen bar.
      return "preparing";
    case "uploading":
      return "uploading";
    case "ready":
    case "failed":
    case "canceled":
      return "ready";
    case "rendering":
    default:
      if (job.stage === "merging") return "merging";
      // download + normalize are the "preparing" phase (no real % yet) — show an
      // animated "Preparing…" rather than a stuck bar.
      return job.stage === "normalizing" ||
        job.stage === "downloading" ||
        job.stage === "queued" ||
        !job.stage
        ? "preparing"
        : "rendering";
  }
}

/** True while the UI should show an indeterminate (animated) bar — queued, the
 *  preparing phase, or merging, where the worker emits no real percentage yet. */
export function isIndeterminateStage(stage: ExportUiStage): boolean {
  return stage === "queued" || stage === "preparing" || stage === "merging";
}

/**
 * UI staleness window — slightly larger than the server reconciler's 10-min
 * threshold so the client only flags a job "stuck" after the server has had a
 * chance to fail it cleanly.
 */
export const STALE_UI_MS = 12 * 60_000;

const ACTIVE_FOR_STALE: ExportJobView["status"][] = [
  "queued",
  "batch_submitted",
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
  // Prefer the worker heartbeat (lastHeartbeatAt) — it's the truest liveness
  // signal; fall back to updatedAt for jobs/workers that don't write it yet.
  const beat = job.lastHeartbeatAt ?? job.updatedAt;
  return ACTIVE_FOR_STALE.includes(job.status) && now - beat > STALE_UI_MS;
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
    progressStage: data.progressStage as ExportJobDoc["progressStage"],
    errorMessage: data.errorMessage as string | undefined,
    errorCode: data.errorCode as string | undefined,
    cancelRequested: data.cancelRequested as boolean | undefined,
    warnings: data.warnings as string[] | undefined,
    workerId: data.workerId as string | undefined,
    claimedAt: millis(data.claimedAt) ?? (data.claimedAt as number | undefined),
    lastHeartbeatAt: millis(data.lastHeartbeatAt) ?? (data.lastHeartbeatAt as number | undefined),
    queuePosition: data.queuePosition as number | undefined,
    exportPath: (data.exportPath as "cloud" | "browser" | undefined) ?? "cloud",
    settingsHash: data.settingsHash as string | undefined,
    buildVersion: data.buildVersion as string | undefined,
    batchJobId: data.batchJobId as string | undefined,
    batchJobName: data.batchJobName as string | undefined,
    batchSubmittedAt: millis(data.batchSubmittedAt) ?? (data.batchSubmittedAt as number | undefined),
    chunkIndex: data.chunkIndex as number | undefined,
    chunkTotal: data.chunkTotal as number | undefined,
    monthlyBucket: (data.monthlyBucket as string) ?? "",
    createdAt: millis(data.createdAt) ?? Date.now(),
    updatedAt: millis(data.updatedAt) ?? Date.now(),
    startedAt: millis(data.startedAt),
    completedAt: millis(data.completedAt),
    failedAt: millis(data.failedAt),
    canceledAt: millis(data.canceledAt),
  };
}

/** Statuses that count as an active (in-flight) export — the dedup + single-flight
 *  set. `batch_submitted` is the Batch provisioning state; `claimed`/`normalizing`
 *  are sub-stages of `rendering`, so they're covered. */
export const EXPORT_ACTIVE_STATUSES: ExportJobView["status"][] = [
  "queued",
  "batch_submitted",
  "rendering",
  "uploading",
];

export function isActiveJob(job: Pick<ExportJobView, "status">): boolean {
  return EXPORT_ACTIVE_STATUSES.includes(job.status);
}

/** Display progress 0..100 from the stored 0..1 `progress`. */
export function progressPercent(job: Pick<ExportJobView, "progress">): number {
  return Math.round((job.progress ?? 0) * 100);
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
