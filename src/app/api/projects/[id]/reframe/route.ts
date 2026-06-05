/**
 * Reframe endpoint — re-derives `focusRegion` for every AI-positioned moment
 * using the project's saved interactions + visual analysis, WITHOUT calling
 * Gemini or re-running the balancer's selection pass.
 *
 * Triggered by the editor's "Refine framing" toolbar button. The migration
 * story for projects analyzed before directional framing existed: they keep
 * their centered focus regions until the user opts in by clicking the
 * button. User-positioned regions (`targetRegionSource === "user"` or
 * `source === "user"`) are always passed through untouched.
 *
 * Cheap: no Gemini call, no balancer selection, no CV pass. Just one
 * `refineMomentFocalRegion` per moment + a single Firestore write.
 */

import { NextResponse, type NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { refineMomentFocalRegion } from "@/lib/timeline/focal-region";
import { stripUndefined } from "@/lib/firebase/sanitize";
import type { Interaction } from "@/lib/recording/types";
import {
  resolveScopeAndTrust,
  type CaptureDimensions,
} from "@/lib/recording/scope-detect";
import type {
  Analysis,
  DetectedMoment,
  VisualAnalysis,
} from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: projectId } = await params;

  // ── Auth ───────────────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization") || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }
  const { auth, db, storage } = getAdmin();
  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken);
  } catch (err) {
    console.error("[reframe] token verify failed", err);
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  const uid = decoded.uid;

  const ref = db.doc(`users/${uid}/projects/${projectId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const project = snap.data() as Record<string, unknown>;

  const analysis = project.analysis as Analysis | undefined;
  if (!analysis?.detectedMoments) {
    return NextResponse.json(
      { error: "Project has no analyzed moments — run /analyze first." },
      { status: 400 }
    );
  }
  const visualAnalysis = project.visualAnalysis as VisualAnalysis | undefined;
  const interactionsPath = project.interactionsPath as string | undefined;
  const interactionScope = project.interactionScope as
    | "tab"
    | "external"
    | undefined;
  const captureDimensions = project.captureDimensions as
    | CaptureDimensions
    | undefined;

  // ── Load saved interactions whenever a manifest exists (load is independent
  // of scope); trust is decided separately via re-validated scope. ──
  let interactions: Interaction[] = [];
  if (interactionsPath) {
    try {
      const bucket = storage.bucket();
      const [iBuf] = await bucket.file(interactionsPath).download();
      const parsed = JSON.parse(iBuf.toString("utf8")) as {
        version: number;
        scope: string;
        events: Interaction[];
      };
      interactions = Array.isArray(parsed?.events) ? parsed.events : [];
    } catch (err) {
      console.warn("[reframe] interactions load failed", err);
    }
  }
  const resolvedScope = resolveScopeAndTrust(interactionScope, captureDimensions);
  // Only trusted click coordinates feed focal-region refinement; for untrusted
  // recordings we refine from CV/defaults only (pass no interactions).
  const trustedInteractions: Interaction[] = resolvedScope.coordinatesTrusted
    ? interactions
    : [];

  // ── Apply refinement ──────────────────────────────────────────────
  // `refineMomentFocalRegion` is the single source of truth for the
  // multi-signal cascade. It already honors user-positioned regions; we
  // don't need to filter here.
  const detected = analysis.detectedMoments as DetectedMoment[];
  let changedCount = 0;
  const refined: DetectedMoment[] = detected.map((m) => {
    const next = refineMomentFocalRegion(m, trustedInteractions, visualAnalysis ?? null);
    if (next !== m) changedCount++;
    return next;
  });

  // Short-circuit when nothing changed — no Firestore write.
  if (changedCount === 0) {
    return NextResponse.json({
      ok: true,
      changedCount: 0,
      totalCount: detected.length,
      message:
        "Every moment is already well-framed (or user-positioned, which we never overwrite).",
    });
  }

  await ref.set(
    {
      analysis: {
        detectedMoments: stripUndefined(refined),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return NextResponse.json({
    ok: true,
    changedCount,
    totalCount: detected.length,
  });
}
