/**
 * Re-balance endpoint — runs phases C → E of the hybrid pipeline without
 * calling Gemini.
 *
 * Triggered when the user:
 *   - changes pacing / preset
 *   - clicks "Re-analyze with new engine" on an older project
 *
 * Reads cached `rawMoments`, `visualAnalysis`, and `interactions.json`.
 * Honors `source: "user"` and `edited: true` moments — they pass through
 * untouched. Emits a fresh `attentionCurve` derived from the same inputs so
 * the consumer-of-record (invariant 3) stays in sync.
 */

import { NextResponse, type NextRequest } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdmin } from "@/lib/firebase/admin";
import { balanceTimeline } from "@/lib/timeline-balancer";
import { momentsFromEvents } from "@/lib/attention/events";
import { attentionCurve } from "@/lib/attention/score";
import { cursorIntent } from "@/lib/attention/cursor-intent";
import { canUseAiFeature } from "@/lib/usage/ai-features";
import { canUsePreset } from "@/lib/usage/gating";
import { stripUndefined } from "@/lib/firebase/sanitize";
import type { Interaction } from "@/lib/recording/types";
import type {
  Analysis,
  DetectedMoment,
  Pacing,
  ProjectStatus,
  VisualAnalysis,
} from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { id: projectId } = await params;

  // 1. Auth
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
    console.error("[rebalance] token verify failed", err);
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  const uid = decoded.uid;

  const ref = db.doc(`users/${uid}/projects/${projectId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const project = snap.data() as Record<string, unknown>;

  // 2. Optional override — caller may force a pacing.
  const body = (await req.json().catch(() => ({}))) as { pacing?: Pacing };
  const existingPacing = (project.effectsSettings as { pacing?: Pacing } | undefined)?.pacing;
  const pacing: Pacing = body.pacing ?? existingPacing ?? "moderate";

  // ── Plan gates ──────────────────────────────────────────────────────
  // Refuse to rebalance if the project carries a premium preset this user
  // can't use, OR if they're asking for "fast" pacing (the AI-rebalance
  // feature, gated to Creator+).
  const selectedPresetId = project.selectedPresetId as string | undefined;
  if (selectedPresetId && !(await canUsePreset(uid, selectedPresetId))) {
    return NextResponse.json(
      {
        error: "The preset on this project requires a higher plan.",
        kind: "plan_required",
      },
      { status: 402 }
    );
  }
  if (pacing === "fast" && !(await canUseAiFeature(uid, "ai-rebalance"))) {
    return NextResponse.json(
      {
        error: "Dense pacing requires the Creator plan.",
        kind: "plan_required",
      },
      { status: 402 }
    );
  }

  const analysis = project.analysis as Analysis | undefined;
  if (!analysis || !analysis.rawMoments) {
    return NextResponse.json(
      { error: "Project has no cached analysis — run /analyze first." },
      { status: 400 }
    );
  }
  const rawMoments = analysis.rawMoments as DetectedMoment[];
  const userMoments = (analysis.detectedMoments ?? []).filter(
    (m) => m.source === "user" || m.edited
  );
  const duration = (project.duration as number | undefined) ?? 0;
  const visualAnalysis = project.visualAnalysis as VisualAnalysis | undefined;
  const interactionsPath = project.interactionsPath as string | undefined;
  const interactionScope = project.interactionScope as
    | "tab"
    | "external"
    | undefined;

  // 3. Load interactions if present — zero-cost re-balance for in-tab recordings.
  let interactions: Interaction[] = [];
  if (interactionsPath && interactionScope === "tab") {
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
      console.warn("[rebalance] interactions load failed", err);
    }
  }

  // 4. Re-run phases C → E.
  const cursorIntentSeries =
    interactions.length > 0
      ? cursorIntent(
          interactions,
          duration,
          visualAnalysis?.sampleRate ?? 10
        )
      : undefined;

  const eventMoments =
    interactions.length > 0
      ? momentsFromEvents(interactions, {
          duration,
          cursorIntent: cursorIntentSeries,
          visualAnalysis,
          scope: interactionScope,
        })
      : [];

  const attention = attentionCurve({
    duration,
    interactions,
    interactionScope,
    visualAnalysis,
    uiRegions: visualAnalysis?.uiRegions,
  });

  // Under "dense" pacing, the balancer is allowed to reconsider candidates
  // the analyze pass rejected (idle/boring/no-target). For "moderate" and
  // "slow", the reject pass runs as normal and those candidates stay out.
  // This is the only place where `rejected: true` candidates can come back
  // into the active timeline without a fresh Gemini call.
  const unrejectRebalance = pacing === "fast";

  const balanced = balanceTimeline({
    raw: rawMoments,
    duration,
    pacing,
    videoType: analysis.videoType,
    visualAnalysis,
    eventMoments,
    preserved: userMoments,
    useCvCandidates: true,
    boringSections: analysis.boringSections ?? [],
    interactions,
    unrejectRebalance,
  });

  // 5. Persist. `rawMoments` is rewritten so the new rejection state (which
  // may differ under the new pacing) is reflected in future rebalances —
  // a moment that was rejected at "moderate" might survive at "fast" and
  // vice versa.
  const nextRaw: DetectedMoment[] = [
    ...rawMoments.filter((m) => m.rejected !== true), // strip previous rejects
    ...balanced.rejectedPool, // re-record current rejects
  ];

  // Strip `undefined` anywhere in the moment payload — Firestore rejects
  // explicit-undefined values even for optional fields (e.g. legacy moments
  // missing `whyEffectType` get spread with `whyEffectType: undefined`).
  await ref.set(
    {
      status: "analyzed" as ProjectStatus,
      analysis: {
        detectedMoments: stripUndefined(balanced.moments),
        rawMoments: stripUndefined(nextRaw),
        rejectedPool: stripUndefined(balanced.rejectedPool),
        attentionCurve: attention.curveQ8,
        attentionSampleRate: attention.sampleRate,
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return NextResponse.json({
    ok: true,
    momentCount: balanced.moments.length,
    provenanceCounts: balanced.stats.provenanceCounts,
    quotaDropped: balanced.stats.quotaDropped,
    aiRejectedBoring: balanced.stats.aiRejectedBoring,
    aiRejectedIdle: balanced.stats.aiRejectedIdle,
    aiRejectedNoTarget: balanced.stats.aiRejectedNoTarget,
    sceneChangeNudged: balanced.stats.sceneChangeNudged,
    quartileLeftEmpty: balanced.stats.quartileLeftEmpty,
  });
}
