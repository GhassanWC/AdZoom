/**
 * GET /api/admin/report?range=today|7d|30d|all&from=&to=&includeEmails=1
 *
 * Downloads the full admin health & diagnostics report as a PDF: users,
 * activation, projects, the AI-analysis pipeline, both export pipelines, every
 * recorded failure, client-reported failures and timings, feature usage,
 * billing, a daily timeline, data-quality caveats, and rule-based findings
 * with recommendations. The full JSON is embedded as a PDF attachment so the
 * file can be handed to an AI assistant as-is.
 *
 * ADMIN ONLY: `adminRoute` runs `requireAdmin` before any Firestore read (the
 * same gate as every other /api/admin route — enforced by
 * tests/admin-data-integrity.test.ts). Emails are masked unless the admin
 * explicitly asks for them with `includeEmails=1`.
 */

import { NextResponse } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { adminRoute } from "@/lib/admin/handler";
import { parseListParams } from "@/lib/admin/params";
import { collectReportInput } from "@/lib/admin/report/collect";
import { buildAdminReport } from "@/lib/admin/report/model";
import { renderAdminReportPdf } from "@/lib/admin/report/pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Seven collection scans + PDF layout; well above the default on a cold start.
export const maxDuration = 120;

export const GET = adminRoute("report", async (req, admin) => {
  const { db } = getAdmin();
  const sp = req.nextUrl.searchParams;
  const p = parseListParams(sp);

  const input = await collectReportInput(db, {
    fromMs: p.fromMs,
    toMs: p.toMs,
    rangeKey: p.range,
    generatedBy: admin.email,
    includeEmails: sp.get("includeEmails") === "1",
  });
  const report = buildAdminReport(input);
  const pdf = await renderAdminReportPdf(report);

  const stamp = new Date(report.meta.generatedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const filename = `framevo-admin-report-${p.range}-${stamp}.pdf`;

  return new NextResponse(Buffer.from(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdf.byteLength),
      // Contains user data — never cache anywhere.
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
