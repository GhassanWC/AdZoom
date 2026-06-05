/**
 * Diagnostic bypass route: read `interactions.json` and write ONE zoom
 * moment per click directly into `analysis.detectedMoments`. No
 * Gemini, no balancer, no classifier, no overlap collapsing — the
 * dumbest possible "click → zoom" pipeline.
 *
 * Purpose: prove whether the captured click data is enough on its own
 * to produce a multi-edit timeline. If this returns N moments for N
 * clicks and the timeline shows them, the loss is downstream of capture.
 * If this returns 0/1 too, the loss is in capture (interactions.json
 * doesn't contain the clicks the user thinks it does).
 *
 * REPLACES `analysis.detectedMoments` — destructive. The caller is
 * expected to be a developer/debug action, not a normal user flow.
 * `analysis.rawMoments` is left intact so a Re-analyze can recover.
 */

import { NextResponse, type NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { stripUndefined } from "@/lib/firebase/sanitize";
import type { Interaction } from "@/lib/recording/types";
import {
  resolveScopeAndTrust,
  type CaptureDimensions,
} from "@/lib/recording/scope-detect";
import type { DetectedMoment, ProjectStatus } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PRE_S = 0.3;
const POST_S = 1.4;
const DEFAULT_HALF = 0.15;

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: projectId } = await params;
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
    console.error("[zooms-from-clicks] token verify failed", err);
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  const uid = decoded.uid;

  const ref = db.doc(`users/${uid}/projects/${projectId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const project = snap.data() as Record<string, unknown>;
  const duration = (project.duration as number | undefined) ?? 0;
  const interactionsPath = project.interactionsPath as string | undefined;
  const interactionScope = project.interactionScope as
    | "tab"
    | "external"
    | undefined;
  const captureDimensions = project.captureDimensions as
    | CaptureDimensions
    | undefined;
  const resolvedScope = resolveScopeAndTrust(interactionScope, captureDimensions);

  if (!interactionsPath) {
    return NextResponse.json(
      { error: "Project has no interactionsPath — nothing to read." },
      { status: 400 }
    );
  }

  let interactions: Interaction[] = [];
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
    return NextResponse.json(
      {
        error: "Could not load interactions.json",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }

  // This route turns click COORDINATES directly into zooms — so it must refuse
  // when the coordinates aren't trusted (external surface): they live in the
  // Framevo viewport, not the recorded frame, and would place zooms at random.
  if (!resolvedScope.coordinatesTrusted) {
    return NextResponse.json(
      {
        error: `Coordinates not trusted — ${resolvedScope.trustReason}. Refusing to generate zooms from unmapped coordinates.`,
        scopeAssigned: resolvedScope.scopeAssigned ?? null,
        scopeValidated: resolvedScope.scopeValidated ?? null,
        totalInteractions: interactions.length,
      },
      { status: 422 }
    );
  }

  const clicks = interactions.filter(
    (e): e is Extract<Interaction, { type: "click" | "dblclick" | "rightclick" }> =>
      e.type === "click" || e.type === "dblclick" || e.type === "rightclick"
  );

  const moments: DetectedMoment[] = clicks.map((c, i) => {
    const useRect = resolvedScope.scopeValidated === "tab" && c.targetRect;
    const cx = useRect && c.targetRect
      ? c.targetRect.x + c.targetRect.width / 2
      : c.x;
    const cy = useRect && c.targetRect
      ? c.targetRect.y + c.targetRect.height / 2
      : c.y;
    const halfW = DEFAULT_HALF;
    const halfH = DEFAULT_HALF;

    const startTime = Math.max(0, c.t - PRE_S);
    const endTime = Math.min(duration || c.t + POST_S + 0.1, c.t + POST_S);

    return {
      id: `mom_bypass_${c.id}`,
      startTime,
      endTime,
      label: `Click ${i + 1}`,
      reason: "bypass: one zoom per click, no classifier, no balancer",
      focusRegion: {
        x: Math.max(0, Math.min(1 - halfW * 2, cx - halfW)),
        y: Math.max(0, Math.min(1 - halfH * 2, cy - halfH)),
        width: halfW * 2,
        height: halfH * 2,
      },
      effectType: "zoom",
      intensity: 0.95,
      source: "ai",
      provenance: "event",
      eventIds: [c.id],
      confidenceScore: 1,
      confidenceSource: "real-click",
      confidenceReason: `bypass route — click ${i + 1} at ${c.t.toFixed(2)}s`,
      uiContext: "button",
      targetRegionSource: useRect ? "click-event" : "click-event",
      whyEffectType: "bypass route — direct click → zoom",
      whySelected: "bypass route — no balancer applied",
      sourceSignals: [`click@${c.t.toFixed(2)}`, "bypass-route"],
    };
  });

  await ref.set(
    {
      status: "analyzed" as ProjectStatus,
      analysis: {
        status: "complete",
        stage: "Bypass · zooms-from-clicks",
        detectedMoments: stripUndefined(moments),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return NextResponse.json({
    ok: true,
    projectId,
    totalInteractions: interactions.length,
    totalClicks: clicks.length,
    momentsWritten: moments.length,
    scope: resolvedScope.scopeValidated ?? null,
    scopeAssigned: resolvedScope.scopeAssigned ?? null,
    interactionsPath,
  });
}
