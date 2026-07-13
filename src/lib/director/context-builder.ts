/**
 * AI Director — video context builder.
 *
 * "Understand the video" concretely means: read everything Framevo ALREADY knows
 * about this project and fold it into one compact, evidence-bearing structure.
 * Nothing here is invented — every candidate carries the id of the real datum it
 * came from, so the planner (and a human reading the plan) can check the claim.
 *
 * Sources, all of which already exist on the project:
 *   • analysis.detectedMoments  — the CV/event/AI moments (clicks, zooms, cuts)
 *   • analysis.transcript       — real ASR text + word timings
 *   • analysis.audioAnalysis    — silences, long pauses, filler words, speech
 *   • analysis.narrativeStructure — the story beats Gemini already labelled
 *   • analysis.attentionCurve   — the per-second attention signal
 *   • visualAnalysis            — clicks, scene changes, motion, UI regions
 *
 * Pure: types-only imports, no I/O. Runs on the server, in the browser and under
 * `node --test` unchanged.
 */
import type {
  Analysis,
  DetectedMoment,
  NarrativeSegment,
  ProjectDoc,
  SelectedVideoType,
  Transcript,
  VisualAnalysis,
} from "../firebase/schema";
import type { DirectorEvidence } from "./types";

/** A stretch of video worth keeping, with the evidence that says so. */
export interface DirectorCandidate {
  /** Stable id derived from the underlying datum — NOT a random uuid. */
  id: string;
  startTime: number;
  endTime: number;
  /** 0..1 — how strongly this deserves to survive the cut. */
  score: number;
  label: string;
  evidence: DirectorEvidence[];
  /** The narrative role, when the analysis labelled one. */
  role?: NarrativeSegment["role"];
  /** True when a real interaction (click) grounds this window. */
  hasInteraction: boolean;
  /** True when someone is speaking here. */
  hasSpeech: boolean;
}

/** A stretch that should go. */
export interface DirectorDeadZone {
  id: string;
  startTime: number;
  endTime: number;
  kind: "silence" | "pause" | "idle" | "boring" | "filler";
  reason: string;
  evidence: DirectorEvidence[];
}

/** Everything the planner is allowed to reason from. */
export interface DirectorVideoContext {
  projectId: string;
  title: string;
  durationSeconds: number;
  sourceWidth: number;
  sourceHeight: number;
  videoType: SelectedVideoType;

  hasTranscript: boolean;
  hasSpeech: boolean;
  hasInteractionData: boolean;
  hasAnalysis: boolean;

  transcript?: Transcript;
  narrative: NarrativeSegment[];
  /** Existing timeline moments (clicks, zooms, …) — the Director reuses these. */
  moments: DetectedMoment[];

  candidates: DirectorCandidate[];
  deadZones: DirectorDeadZone[];

