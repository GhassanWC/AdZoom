/**
 * GET /api/admin/errors
 *   ?kind=analysis|export|cloud-export&search=&range=&from=&to=&page=&pageSize=
 *
 * Unified failure feed across every pipeline that records failures.
 *
 * SOURCES (all real, all currently written)
 * -----------------------------------------
 *   • `users/{uid}/analysisJobs`  status == "failed"   → errorMessage
 *   • `users/{uid}/exports`       status == "failed"   → errorMessage (browser)
 *   • `users/{uid}/exportJobs`    status == "failed"   → errorMessage+errorCode (cloud)
 *
 * REMOVED: the "client" source. It queried
 * `analyticsEvents where eventName == "error_occurred"` and read `metadata.message`
 * / `metadata.where`. `EVENTS.ERROR_OCCURRED` is declared in
 * src/lib/analytics/events.ts but NOTHING in the codebase emits it — a repo-wide
 * search finds only the declaration and the old route. So that tab was
 * guaranteed to be empty forever, and those two metadata keys were never
 * written by anything. Rather than keep a permanently blank filter, the source
 * is gone; wire up a producer first if client-error capture is wanted.
 *
 * ADDED: cloud export failures. `users/{uid}/exportJobs` is the paid render
 * path (schema.ts:2293) and its failures were previously invisible here — the
 * revenue path had no error visibility at all.
 *
 * FIXED — per-source starvation. Each source used to fetch its own `limit` rows,
 * then all three were concatenated, sorted and sliced to `limit`. With 50
 * recent export failures, 50 analysis failures could be pushed entirely out of
 * the window and silently disappear. Now every source is scanned across the
 * full date window and merged before pagination, so no source can starve another.
 *
 * FIXED — silent index failure. Each source had its own try/catch that logged
 * and continued, and the route never set `indexBuilding`. A missing index
 * therefore rendered as "no errors" — the worst possible false negative on an
 * error dashboard. Errors now propagate to `adminRoute`, which distinguishes
 * "index building" (friendly 200) from a real failure (500).
 *
 * NOT AVAILABLE: resolution state. No collection stores a resolved/acknowledged
 * flag for a failure, so "unresolved errors" cannot be filtered — every failure
 * in the window is listed. Adding e.g. `resolvedAt` to the failing docs (or a
 * separate triage collection) is what that would require.
 */

import { getAdmin } from "@/lib/firebase/admin";
import { adminRoute } from "@/lib/admin/handler";
import { scanWindow, paginate, uidFromSubDoc } from "@/lib/admin/scan";
import { parseListParams, matchesSearch } from "@/lib/admin/params";
import { tsToMillis } from "@/lib/admin/serialize";
import { mapSafe, str } from "@/lib/admin/validate";
import { tally, toSlices, groupByFrequency, bucketByDay } from "@/lib/admin/aggregate";
import { errorLabel } from "@/lib/admin/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ErrorKind = "analysis" | "export" | "cloud-export";

const ERROR_KINDS: readonly ErrorKind[] = ["analysis", "export", "cloud-export"];

interface ErrorRow {
  id: string;
  kind: ErrorKind;
  uid: string;
  projectId: string;
  projectTitle: string;
  message: string;
  errorCode: string | null;
  /** Normalized grouping key — see lib/admin/errors.ts. */
  signature: string;
  at: number;
  context: Record<string, string | number | null>;
}

