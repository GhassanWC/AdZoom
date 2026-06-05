import { NextResponse, type NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import {
  EXPORT_LIMITS,
  ExportLimitError,
  PlanRequiredError,
  canExportResolution,
  getUserPlan,
} from "@/lib/usage/gating";
import { currentMonthKey } from "@/lib/usage/usage";
import { normalizePlan, planMeetsMinimum, type PlanTier } from "@/lib/usage/plan";
import type { ExportFormat, MonthlyUsage } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PermitBody {
  projectId?: string;
  projectTitle?: string;
  resolution?: "1080p" | "4K";
  format?: ExportFormat;
  fps?: 30 | 60;
}

/**
 * POST /api/billing/export-permit
 *
 * The HARD server gate that runs BEFORE a client renders a video. Replaces
 * the soft client-side check that used to live in `uploadExport`. Three
 * jobs in one transaction:
 *
 *   1. Verify the user's plan allows the requested resolution.
 *      4K requires a paid plan (Pro $19+); 1080p is universal.
 *
 *   2. Verify the user is under their monthly export cap.
 *      Free: 5 / both paid tiers: Infinity. Read + increment in a
 *      transaction so two concurrent clicks can't both squeeze through.
 *
 *   3. Create the export doc with `status: "permitted"` and the plan-gated
 *      fields (resolution, format, fps, applyWatermark) locked in. Firestore
 *      rules forbid the client from ever touching those — only the
 *      completion patch (status → ready + upload metadata) is allowed.
 *
 * Returns `{ exportId, applyWatermark, uploadPath }`. Errors:
 *   • 401  Missing / invalid auth.
 *   • 400  Bad request body.
 *   • 402  Plan-required (4K without a paid plan). `{ kind: "plan_required" }`
 *   • 429  Monthly cap reached. `{ kind: "limit_reached", used, limit }`
 *   • 500  Something else.
 */
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json(
        { error: "Missing Authorization header" },
        { status: 401 }
      );
    }

    const { auth, db } = getAdmin();
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (err) {
      console.error("[export-permit] token verify failed", err);
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
    const uid = decoded.uid;

    const body = (await req.json().catch(() => ({}))) as PermitBody;
    const { projectId, projectTitle, resolution, format, fps } = body;
    if (
      typeof projectId !== "string" ||
      typeof projectTitle !== "string" ||
      (resolution !== "1080p" && resolution !== "4K") ||
      (format !== "Source" &&
        format !== "TikTok 9:16" &&
        format !== "YouTube 16:9" &&
        format !== "Custom") ||
      (fps !== 30 && fps !== 60)
    ) {
      return NextResponse.json(
        {
          error:
            "Body must include { projectId, projectTitle, resolution: '1080p'|'4K', format, fps: 30|60 }",
        },
        { status: 400 }
      );
    }

    // 1. Plan vs resolution. 4K requires a paid plan (Pro $19 and up).
    if (!(await canExportResolution(uid, resolution))) {
      const plan = await getUserPlan(uid);
      return NextResponse.json(
        {
          error: "A paid plan is required for 4K export",
          kind: "plan_required",
          required: "pro",
          actual: plan,
        },
        { status: 402 }
      );
    }

    // 2 + 3. Transactional: count check + counter increment + export doc create.
    const monthKey = currentMonthKey();
    const usageRef = db.doc(`users/${uid}/usage/${monthKey}`);
    const exportRef = db.collection(`users/${uid}/exports`).doc();
    const exportId = exportRef.id;

    let applyWatermark = false;
    let nextUsage: MonthlyUsage = { exportCount: 0, updatedAt: Date.now() };
    let planAtPermit: PlanTier = "free";

    try {
      const userRef = db.doc(`users/${uid}`);
      await db.runTransaction(async (tx) => {
        // All reads MUST happen before any writes in a Firestore transaction.
        const userSnap = await tx.get(userRef);
        const usageSnap = await tx.get(usageRef);

        const plan = normalizePlan(
          (userSnap.data() as { plan?: unknown } | undefined)?.plan
        );
        planAtPermit = plan;

        const prev = usageSnap.exists
          ? (usageSnap.data() as MonthlyUsage)
          : { exportCount: 0, updatedAt: 0 };

        const limit = EXPORT_LIMITS[plan];
        if (prev.exportCount >= limit) {
          throw new ExportLimitError(prev.exportCount, limit, plan);
        }

        applyWatermark = !planMeetsMinimum(plan, "pro");

        const now = Date.now();
        nextUsage = {
          exportCount: prev.exportCount + 1,
          lastExportAt: now,
          updatedAt: now,
        };
        tx.set(usageRef, nextUsage, { merge: true });

        const expectedStoragePath = `users/${uid}/projects/${projectId}/exports/${exportId}.webm`;

        tx.set(exportRef, {
          projectId,
          projectTitle,
          format,
          resolution,
          fps,
          status: "permitted",
          applyWatermark,
          expectedStoragePath,
          monthlyBucket: monthKey,
          createdAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (err) {
      if (err instanceof ExportLimitError) {
        return NextResponse.json(
          {
            error: `You've used all ${err.limit} exports this month. Upgrade to keep exporting.`,
            kind: "limit_reached",
            used: err.used,
            limit: err.limit,
            plan: err.plan,
          },
          { status: 429 }
        );
      }
      if (err instanceof PlanRequiredError) {
        return NextResponse.json(
          {
            error: err.message,
            kind: "plan_required",
            required: err.required,
            actual: err.actual,
          },
          { status: 402 }
        );
      }
      throw err;
    }

    // Pull the final storagePath out of the doc since the transaction
    // built it from the projectId we just wrote.
    const finalSnap = await exportRef.get();
    const uploadPath =
      (finalSnap.data() as { expectedStoragePath?: string } | undefined)
        ?.expectedStoragePath ?? "";

    return NextResponse.json({
      ok: true,
      exportId,
      applyWatermark,
      uploadPath,
      usage: {
        used: nextUsage.exportCount,
        limit: EXPORT_LIMITS[planAtPermit],
        plan: planAtPermit,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Export permit failed.";
    console.error("[export-permit] failed", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