  /** Total seconds of removable dead air found. */
  deadSeconds: number;
  /** Real click/interaction timestamps. */
  interactionTimes: number[];
  summary?: string;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Mean of the (quantized 0..255) attention curve over a source window. */
function attentionOver(
  analysis: Analysis | undefined,
  start: number,
  end: number
): number {
  const curve = analysis?.attentionCurve;
  const rate = analysis?.attentionSampleRate ?? 1;
  if (!curve?.length || end <= start) return 0;
  const a = Math.max(0, Math.floor(start * rate));
  const b = Math.min(curve.length, Math.ceil(end * rate));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += (curve[i] ?? 0) / 255;
  return clamp01(sum / (b - a));
}

/** Real interaction timestamps: recorded clicks first, CV-inferred as a fallback. */
function collectInteractionTimes(va: VisualAnalysis | undefined): number[] {
  if (!va) return [];
  const out: number[] = [];
  for (const c of va.inferredClicks ?? []) out.push(c.t);
  if (out.length === 0) {
    for (const e of va.clickEvents ?? []) out.push(e.t);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Build the Director's understanding of this video.
 *
 * The candidate set is a UNION of every signal, deduped by window: a stretch
 * that has a click AND speech AND a high-attention moment scores higher than one
 * that only has a click. That union is what stops the Director from behaving
 * like "top-N moments by score" — the planner needs to see the connective tissue
 * (the explanation between two clicks), not just the peaks.
 */
export function buildDirectorContext(project: ProjectDoc): DirectorVideoContext {
  const analysis = project.analysis;
  const duration = Math.max(0, project.duration ?? 0);
  const transcript = analysis?.transcript;
  const audio = analysis?.audioAnalysis;
  const va = project.visualAnalysis;
  const moments = analysis?.detectedMoments ?? [];

  const hasTranscript =
    transcript?.status === "complete" && (transcript.segments?.length ?? 0) > 0;
  const hasSpeech = audio?.hasUsableSpeech === true || hasTranscript;
  const interactionTimes = collectInteractionTimes(va);
  const hasInteractionData = interactionTimes.length > 0;

  const speechAt = (start: number, end: number): boolean => {
    const segs = transcript?.segments ?? [];
    if (segs.some((s) => overlaps(start, end, s.startTime, s.endTime))) return true;
    const speech = audio?.speechSegments ?? [];
    return speech.some((s) => overlaps(start, end, s.startTime, s.endTime));
  };

  const clicksIn = (start: number, end: number): number[] =>
    interactionTimes.filter((t) => t >= start && t < end);

  // ── Dead zones: what should go ────────────────────────────────────────────
  // Long pauses and silences come from the REAL audio analysis; boring sections
  // from the existing Gemini pass; idle stretches from cut moments the cut
  // engine already found. Each keeps its origin so the plan can cite it.
  const deadZones: DirectorDeadZone[] = [];

  for (const [i, p] of (audio?.longPauses ?? []).entries()) {
    deadZones.push({
      id: `pause-${i}`,
      startTime: p.startTime,
      endTime: p.endTime,
      kind: "pause",
      reason: `Long pause (${p.duration.toFixed(1)}s of no speech).`,
      evidence: [
        {
          kind: "silence",
          detail: `audioAnalysis.longPauses[${i}] — ${p.duration.toFixed(1)}s`,
          at: p.startTime,
        },
      ],
    });
  }

  for (const [i, s] of (audio?.silenceSegments ?? []).entries()) {
    // Only silences long enough to be worth removing, and not already covered
    // by a long pause (the two overlap by construction).
    if (s.duration < 0.8) continue;
    if (deadZones.some((d) => overlaps(d.startTime, d.endTime, s.startTime, s.endTime))) {
      continue;
    }
    deadZones.push({
      id: `silence-${i}`,
      startTime: s.startTime,
      endTime: s.endTime,
      kind: "silence",
      reason: `Silent stretch (${s.duration.toFixed(1)}s).`,
      evidence: [
        {
          kind: "silence",
          detail: `audioAnalysis.silenceSegments[${i}] — ${s.duration.toFixed(1)}s`,
          at: s.startTime,
        },
      ],
    });
  }

  for (const [i, b] of (analysis?.boringSections ?? []).entries()) {
    if (deadZones.some((d) => overlaps(d.startTime, d.endTime, b.startTime, b.endTime))) {
      continue;
    }
    deadZones.push({
      id: `boring-${i}`,
      startTime: b.startTime,
      endTime: b.endTime,
      kind: "boring",
      reason: b.reason || "Low-value section.",
      evidence: [
        {
          kind: "attention",
          detail: `analysis.boringSections[${i}] — ${b.reason || "low value"}`,
          at: b.startTime,
        },
      ],
    });
  }

  // Idle stretches the cut engine already identified (its own CV thresholds).
  for (const m of moments) {
    if (m.effectType !== "cut") continue;
    if (deadZones.some((d) => overlaps(d.startTime, d.endTime, m.startTime, m.endTime))) {
      continue;
    }
    deadZones.push({
      id: `idle-${m.id}`,
      startTime: m.startTime,
      endTime: m.endTime,
      kind: "idle",
      reason: m.reason || "Dead / idle section.",
      evidence: [
        { kind: "moment", ref: m.id, detail: `cut moment ${m.id}`, at: m.startTime },
      ],
    });
  }

  // Filler words ("um", "uh") — real ASR data, grouped into removable blips.
  for (const [i, f] of (audio?.fillerWords ?? []).entries()) {
    deadZones.push({
      id: `filler-${i}`,
      startTime: f.startTime,
      endTime: f.endTime,
      kind: "filler",
      reason: `Filler word ("${f.word}").`,
      evidence: [
        { kind: "transcript", detail: `filler "${f.word}"`, at: f.startTime },
      ],
    });
  }

  deadZones.sort((a, b) => a.startTime - b.startTime);
  const deadSeconds = deadZones.reduce(
    (acc, d) => acc + Math.max(0, d.endTime - d.startTime),
    0
  );

  // ── Candidates: what deserves to stay ─────────────────────────────────────
  const candidates: DirectorCandidate[] = [];

  // 1. Narrative segments — the connective spine. These are what keep the final
  //    video coherent instead of a reel of disconnected peaks.
  const narrative = analysis?.narrativeStructure ?? [];
  for (const [i, seg] of narrative.entries()) {
    if (seg.role === "filler") continue;
    const attention = attentionOver(analysis, seg.startTime, seg.endTime);
    const clicks = clicksIn(seg.startTime, seg.endTime);
    const speech = speechAt(seg.startTime, seg.endTime);
    // A result/action beat is the payoff; intro/setup is support.
    const roleWeight =
      seg.role === "result"
        ? 0.95
        : seg.role === "action"
          ? 0.85
          : seg.role === "explanation"
            ? 0.6
            : seg.role === "intro"
              ? 0.55
              : seg.role === "setup"
                ? 0.5
                : 0.35;
    candidates.push({
      id: `seg-${i}`,
      startTime: seg.startTime,
      endTime: seg.endTime,
      score: clamp01(
        0.5 * roleWeight + 0.25 * attention + 0.15 * (clicks.length ? 1 : 0) + 0.1 * (speech ? 1 : 0)
      ),
      label: seg.label || seg.role,
      role: seg.role,
      hasInteraction: clicks.length > 0,
      hasSpeech: speech,
      evidence: [
        {
          kind: "narrative",
          detail: `narrativeStructure[${i}] — ${seg.role}: ${seg.label}`,
          at: seg.startTime,
        },
        ...(clicks.length
          ? [
              {
                kind: "click" as const,
                detail: `${clicks.length} interaction(s) in this beat`,
                at: clicks[0],
              },
            ]
          : []),
      ],
    });
  }

  // 2. High-attention camera moments — the peaks (clicks, reveals, results).
  for (const m of moments) {
    if (
      m.effectType !== "zoom" &&
      m.effectType !== "click-highlight" &&
      m.effectType !== "cursor-focus"
    ) {
      continue;
    }
    const score = clamp01(m.attentionScore ?? m.importance ?? 0.5);
    const clicks = clicksIn(m.startTime, m.endTime);
    candidates.push({
      id: `mom-${m.id}`,
      startTime: m.startTime,
      endTime: m.endTime,
      score,
      label: m.label || "Moment",
      role: m.narrativeRole,
      hasInteraction: clicks.length > 0 || m.targetRegionSource === "click-event",
      hasSpeech: speechAt(m.startTime, m.endTime),
      evidence: [
        {
          kind: "moment",
          ref: m.id,
          detail: `${m.effectType} — ${m.reason || m.label}`,
          at: m.startTime,
        },
        ...(m.confidenceSource
          ? [
              {
                kind: "click" as const,
                detail: `confidence source: ${m.confidenceSource}`,
                at: m.startTime,
              },
            ]
          : []),
      ],
    });
  }

  // 3. Spoken sentences — a demo's important claims live in the words, and a
  //    transcript segment is often the only evidence that a stretch matters.
  for (const seg of transcript?.segments ?? []) {
    const len = seg.endTime - seg.startTime;
    if (len < 0.8) continue;
    const attention = attentionOver(analysis, seg.startTime, seg.endTime);
    const clicks = clicksIn(seg.startTime, seg.endTime);
    candidates.push({
      id: `tr-${seg.id}`,
      startTime: seg.startTime,
      endTime: seg.endTime,
      score: clamp01(0.42 + 0.3 * attention + 0.2 * (clicks.length ? 1 : 0)),
      label: seg.text.slice(0, 60),
      hasInteraction: clicks.length > 0,
      hasSpeech: true,
      evidence: [
        {
          kind: "transcript",
          ref: seg.id,
          detail: `"${seg.text.slice(0, 90)}"`,
          at: seg.startTime,
        },
      ],
    });
  }

  candidates.sort((a, b) => a.startTime - b.startTime);

  return {
    projectId: project.id,
    title: project.title,
    durationSeconds: duration,
    sourceWidth: project.width ?? 0,
    sourceHeight: project.height ?? 0,
    videoType: project.selectedVideoType ?? "auto",
    hasTranscript,
    hasSpeech,
    hasInteractionData,
    hasAnalysis: (analysis?.detectedMoments?.length ?? 0) > 0,
    ...(transcript ? { transcript } : {}),
    narrative,
    moments,
    candidates,
    deadZones,
    deadSeconds,
    interactionTimes,
    ...(analysis?.summary ? { summary: analysis.summary } : {}),
  };
}

/**
 * A compact, token-cheap digest of the context for the model prompt. Times are
 * rounded to 0.1s — the model reasons about structure, and the executor clamps
 * every window against the real duration anyway, so full float precision here
 * would just burn tokens.
 */
export function describeContextForModel(ctx: DirectorVideoContext): string {
  const t = (n: number) => n.toFixed(1);
  const lines: string[] = [];

  lines.push(`VIDEO: "${ctx.title}" — ${t(ctx.durationSeconds)}s, type=${ctx.videoType}`);
  if (ctx.summary) lines.push(`SUMMARY: ${ctx.summary}`);
  lines.push(
    `SIGNALS: transcript=${ctx.hasTranscript} speech=${ctx.hasSpeech} interactions=${ctx.hasInteractionData} (${ctx.interactionTimes.length} clicks)`
  );

  if (ctx.narrative.length) {
    lines.push("\nNARRATIVE BEATS (already detected):");
    for (const s of ctx.narrative) {
      lines.push(`  ${t(s.startTime)}–${t(s.endTime)}s · ${s.role} · ${s.label}`);
    }
  }

  if (ctx.candidates.length) {
    lines.push("\nCANDIDATE MOMENTS (id · window · score · evidence):");
    for (const c of ctx.candidates.slice(0, 60)) {
      const flags = [
        c.hasInteraction ? "click" : "",
        c.hasSpeech ? "speech" : "",
      ]
        .filter(Boolean)
        .join("+");
      lines.push(
        `  ${c.id} · ${t(c.startTime)}–${t(c.endTime)}s · ${c.score.toFixed(2)}${
          flags ? ` · ${flags}` : ""
        } · ${c.label}`
      );
    }
  }

  if (ctx.deadZones.length) {
    lines.push(
      `\nDEAD ZONES (${t(ctx.deadSeconds)}s total removable — id · window · kind):`
    );
    for (const d of ctx.deadZones.slice(0, 40)) {
      lines.push(`  ${d.id} · ${t(d.startTime)}–${t(d.endTime)}s · ${d.kind} · ${d.reason}`);
    }
  }

  if (ctx.hasTranscript && ctx.transcript?.segments?.length) {
    lines.push("\nTRANSCRIPT:");
    for (const s of ctx.transcript.segments.slice(0, 120)) {
      lines.push(`  [${s.id}] ${t(s.startTime)}–${t(s.endTime)}s: ${s.text}`);
    }
  }

  return lines.join("\n");
}
