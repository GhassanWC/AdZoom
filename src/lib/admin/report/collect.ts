import "server-only";

/**
 * Firestore → `ReportInput` for the admin PDF report.
 *
 * Each source is read ONCE with `scanWindow`, using exactly the query shapes
 * (collection-group + orderBy field + time encoding) the existing admin routes
 * already use, so the report needs no new composite index. Failures are not
 * filtered with `where(status == "failed")` (that would need extra indexes);
 * they are derived in memory from the same scans, which also keeps every
 * failure count consistent with its source total.
 */

import type { Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { scanWindow, uidFromSubDoc, type ScanResult } from "../scan";
import { safeCount } from "../query";
import { tsToMillis, tsToMillisOpt } from "../serialize";
import { mapSafe, str, strOrNull, num, numOrNull, bool, oneOf, plainObject } from "../validate";
import { PLAN_IDS, monthlyValue, type PlanId } from "../pricing";
import { normalizeBrowserStatus, normalizeCloudStatus, resolutionLabel } from "../export-status";
import type {
  EventMeta,
  ReportAnalysisJob,
  ReportEvent,
  ReportExport,
  ReportInput,
  ReportProject,
  ReportSubscription,
  ReportUser,
  SourceScan,
} from "./model";
import type { SubscriptionStatus } from "@/lib/firebase/schema";

const MAX_META_KEYS = 24;
const MAX_META_STRING = 240;

/** Keep scalar metadata only, bounded — free-form objects never reach the PDF. */
function scalarMeta(value: unknown): EventMeta {
  const out: EventMeta = {};
  let n = 0;
  for (const [k, v] of Object.entries(plainObject(value))) {
    if (n >= MAX_META_KEYS) break;
    if (typeof v === "string") out[k] = v.slice(0, MAX_META_STRING);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else continue;
    n += 1;
  }
  return out;
}

export async function collectReportInput(
  db: Firestore,
  opts: {
    fromMs: number;
    toMs: number;
    rangeKey: string;
    generatedBy: string;
    includeEmails: boolean;
    now?: number;
  }
): Promise<ReportInput> {
  const window = { fromMs: opts.fromMs, toMs: opts.toMs };

  const [
    userScan,
    projectScan,
    analysisScan,
    browserScan,
    cloudScan,
    eventScan,
    subScan,
    allTimeUsers,
    allTimeProjects,
    allTimeBrowser,
    allTimeCloud,
  ] = await Promise.all([
    scanWindow({
      query: db.collection("users"),
      orderField: "createdAt",
      encoding: "timestamp",
      label: "report:users",
    }),
    scanWindow({
      query: db
        .collectionGroup("projects")
        .select("title", "status", "createdAt", "updatedAt", "duration", "fileSize", "mimeType", "analysis.status"),
      orderField: "createdAt",
      encoding: "timestamp",
      ...window,
      label: "report:projects",
    }),
    scanWindow({
      query: db.collectionGroup("analysisJobs"),
      orderField: "startedAt",
      encoding: "number", // Date.now(), not a Timestamp — see scan.ts
      ...window,
      label: "report:analysis",
    }),
    scanWindow({
      query: db.collectionGroup("exports"),
      orderField: "createdAt",
      encoding: "timestamp",
      ...window,
      label: "report:exports",
    }),
    scanWindow({
      query: db.collectionGroup("exportJobs"),
      orderField: "createdAt",
      encoding: "timestamp",
      ...window,
      label: "report:exportJobs",
    }),
    scanWindow({
      query: db.collection("analyticsEvents"),
      orderField: "timestamp",
      encoding: "timestamp",
      ...window,
      label: "report:events",
    }),
    scanWindow({
      query: db.collection("subscriptions"),
      orderField: "updatedAt",
      encoding: "number",
      label: "report:subscriptions",
    }),
    safeCount(db.collection("users")),
    safeCount(db.collectionGroup("projects")),
    safeCount(db.collectionGroup("exports")),
    safeCount(db.collectionGroup("exportJobs")),
  ]);

  const scans: SourceScan[] = [];
  const track = <T>(
    source: string,
    scan: ScanResult,
    mapped: { rows: T[]; skipped: number }
  ): T[] => {
    scans.push({ source, scanned: scan.scanned, truncated: scan.truncated, skipped: mapped.skipped });
    return mapped.rows;
  };
  const map = <T>(scan: ScanResult, fn: (d: QueryDocumentSnapshot) => T, label: string) =>
    mapSafe(scan.docs, fn, label);

  const users = track<ReportUser>(
    "users (all time)",
    userScan,
    map(
      userScan,
      (d) => {
        const x = d.data();
        return {
          uid: d.id,
          email: strOrNull(x.email),
          displayName: strOrNull(x.displayName),
          plan: oneOf<PlanId>(x.plan, PLAN_IDS, "free"),
          createdAt: tsToMillis(x.createdAt as never),
          updatedAt: tsToMillis(x.updatedAt as never),
        };
      },
      "report:users"
    )
  );

  const projects = track<ReportProject>(
    "projects",
    projectScan,
    map(
      projectScan,
      (d) => {
        const x = d.data();
        const analysis = plainObject(x.analysis);
        return {
          id: d.id,
          uid: uidFromSubDoc(d.ref),
          title: str(x.title, "Untitled"),
          status: str(x.status, "uploaded"),
          analysisStatus: typeof analysis.status === "string" ? analysis.status : null,
          duration: numOrNull(x.duration),
          fileSize: numOrNull(x.fileSize),
          mimeType: strOrNull(x.mimeType),
          createdAt: tsToMillis(x.createdAt as never),
          updatedAt: tsToMillis(x.updatedAt as never),
        };
      },
      "report:projects"
    )
  );

  const analysisJobs = track<ReportAnalysisJob>(
    "analysisJobs (chunked, >90s videos)",
    analysisScan,
    map(
      analysisScan,
      (d) => {
        const x = d.data();
        return {
          id: d.id,
          uid: uidFromSubDoc(d.ref),
          projectId: str(x.projectId),
          projectTitle: str(x.projectTitle, "Untitled"),
          status: str(x.status, "queued"),
          engine: str(x.engine, "unknown"),
          chunkMode: str(x.chunkMode, "unknown"),
          chunkCount: num(x.chunkCount),
          failedChunks: num(x.failedCount),
          videoSeconds: num(x.duration),
          startedAt: tsToMillis(x.startedAt as never),
          completedAt: tsToMillis(x.completedAt as never) || null,
          errorMessage: strOrNull(x.errorMessage),
        };
      },
      "report:analysis"
    )
  );

  const browserExports = track<ReportExport>(
    "exports (browser)",
    browserScan,
    map(
      browserScan,
      (d) => {
        const x = d.data();
        const rawStatus = str(x.status, "queued");
        return {
          id: d.id,
          uid: uidFromSubDoc(d.ref),
          pipeline: "browser" as const,
          projectId: str(x.projectId),
          projectTitle: str(x.projectTitle, "Untitled"),
          format: str(x.format, "unknown"),
          resolution: str(x.resolution, "unknown"),
          status: normalizeBrowserStatus(rawStatus),
          rawStatus,
          stage: null,
          watermarked: bool(x.applyWatermark),
          fileSize: numOrNull(x.fileSize),
          errorMessage: strOrNull(x.errorMessage),
          errorCode: null,
          exportMinutes: null,
          plan: null,
          backend: null,
          createdAt: tsToMillis(x.createdAt as never),
          completedAt: tsToMillis(x.completedAt as never) || null,
        };
      },
      "report:exports"
    )
  );

  const cloudExports = track<ReportExport>(
    "exportJobs (cloud)",
    cloudScan,
    map(
      cloudScan,
      (d) => {
        const x = d.data();
        const rawStatus = str(x.status, "queued");
        return {
          id: d.id,
          uid: uidFromSubDoc(d.ref) || str(x.userId),
          pipeline: "cloud" as const,
          projectId: str(x.projectId),
          projectTitle: str(x.projectTitle, "Untitled"),
          format: str(x.format, "mp4"),
          resolution: resolutionLabel(num(x.outputHeight)),
          status: normalizeCloudStatus(rawStatus),
          rawStatus,
          stage: strOrNull(x.stage),
          watermarked: false,
          fileSize: numOrNull(x.outputSizeBytes),
          errorMessage: strOrNull(x.errorMessage),
          errorCode: strOrNull(x.errorCode),
          exportMinutes: numOrNull(x.consumedExportMinutes) ?? numOrNull(x.estimatedExportMinutes),
          plan: strOrNull(x.planAtExport) ?? strOrNull(x.plan),
          backend: strOrNull(x.backend),
          createdAt: tsToMillis(x.createdAt as never),
          completedAt: tsToMillis(x.readyAt as never) || tsToMillis(x.updatedAt as never) || null,
        };
      },
      "report:exportJobs"
    )
  );

  const events = track<ReportEvent>(
    "analyticsEvents (all environments)",
    eventScan,
    map(
      eventScan,
      (d) => {
        const x = d.data();
        return {
          name: str(x.eventName, "unknown"),
          userId: str(x.userId),
          plan: strOrNull(x.plan),
          environment: str(x.environment, "unknown"),
          projectId: strOrNull(x.projectId),
          timestamp: tsToMillis(x.timestamp as never),
          meta: scalarMeta(x.metadata),
        };
      },
      "report:events"
    )
  );

  const subscriptions = track<ReportSubscription>(
    "subscriptions (all time)",
    subScan,
    map(
      subScan,
      (d) => {
        const x = d.data();
        const plan = oneOf<PlanId>(x.plan, PLAN_IDS, "free");
        const status = str(x.status, "expired") as SubscriptionStatus;
        return {
          uid: d.id,
          plan,
          status,
          monthlyUsd: monthlyValue(plan, status),
          renewsAt: tsToMillisOpt(x.renewsAt as never) ?? null,
          endsAt: tsToMillisOpt(x.endsAt as never) ?? null,
          lastPaymentAt: tsToMillisOpt(x.lastPaymentAt as never) ?? null,
          createdAt: tsToMillis(x.createdAt as never),
          updatedAt: tsToMillis(x.updatedAt as never),
        };
      },
      "report:subscriptions"
    )
  );

  return {
    users,
    projects,
    analysisJobs,
    exports: [...browserExports, ...cloudExports].sort((a, b) => b.createdAt - a.createdAt),
    events,
    subscriptions,
    allTime: {
      users: allTimeUsers,
      projects: allTimeProjects,
      exports:
        allTimeBrowser == null && allTimeCloud == null ? null : (allTimeBrowser ?? 0) + (allTimeCloud ?? 0),
    },
    scans,
    window: { fromMs: opts.fromMs, toMs: opts.toMs, rangeKey: opts.rangeKey },
    now: opts.now ?? Date.now(),
    generatedBy: opts.generatedBy,
    includeEmails: opts.includeEmails,
  };
}
