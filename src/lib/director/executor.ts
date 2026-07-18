/**
 * AI Director — timeline executor.
 *
 * The ONLY thing that turns a validated `DirectorPlan` into edits. Everything it
 * produces is an ordinary `DetectedMoment` on the ordinary timeline — the same
 * array the lanes render, the preview resolvers read (`resolveCameraFrame`,
 * `drawOutputOverlays`) and the export recipe serializes (`buildRenderRecipe`).
 *
 * There is no Director renderer, no Director preview path and no Director export
 * path, because there is no Director edit format: a Director zoom IS a zoom. That
 * is what makes preview/export parity structural instead of a thing to maintain,
 * and it's why the user can drag, resize, disable or delete any generated edit
 * with the tools they already have.
 *
 * IDEMPOTENCE: the executor always rebuilds from a base with every prior Director
 * moment stripped. Re-running the same request replaces its own edits instead of
 * stacking a second copy on top — so "Direct my video" twice is safe.
 *
 * PARTIAL FAILURE: each operation is compiled independently. One bad op is a
 * reported failure, never an aborted run.
 *
 * Pure: no Firebase, no DOM, no Gemini. Loadable by `node --test`.
 */
import type {
  DetectedMoment,
  EffectsSettings,
  OutputCanvas,
  SelectedVideoType,
  Transcript,
} from "../firebase/schema";
import { generateCaptionMoments } from "../analysis/caption-generator";
import { buildTimelineMap } from "../timeline/crop-speed";
import { resolveCanvasDims } from "../timeline/canvas-layout";
import {
  CATEGORY_SLOT,
  KIT_SLOT_CATEGORY,
  resolveDirectorPreset,
  selectPresetKit,
  textOverlayCategory,
  type DirectorPresetKit,
  type DirectorPresetSlot,
} from "../presets/director";
import { sanitizeAnimation } from "../presets/animation";
import { aspectOf, clampToSafeArea, resolvePresetStyle } from "../presets/layout";
import { PRESET_SCHEMA_VERSION, type FramevoPreset } from "../presets/types";
import {
  type DirectorAspect,
  type DirectorEditOperation,
  type DirectorEditType,
  type DirectorExecution,
  type DirectorFailure,
  type DirectorMomentRef,
  type DirectorPlan,
  type DirectorPresetChoice,
  type DirectorSummary,
} from "./types";

/** Prefix for every Director-created moment id. Makes stripping unambiguous. */
export const DIRECTOR_MOMENT_PREFIX = "dir_";

export interface ExecutePlanInput {
  plan: DirectorPlan;
  /** The CURRENT timeline (may already contain Director edits — they're replaced). */
  moments: DetectedMoment[];
  /** SOURCE duration in seconds. */
  duration: number;
  /** Which revision this execution belongs to (0 = the initial run). */
  revision: number;
  transcript?: Transcript | null;
  videoType?: SelectedVideoType;
  sourceWidth?: number;
  sourceHeight?: number;
  /** Current effects — read only, to preserve fit/background choices. */
  effects?: EffectsSettings;
}

/** True when this moment was made by the AI Director. */
export function isDirectorMoment(m: Pick<DetectedMoment, "id" | "source">): boolean {
  return m.source === "ai-director" || m.id.startsWith(DIRECTOR_MOMENT_PREFIX);
}

/**
 * The timeline with every Director edit removed — i.e. everything the user made,
 * plus every edit the ordinary analysis engines produced. This is the base every
 * execution builds on, which is what makes re-running idempotent AND what
 * guarantees a Director run never destroys a user's manual work.
 */
