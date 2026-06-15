/**
 * GET /api/admin/errors?filter=all|analysis|export|client&limit=50
 *
 * Merged error feed from three sources:
 *   • failed analysisJobs       (collection group, status == "failed")
 *   • failed exports            (collection group, status == "failed")
 *   • "error_occurred" events   (analyticsEvents — client/runtime errors)
 *
 * Each source is fetched independently and degraded on error so one missing
 * index can't blank the feed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { requireAdmin } from "@/lib/admin/auth";
import { uidFromSubDoc } from "@/lib/admin/query";
import { tsToMillis } from "@/lib/admin/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface ErrorRow {
  kind: "analysis" | "export" | "client";
  uid: string;
  ref: string;
  message: string;
  errorKind: string | null;
  at: number;
  context: Record<string, unknown>;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { db } = getAdmin();
  const sp = req.nextUrl.searchParams;
  const filter = sp.get("filter") || "all";
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || DEFAULT_LIMIT));

  const wantAnalysis = filter === "all" || filter === "analysis";
  const wantExport = filter === "all" || filter === "export";
  const wantClient = filter === "all" || filter === "client";

  const rows: ErrorRow[] = [];

  if (wantAnalysis) {
    try {
      const snap = await db
        .collectionGroup("analysisJobs")
        .where("status", "==", "failed")
        .orderBy("startedAt", "desc")
        .limit(limit)
        .get();
      for (const d of snap.docs) {
        const data = d.data();
        rows.push({
          kind: "analysis",
          uid: uidFromSubDoc(d.ref),
          ref: (data.projectId as string) ?? d.id,
          message: (data.errorMessage as string) ?? "Analysis failed",
          errorKind: null,
          at: tsToMillis((data.completedAt ?? data.startedAt) as never),
          context: {
            projectTitle: data.projectTitle ?? null,
            engine: data.engine ?? null,
            chunkMode: data.chunkMode ?? null,
          },
        });
      }
    } catch (err) {
      console.error("[admin/errors] analysis source failed", err);
    }
  }

  if (wantExport) {
    try {
      const snap = await db
        .collectionGroup("exports")
        .where("status", "==", "failed")
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();
      for (const d of snap.docs) {
        const data = d.data();
        rows.push({
          kind: "export",
          uid: uidFromSubDoc(d.ref),
          ref: (data.projectId as string) ?? d.id,
          message: (data.errorMessage as string) ?? "Export failed",
          errorKind: null,
          at: tsToMillis((data.completedAt ?? data.createdAt) as never),
          context: {
            projectTitle: data.projectTitle ?? null,
            format: data.format ?? null,
            resolution: data.resolution ?? null,
          },
        });
      }
    } catch (err) {
      console.error("[admin/errors] export source failed", err);
    }
  }

  if (wantClient) {
    try {
      const snap = await db
        .collection("analyticsEvents")
        .where("eventName", "==", "error_occurred")
        .orderBy("timestamp", "desc")
        .limit(limit)
        .get();
      for (const d of snap.docs) {
        const data = d.data();
        const meta = (data.metadata as Record<string, unknown>) ?? {};
        rows.push({
          kind: "client",
          uid: (data.userId as string) ?? "",
          ref: (data.projectId as string) ?? "",
          message: (meta.message as string) ?? "Client error",
          errorKind: (meta.where as string) ?? null,
          at: tsToMillis(data.timestamp as never),
          context: meta,
        });
      }
    } catch (err) {
      console.error("[admin/errors] client source failed", err);
    }
  }

  rows.sort((a, b) => b.at - a.at);

  return NextResponse.json({ rows: rows.slice(0, limit) });
}
