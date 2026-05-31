/**
 * Read-only click-pipeline inspector. Does NOT mutate the project — its
 * job is to answer "where exactly did the clicks disappear?" for a
 * given recording, on demand, without re-running analyze.
 *
 * Stages reported:
 *   capture        — does the project even reference an interactions.json?
 *   load           — can the route read + parse it now? what scope?
 *   classify       — per-tier histogram from the click classifier
 *   eventsEmitted  — what would momentsFromEvents produce right now?
 *   currentTimeline — what the project currently has on the timeline,
 *                     and how many of those moments are event-derived
 *
 * Useful for confirming "the clicks ARE in interactions.json but
 * something downstream is eating them" vs "the recording never
 * captured them in the first place".
 */

import { NextResponse, type NextRequest } from "next/server";
import { getAdmin } from "@/lib/firebase/admin";
import { momentsFromEvents } from "@/lib/attention/events";
import { cursorIntent } from "@/lib/attention/cursor-intent";
import { classifyClick, type ClickTier } from "@/lib/attention/click-classifier";
import type { Interaction } from "@/lib/recording/types";
import type { VisualAnalysis, DetectedMoment } from "@/lib/firebase/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteContext) {
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
    console.error("[diagnose] token verify failed", err);
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  const uid = decoded.uid;

  const ref = db.doc(`users/${uid}/projects/${projectId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const project = snap.data() as Record<string, unknown>;
  const interactionsPath = project.interactionsPath as string | undefined;
  const interactionScope = project.interactionScope as
    | "tab"
    | "external"
    | undefined;
  const duration = (project.duration as number | undefined) ?? 0;
  const visualAnalysis = project.visualAnalysis as VisualAnalysis | undefined;
  const detectedMoments =
    ((project.analysis as { detectedMoments?: DetectedMoment[] } | undefined)
      ?.detectedMoments ?? []);

  // Stage 1: capture
  const capture = {
    hasInteractionsPath: !!interactionsPath,
    interactionsPath: interactionsPath ?? null,
    scope: interactionScope ?? null,
    duration,
  };

  // Stage 2: load
  let interactions: Interaction[] = [];
  let loadError: string | null = null;
  let exists = false;
  if (interactionsPath) {
    try {
      const bucket = storage.bucket();
      const [fileExists] = await bucket.file(interactionsPath).exists();
      exists = fileExists;
      if (fileExists) {
        const [iBuf] = await bucket.file(interactionsPath).download();
        const parsed = JSON.parse(iBuf.toString("utf8")) as {
          version: number;
          scope: string;
          events: Interaction[];
        };
        interactions = Array.isArray(parsed?.events) ? parsed.events : [];
      } else {
        loadError = `Storage object missing: ${interactionsPath}`;
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : "load failed";
    }
  } else {
    loadError = "no-interactionsPath";
  }

  const load = {
    objectExists: exists,
    parsedOk: loadError === null,
    error: loadError,
    totalInteractions: interactions.length,
    totalClicks: interactions.filter(
      (e) => e.type === "click" || e.type === "dblclick" || e.type === "rightclick"
    ).length,
    eventTypeCounts: histogram(interactions.map((e) => e.type)),
  };

  // Stage 3: classify (per-tier histogram).
  const cursorIntentSeries =
    interactions.length > 0
      ? cursorIntent(interactions, duration, visualAnalysis?.sampleRate ?? 10)
      : undefined;

  const tiers: Record<ClickTier, number> = {
    "primary-cta": 0,
    icon: 0,
    nav: 0,
    form: 0,
    background: 0,
  };
  const perClick: Array<{
    id: string;
    t: number;
    x: number;
    y: number;
    hasTargetRect: boolean;
    tier: ClickTier;
    confidence: number;
    signals: string[];
  }> = [];
  for (const e of interactions) {
    if (e.type !== "click") continue;
    const cls = classifyClick({
      click: { x: e.x, y: e.y, t: e.t, targetRect: e.targetRect },
      cursorIntent: cursorIntentSeries,
      visualAnalysis,
      scope: interactionScope ?? "tab",
    });
    tiers[cls.tier] += 1;
    perClick.push({
      id: e.id,
      t: e.t,
      x: e.x,
      y: e.y,
      hasTargetRect: !!e.targetRect,
      tier: cls.tier,
      confidence: cls.confidence,
      signals: cls.signals,
    });
  }
  // dblclick + rightclick are forced to primary-cta in events.ts.
  for (const e of interactions) {
    if (e.type === "dblclick" || e.type === "rightclick") {
      tiers["primary-cta"] += 1;
    }
  }

  // Stage 4: eventsEmitted — run momentsFromEvents in isolation.
  const emitted =
    interactions.length > 0
      ? momentsFromEvents(interactions, {
          duration,
          cursorIntent: cursorIntentSeries,
          visualAnalysis,
          scope: interactionScope,
        })
      : [];

  const eventsEmitted = {
    total: emitted.length,
    fromClicks: emitted.filter((m) =>
      (m.eventIds ?? []).some((id) => id.startsWith("ev_"))
    ).length,
    byEffectType: histogram(emitted.map((m) => m.effectType)),
    moments: emitted.map((m) => ({
      id: m.id,
      startTime: m.startTime,
      endTime: m.endTime,
      effectType: m.effectType,
      confidence: m.confidenceScore,
      eventIds: m.eventIds,
      sourceSignals: m.sourceSignals,
    })),
  };

  // Stage 5: currentTimeline — what does the user actually see right now?
  const currentTimeline = {
    totalMoments: detectedMoments.length,
    eventProvenance: detectedMoments.filter((m) => m.provenance === "event").length,
    aiProvenance: detectedMoments.filter(
      (m) => m.provenance === "ai" || m.provenance === "ai-override"
    ).length,
    cvProvenance: detectedMoments.filter((m) => m.provenance === "cv").length,
    userProvenance: detectedMoments.filter((m) => m.provenance === "user").length,
  };

  return NextResponse.json({
    ok: true,
    projectId,
    uid,
    storedClickPipeline:
      (project.analysis as Record<string, unknown> | undefined)?.clickPipeline ??
      null,
    capture,
    load,
    classify: { tiers, perClick },
    eventsEmitted,
    currentTimeline,
  });
}

function histogram<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