export function withoutDirectorMoments(moments: DetectedMoment[]): DetectedMoment[] {
  return moments.filter((m) => !isDirectorMoment(m));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function round(v: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

function mergeRanges(
  ranges: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .slice()
    .sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

const FULL_REGION = { x: 0, y: 0, width: 1, height: 1 };

/** The Director's aspect vocabulary → the preset library's. 4:5 reads as square. */
function presetAspectFor(
  aspect: DirectorAspect | undefined
): "16:9" | "9:16" | "1:1" {
  if (aspect === "9:16") return "9:16";
  if (aspect === "1:1" || aspect === "4:5") return "1:1";
  return "16:9";
}

/**
 * Dress a Director-made edit in a library preset.
 *
 * The Director does NOT invent typography. It picks from the validated preset
 * registry (see presets/director.ts — an unknown id is rejected, never coerced),
 * and this bakes the chosen look onto the moment as a resolved `textStyle` +
 * `animation`, adapted to the target aspect ratio and pulled inside the
 * platform's safe area.
 *
 * The result is an ordinary preset-styled moment — indistinguishable from one
 * the user applied by hand, and just as editable.
 */
function dressWithPreset(
  moment: DetectedMoment,
  preset: FramevoPreset | undefined,
  aspect: "16:9" | "9:16" | "1:1"
): DetectedMoment {
  if (!preset) return moment;
  const style = clampToSafeArea(resolvePresetStyle(preset, aspect), aspect);
  const anim = sanitizeAnimation(preset.animation);
  return {
    ...moment,
    textStyle: { ...(moment.textStyle ?? {}), ...style },
    ...(anim ? { animation: anim } : {}),
    preset: { id: preset.id, version: PRESET_SCHEMA_VERSION },
    ...(preset.effectType === "transition" && preset.transitionStyle
      ? { transition: { style: preset.transitionStyle } }
      : {}),
  };
}

/** Director aspect → the `OutputCanvas` the export pipeline already understands. */
function canvasForAspect(
  aspect: DirectorAspect,
  sourceWidth: number,
  sourceHeight: number,
  current: OutputCanvas | undefined
): OutputCanvas {
  const sw = sourceWidth > 0 ? sourceWidth : 1920;
  const sh = sourceHeight > 0 ? sourceHeight : 1080;
  const dims = resolveCanvasDims(sw, sh, aspect, "1080p");
  return {
    aspectRatio: aspect,
    width: dims.canvasW,
    height: dims.canvasH,
    // Preserve the user's fit/background choices if they already made one —
    // the Director is changing the ASPECT, not overruling how they want the
    // frame filled.
    fitMode: current?.fitMode ?? "smart-fit",
    scale: current?.scale ?? 1,
    offsetX: current?.offsetX ?? 0,
    offsetY: current?.offsetY ?? 0,
    backgroundMode: current?.backgroundMode ?? "blur",
    ...(current?.backgroundColor ? { backgroundColor: current.backgroundColor } : {}),
  };
}

/**
 * Compile one edit operation into a real `DetectedMoment`.
 * Throws on anything it can't build — the caller turns that into a failure.
 */
function compileEditOperation(
  op: DirectorEditOperation,
  ref: DirectorMomentRef,
  id: string
): DetectedMoment {
  const base: DetectedMoment = {
    id,
    startTime: round(op.startTime),
    endTime: round(op.endTime),
    label: labelFor(op.editType),
    // The reason shows up on the edit itself in the inspector — the user can
    // always see WHY the Director did this.
    reason: op.reason,
    focusRegion: op.focusRegion ?? { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
    effectType: op.editType,
    source: "ai-director",
    provenance: "ai",
    director: ref,
    confidenceScore: clamp01(op.confidence),
    attentionScore: clamp01(op.priority),
    ...(op.intensity !== undefined ? { intensity: clamp01(op.intensity) } : {}),
  };

  switch (op.editType) {
    case "zoom":
    case "click-highlight":
    case "cursor-focus":
      return {
        ...base,
        intensity: clamp01(op.intensity ?? 0.7),
        targetRegionSource: op.focusRegion ? "ai-proposal" : "default",
      };

    case "cut":
      return { ...base, focusRegion: FULL_REGION, cut: { active: true } };

    case "speed-up": {
      const mult = op.params?.speedMultiplier;
      if (!(typeof mult === "number" && mult > 1)) {
        throw new Error("speed-up requires a multiplier greater than 1×");
      }
      return {
        ...base,
        focusRegion: FULL_REGION,
        speed: { multiplier: mult, audioMode: "pitch-correct", transition: "cut" },
      };
    }

    case "hook-text": {
      const text = op.params?.text?.trim();
      if (!text) throw new Error("hook-text requires text");
      return {
        ...base,
        focusRegion: FULL_REGION,
        enabled: true,
        hookText: {
          text,
          stylePreset: "bold",
          position: "center",
          animation: "pop",
        },
      };
    }

    case "text-overlay": {
      const text = op.params?.text?.trim();
      if (!text) throw new Error("text-overlay requires text");
      return {
        ...base,
        focusRegion: FULL_REGION,
        enabled: true,
        textOverlay: {
          text,
          position: "bottom-center",
          size: "medium",
          alignment: "center",
          backgroundStyle: "pill",
          animation: "fade",
        },
      };
    }

    case "callout": {
      const text = op.params?.text?.trim();
      if (!text) throw new Error("callout requires text");
      return {
        ...base,
        enabled: true,
        callout: { text, style: op.params?.calloutStyle ?? "box" },
      };
    }

    case "transition":
      return {
        ...base,
        focusRegion: FULL_REGION,
        enabled: true,
        transition: { style: op.params?.transitionStyle ?? "fade" },
      };

    case "branding-cta": {
      const ctaText = op.params?.ctaText?.trim();
      if (!ctaText) throw new Error("branding-cta requires text");
      return {
        ...base,
        focusRegion: FULL_REGION,
        enabled: true,
        brandingCta: {
          ctaText,
          position: "bottom-center",
          stylePreset: "social",
        },
      };
    }

    case "smart-crop": {
      const aspect = op.params?.aspectRatio ?? "9:16";
      return {
        ...base,
        focusRegion: FULL_REGION,
        enabled: true,
        smartCrop: {
          aspectRatio: aspect,
          focusTarget: op.params?.focusTarget ?? "motion",
        },
      };
    }

    case "captions":
      // Captions are NEVER compiled one-at-a-time — they come from the real
      // transcript via `generateCaptionMoments` so their timings are the ASR's,
      // not the model's guess. A plan asking for a single caption moment is a
      // planning bug, and saying so beats silently inventing a line of dialogue.
      throw new Error(
        "captions are generated from the transcript, not as individual operations"
      );

    default: {
      const never: never = op.editType;
      throw new Error(`unsupported edit type: ${String(never)}`);
    }
  }
}

const LABELS: Record<DirectorEditType, string> = {
  zoom: "Zoom",
  "click-highlight": "Click",
  "cursor-focus": "Focus",
  "speed-up": "Speed up",
  cut: "Cut",
  captions: "Caption",
  "hook-text": "Hook",
  "text-overlay": "Text",
  callout: "Callout",
  transition: "Transition",
  "branding-cta": "CTA",
  "smart-crop": "Smart crop",
};

function labelFor(t: DirectorEditType): string {
  return LABELS[t] ?? "Edit";
}

/**
 * Execute a VALIDATED plan.
 *
 * Pass a plan through `validateDirectorPlan` first — this function trusts that
 * windows are in bounds and edit types are allowlisted, and only guards against
 * compile-time failures (missing params) it can attribute to a single op.
 */
export function executePlan(input: ExecutePlanInput): DirectorExecution {
  const { plan, duration, revision } = input;
  const failures: DirectorFailure[] = [];
  const appliedOperationIds: string[] = [];
  const created: DetectedMoment[] = [];

  const base = withoutDirectorMoments(input.moments);

  // ── The preset kit ───────────────────────────────────────────────────────
  // The Director dresses every styled edit in a design from the VALIDATED preset
  // registry. Two ways a slot gets filled, in this order:
  //
  //   1. The plan NAMED an id (`params.presetId`). The planner read the real
  //      catalogue, so this is the model choosing from the library rather than
  //      describing a look we'd then have to invent. The id goes through
  //      `resolveDirectorPreset` — the hard gate. An id that isn't in the
  //      registry, or is in the wrong category, is REPORTED and dropped.
  //   2. Nothing named, or the name was rejected → the deterministic scorer picks
  //      on the axes the plan already carries (tone, platform, aspect, type).
  //
  // Either way the look that reaches the timeline is a real registry entry, so a
  // hallucinated design cannot be applied — it can only be reported.
  const presetAspect = presetAspectFor(plan.aspectRatio);

  /** Which kit slot an operation draws its look from. */
  const slotForOp = (op: DirectorEditOperation): DirectorPresetSlot | null => {
    switch (op.editType) {
      case "hook-text":
        return "hook";
      case "branding-cta":
        return "cta";
      case "transition":
        return "transition";
      case "callout":
        return "callout";
      case "text-overlay": {
        // One effect type, four design jobs — resolved from the story section the
        // plan already assigned, so intros/outros/titles/text-animations are all
        // reachable without asking the model to re-state what it already said.
        const kind = plan.storyStructure.find((s) => s.id === op.sectionId)?.kind;
        // `CATEGORY_SLOT` is total over `PresetCategory`, so this always resolves.
        return CATEGORY_SLOT[
          textOverlayCategory({
            sectionKind: kind,
            durationSeconds: Math.max(0, op.endTime - op.startTime),
          })
        ];
      }
      default:
        return null;
    }
  };

  // Resolve every id the plan named, through the gate, before choosing anything.
  const pinned: Partial<Record<DirectorPresetSlot, FramevoPreset>> = {};
  const pinRequested = (
    slot: DirectorPresetSlot,
    id: string | undefined,
    subject: string,
    operationId: string
  ) => {
    if (!id || pinned[slot]) return;
    const resolved = resolveDirectorPreset(id, KIT_SLOT_CATEGORY[slot]);
    if (resolved.preset) {
      pinned[slot] = resolved.preset;
      return;
    }
    // The plan asked for a design that doesn't exist. Say so — do NOT quietly
    // swap in "something close", which is how an AI feature stops being trusted.
    failures.push({
      operationId,
      subject,
      reason: "unknown_preset",
      detail: resolved.detail ?? `"${id}" is not a preset in Framevo's library.`,
    });
  };

  for (const op of plan.editOperations) {
    const slot = slotForOp(op);
    if (slot) pinRequested(slot, op.params?.presetId, `${op.editType} design`, op.id);
  }
  pinRequested(
    "captions",
    plan.captionInstructions.presetId,
    "caption design",
    "captions"
  );

  const wanted = (slot: DirectorPresetSlot) =>
    plan.editOperations.some((o) => slotForOp(o) === slot);

  const kit: DirectorPresetKit = selectPresetKit({
    tone: (plan.tone as never) ?? undefined,
    platform: plan.platform,
    aspect: presetAspect,
    videoType: input.videoType,
    wantCaptions: plan.captionInstructions.enabled,
    wantHook: wanted("hook"),
    wantCta: wanted("cta"),
    wantTransitions: wanted("transition"),
    wantTitle: wanted("title"),
    wantCallout: wanted("callout"),
    wantIntro: wanted("intro"),
    wantOutro: wanted("outro"),
    wantTextAnimation: wanted("textAnimation"),
    pinned,
  });

  /** How many moments ended up wearing each slot's look — reported to the user. */
  const presetUse = new Map<DirectorPresetSlot, number>();
  const noteUse = (slot: DirectorPresetSlot | null) => {
    if (!slot || !kit[slot]) return;
    presetUse.set(slot, (presetUse.get(slot) ?? 0) + 1);
  };

  const ref = (
    operationId: string,
    sectionId?: string,
    justification?: DirectorMomentRef["justification"]
  ): DirectorMomentRef => ({
    operationId,
    planVersion: plan.planVersion,
    revision,
    ...(sectionId ? { sectionId } : {}),
    ...(justification ? { justification } : {}),
  });

  // Deterministic ids: same plan + same revision ⇒ same moment ids. This is what
  // makes a retry a replace rather than a duplicate.
  const momentId = (opId: string) => `${DIRECTOR_MOMENT_PREFIX}${revision}_${opId}`;

  // ── 1. Cuts: clip removals + trims + audio removals ──────────────────────
  // Everything that shortens the video funnels into ONE mechanism: `cut`
  // moments. `buildTimelineMap` already honors them everywhere (preview seek,
  // browser export, Cloud Run worker, Remotion), so "remove the boring parts"
  // genuinely shortens the exported file rather than just dimming the timeline.
  const removalRanges: Array<{ start: number; end: number }> = [];

  for (const op of plan.clipOperations) {
    if (op.kind !== "remove" && op.kind !== "trim") continue;
    try {
      const id = momentId(op.id);
      created.push({
        id,
        startTime: round(op.startTime),
        endTime: round(op.endTime),
        label: "Cut",
        reason: op.reason,
        focusRegion: FULL_REGION,
        effectType: "cut",
        cut: { active: true },
        source: "ai-director",
        provenance: "ai",
        director: ref(op.id, op.sectionId),
        confidenceScore: clamp01(op.confidence),
        attentionScore: clamp01(1 - op.confidence),
      });
      removalRanges.push({ start: op.startTime, end: op.endTime });
      appliedOperationIds.push(op.id);
    } catch (err) {
      failures.push({
        operationId: op.id,
        subject: `clip ${op.kind}`,
        reason: "executor_error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let pausesRemoved = 0;
  for (const op of plan.audioOperations) {
    if (op.kind === "keep-audio") continue;
    // Already covered by a clip removal — don't stack a second cut on the same
    // seconds (it would double-count in the summary and clutter the lane).
    if (removalRanges.some((r) => overlaps(r.start, r.end, op.startTime, op.endTime))) {
      continue;
    }
    try {
      created.push({
        id: momentId(op.id),
        startTime: round(op.startTime),
        endTime: round(op.endTime),
        label: op.kind === "remove-filler" ? "Filler" : "Silence",
        reason: op.reason,
        focusRegion: FULL_REGION,
        effectType: "cut",
        cut: { active: true },
        source: "ai-director",
        provenance: "ai",
        director: ref(op.id, op.sectionId),
        confidenceScore: clamp01(op.confidence),
      });
      removalRanges.push({ start: op.startTime, end: op.endTime });
      appliedOperationIds.push(op.id);
      pausesRemoved += 1;
    } catch (err) {
      failures.push({
        operationId: op.id,
        subject: `audio ${op.kind}`,
        reason: "executor_error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const removed = mergeRanges(removalRanges);
  /** True when t survives to the output (isn't inside an active cut). */
  const survives = (start: number, end: number): boolean =>
    !removed.some((r) => start >= r.start - 0.001 && end <= r.end + 0.001);

  // ── 2. Edit operations ───────────────────────────────────────────────────
  let outputCanvas: OutputCanvas | undefined;

  for (const op of plan.editOperations) {
    try {
      // An overlay entirely inside removed time can never render. Emitting it
      // would inflate the summary ("added 6 zooms") with edits the viewer will
      // never see. Skipping it silently is fine — it isn't a failure, it's a
      // consequence of the cut plan, and the count stays honest.
      if (op.editType !== "smart-crop" && !survives(op.startTime, op.endTime)) {
        continue;
      }

      const compiled = compileEditOperation(
        op,
        ref(op.id, op.sectionId, op.justification),
        momentId(op.id)
      );

      // Dress it in the library preset chosen for this slot. The preset supplies
      // the typography + motion; the Director supplies the copy, the timing and
      // the reason. Neither invents the other's half.
      //
      // EVERY styled edit type routes through the slot map — hook, CTA,
      // transition, callout AND text-overlay (which resolves to intro / outro /
      // title / text-animation by story position). An edit type with no slot
      // (zoom, cut, speed-up, …) has no design to wear and is used as compiled.
      const slot = slotForOp(op);
      const dressed = slot ? dressWithPreset(compiled, kit[slot], presetAspect) : compiled;
      noteUse(slot);

      created.push(dressed);
      appliedOperationIds.push(op.id);

      // Smart crop drives the real output canvas — the same field the Canvas
      // panel writes — so preview and export both reframe. The moment is the
      // timeline record of it; the canvas is what actually renders.
      if (op.editType === "smart-crop") {
        const aspect = (op.params?.aspectRatio ?? plan.aspectRatio ?? "9:16") as DirectorAspect;
        outputCanvas = canvasForAspect(
          aspect,
          input.sourceWidth ?? 0,
          input.sourceHeight ?? 0,
          input.effects?.outputCanvas
        );
      }
    } catch (err) {
      failures.push({
        operationId: op.id,
        subject: op.editType,
        reason: "missing_params",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 3. Captions — from the REAL transcript, never invented ───────────────
  let captionCount = 0;
  if (plan.captionInstructions.enabled) {
    const transcript = input.transcript;
    if (!transcript || transcript.status !== "complete" || !transcript.segments?.length) {
      failures.push({
        operationId: "captions",
        subject: "captions",
        reason: "no_transcript",
        detail:
          "Captions were requested but this project has no completed transcript. Framevo won't invent caption text — generate a transcript first, then ask the Director for captions.",
      });
    } else {
      const gen = generateCaptionMoments(
        transcript,
        input.videoType ?? "auto",
        {
          stylePreset: plan.captionInstructions.stylePreset,
          position: plan.captionInstructions.position,
        }
      );
      for (const c of gen.moments) {
        // Drop captions whose whole line falls inside removed time — they'd
        // never display, and counting them would overstate what was done.
        if (!survives(c.startTime, c.endTime)) continue;

        const caption: DetectedMoment = {
          ...c,
          id: `${DIRECTOR_MOMENT_PREFIX}${revision}_${c.id}`,
          source: "ai-director",
          provenance: "ai",
          director: ref(`caption:${c.id}`),
          // The concrete look "energetic" / "professional" resolves to. Merged
          // over the legacy preset so the shared TextStyle resolver
          // (defaults ← legacy ← textStyle) renders it identically in preview
          // and export.
          ...(plan.captionInstructions.textStyle
            ? { textStyle: plan.captionInstructions.textStyle }
            : {}),
        };

        // A caption preset from the library wins over the plan's raw textStyle:
        // it is a designed, aspect-adapted, safe-area-clamped look, where the
        // plan's is only a style hint. It also brings the motion (pop, karaoke
        // reveal) the plan has no way to express.
        created.push(dressWithPreset(caption, kit.captions, presetAspect));
        noteUse("captions");
        captionCount += 1;
      }
      if (gen.truncated) {
        failures.push({
          operationId: "captions",
          subject: "captions",
          reason: "executor_error",
          detail:
            "The transcript produced more caption lines than a project document can hold; the captions were truncated.",
        });
      }
    }
  }

  const moments = [...base, ...created].sort((a, b) => a.startTime - b.startTime);

  // ── 4. Summary — computed from the REAL timeline map, not from intentions ─
  // `buildTimelineMap` is the same function the export uses to decide output
  // duration. Deriving the summary from it means the number we show the user is
  // the number of seconds the exported file will actually have.
  const map = buildTimelineMap(moments, duration);

  const counts: Partial<Record<DirectorEditType, number>> = {};
  for (const m of created) {
    const t = m.effectType as DirectorEditType;
    counts[t] = (counts[t] ?? 0) + 1;
  }

  const hookMoment = created.find((m) => m.effectType === "hook-text");
  const hookSeconds = hookMoment ? hookMoment.endTime - hookMoment.startTime : 0;

  // ── The designs that actually landed ─────────────────────────────────────
  // Reported from `presetUse`, which counts moments that were really dressed —
  // NOT from the kit, which is only what we intended to use. A slot whose edits
  // all fell inside removed time contributed nothing, and claiming it did would
  // be the same quiet lie the summary recount exists to prevent.
  const presets: DirectorPresetChoice[] = [];
  for (const [slot, momentCount] of presetUse) {
    const preset = kit[slot];
    if (!preset || momentCount <= 0) continue;
    presets.push({
      slot,
      category: preset.category,
      presetId: preset.id,
      presetName: preset.name,
      chosenBy: pinned[slot]?.id === preset.id ? "plan" : "scorer",
      momentCount,
    });
  }
  presets.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));

  const summary: DirectorSummary = {
    sourceDurationSeconds: duration,
    outputDurationSeconds: map.outputDuration,
    removedSeconds: map.totalRemoved,
    pausesRemoved,
    hookSeconds,
    sectionsCreated: plan.storyStructure.length,
    counts,
    ...(presets.length ? { presets } : {}),
    lines: summaryLines({
      duration,
      output: map.outputDuration,
      pausesRemoved,
      hookSeconds,
      captionCount,
      counts,
    }),
  };

  return {
    moments,
    ...(outputCanvas ? { outputCanvas } : {}),
    appliedOperationIds,
    failures,
    summary,
  };
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

/**
 * The bullets the panel shows. Every line is derived from what actually landed
 * on the timeline — an edit type with a zero count produces no line, so the
 * summary can never claim work that wasn't done.
 */
function summaryLines(input: {
  duration: number;
  output: number;
  pausesRemoved: number;
  hookSeconds: number;
  captionCount: number;
  counts: Partial<Record<DirectorEditType, number>>;
}): string[] {
  const lines: string[] = [];
  const { duration, output, pausesRemoved, hookSeconds, counts } = input;

  if (output > 0 && Math.abs(duration - output) > 0.5) {
    lines.push(`Reduced video from ${fmtClock(duration)} to ${fmtClock(output)}`);
  }
  if (pausesRemoved > 0) {
    lines.push(`Removed ${pausesRemoved} pause${pausesRemoved === 1 ? "" : "s"}`);
  }
  if (hookSeconds > 0) {
    lines.push(`Created a ${hookSeconds.toFixed(0)}-second hook`);
  }

  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;

  if (counts.captions) lines.push(`Added ${plural(counts.captions, "caption", "captions")}`);
  if (counts.zoom) lines.push(`Added ${plural(counts.zoom, "zoom", "zooms")}`);
  if (counts.callout) lines.push(`Added ${plural(counts.callout, "callout", "callouts")}`);
  if (counts["text-overlay"]) {
    lines.push(`Added ${plural(counts["text-overlay"], "text overlay", "text overlays")}`);
  }
  if (counts["speed-up"]) {
    lines.push(`Sped up ${plural(counts["speed-up"], "section", "sections")}`);
  }
  if (counts.transition) {
    lines.push(`Added ${plural(counts.transition, "transition", "transitions")}`);
  }
  if (counts["smart-crop"]) lines.push("Reframed the canvas");
  if (counts["branding-cta"]) lines.push("Added a final CTA");

  return lines;
}