export const GET = adminRoute("errors", async (req) => {
  const { db } = getAdmin();
  const p = parseListParams(req.nextUrl.searchParams);
  const kind = req.nextUrl.searchParams.get("kind") ?? "";

  const want = (k: ErrorKind) => !kind || kind === k;
  const empty = { docs: [], truncated: false, scanned: 0 };

  const [analysis, browserExports, cloudExports] = await Promise.all([
    want("analysis")
      ? scanWindow({
          query: db.collectionGroup("analysisJobs").where("status", "==", "failed"),
          orderField: "startedAt",
          // analysisJobs writes Date.now() — a NUMBER, not a Timestamp.
          // A Timestamp bound here would match zero docs. See scan.ts.
          encoding: "number",
          fromMs: p.fromMs,
          toMs: p.toMs,
          label: "errors:analysis",
        })
      : Promise.resolve(empty),
    want("export")
      ? scanWindow({
          query: db.collectionGroup("exports").where("status", "==", "failed"),
          orderField: "createdAt",
          encoding: "timestamp",
          fromMs: p.fromMs,
          toMs: p.toMs,
          label: "errors:export",
        })
      : Promise.resolve(empty),
    want("cloud-export")
      ? scanWindow({
          query: db.collectionGroup("exportJobs").where("status", "==", "failed"),
          orderField: "createdAt",
          encoding: "timestamp",
          fromMs: p.fromMs,
          toMs: p.toMs,
          label: "errors:cloud-export",
        })
      : Promise.resolve(empty),
  ]);

  const analysisRows = mapSafe(
    analysis.docs,
    (d): ErrorRow => {
      const data = d.data();
      const message = str(data.errorMessage, "Analysis failed (no message recorded)");
      return {
        id: d.ref.path,
        kind: "analysis",
        uid: uidFromSubDoc(d.ref),
        projectId: str(data.projectId),
        projectTitle: str(data.projectTitle, "Untitled"),
        message,
        errorCode: null,
        signature: errorLabel(null, message),
        at: tsToMillis(data.completedAt as never) || tsToMillis(data.startedAt as never),
        context: {
          engine: str(data.engine) || null,
          chunkMode: str(data.chunkMode) || null,
          failedChunks: typeof data.failedCount === "number" ? data.failedCount : null,
        },
      };
    },
    "errors:analysis"
  );

  const exportRows = mapSafe(
    browserExports.docs,
    (d): ErrorRow => {
      const data = d.data();
      const message = str(data.errorMessage, "Browser export failed (no message recorded)");
      return {
        id: d.ref.path,
        kind: "export",
        uid: uidFromSubDoc(d.ref),
        projectId: str(data.projectId),
        projectTitle: str(data.projectTitle, "Untitled"),
        message,
        errorCode: null,
        signature: errorLabel(null, message),
        at: tsToMillis(data.completedAt as never) || tsToMillis(data.createdAt as never),
        context: {
          format: str(data.format) || null,
          resolution: str(data.resolution) || null,
        },
      };
    },
    "errors:export"
  );

  const cloudRows = mapSafe(
    cloudExports.docs,
    (d): ErrorRow => {
      const data = d.data();
      const message = str(data.errorMessage, "Cloud export failed (no message recorded)");
      const errorCode = str(data.errorCode) || null;
      return {
        id: d.ref.path,
        kind: "cloud-export",
        uid: uidFromSubDoc(d.ref) || str(data.userId),
        projectId: str(data.projectId),
        projectTitle: str(data.projectTitle, "Untitled"),
        message,
        errorCode,
        // Prefer the structured code — far more actionable than prose.
        signature: errorLabel(errorCode, message),
        at: tsToMillis(data.updatedAt as never) || tsToMillis(data.createdAt as never),
        context: {
          stage: str(data.stage) || null,
          plan: str(data.planAtExport) || str(data.plan) || null,
          backend: str(data.backend) || null,
          workerId: str(data.workerId) || null,
        },
      };
    },
    "errors:cloud-export"
  );

  const all = [...analysisRows.rows, ...exportRows.rows, ...cloudRows.rows].sort(
    (a, b) => b.at - a.at
  );

  const summary = {
    byKind: tally(all, (r) => r.kind, ERROR_KINDS),
    /** The point of this page: which failure is happening most. */
    topSignatures: groupByFrequency(all, (r) => r.signature, 10).map((g) => ({
      signature: g.key,
      count: g.count,
      kind: g.sample.kind,
      sampleMessage: g.sample.message,
      lastSeenAt: g.sample.at,
    })),
    byErrorCode: toSlices(
      tally(all.filter((r) => r.errorCode), (r) => r.errorCode ?? ""),
      { topN: 8, dropZero: true }
    ),
    /** Distinct users hit — a failure affecting 1 user differs from 40. */
    affectedUsers: new Set(all.map((r) => r.uid).filter(Boolean)).size,
    total: all.length,
    perDay: bucketByDay(all, (r) => r.at, { fromMs: p.fromMs, toMs: p.toMs }),
  };

  const filtered = all.filter(
    (r) =>
      (!kind || r.kind === kind) &&
      matchesSearch(p.search, r.message, r.projectTitle, r.uid, r.projectId, r.errorCode)
  );

  const page = paginate(filtered, p.page, p.pageSize);

  return {
    rows: page.rows,
    page: page.page,
    pageCount: page.pageCount,
    pageSize: p.pageSize,
    filteredTotal: page.total,
    windowTotal: all.length,
    summary,
    truncated: analysis.truncated || browserExports.truncated || cloudExports.truncated,
    scanned: analysis.scanned + browserExports.scanned + cloudExports.scanned,
    skipped: analysisRows.skipped + exportRows.skipped + cloudRows.skipped,
    range: { fromMs: p.fromMs, toMs: p.toMs, key: p.range },
    generatedAt: Date.now(),
  };
});
