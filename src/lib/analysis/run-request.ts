/**
 * THE canonical analysis run-request builder (Framevo AI unification, 2A).
 *
 * Every full analysis / re-analysis — the Framevo AI panel's "Edit video", a
 * chat message that re-directs the whole video, the (transitional) options
 * dialog — builds its request HERE. Before this module existed the chat path
 * ran `DEFAULT_ANALYSIS_OPTIONS`, silently ignoring the user's persisted
 * engine preferences, last-run toggles and chunk detail that the dialog path
 * resolved; two entry points produced two different runs. Now: same project +
 * same setup + same instruction ⇒ same request, whoever asked
 * (tests/run-request.test.ts pins it).
 *
 * ── Natural language is a DELTA, not a replacement ───────────────────────────
 * `mergeInstructionIntoBrief` is the other half of the fix. The old chat path
 * saved `saveDirectorBrief(command, {})` — wiping every structured field the
 * user had set. Here an instruction PRESERVES the structured form and touches a
 * field only when the message is confidently explicit about it, using the same
 * per-field parsers the server runs:
 *
 *   "Make it about 60 seconds"      → targetDurationSeconds changes
 *   "Make this vertical for TikTok" → aspectRatio + platform change
 *   "Don't add captions"            → captionStyle changes
 *   "Focus more on authentication"  → NO structured field changes
 *
 * Pure. No I/O, no React — loadable under `node --test`.
 */
import {
  DEFAULT_ANALYSIS_OPTIONS,
  type AnalysisOptions,
  type ExistingEditMode,
} from "./engine-layers";
import {
  recipeGenerationDefaults,
  resolveInitialGenerationToggles,
  type CoreGenerationPrefs,
  type GenerationToggles,
} from "./edit-recipe";
import { normalizeSelectedVideoType } from "./video-type";
import {
  CHUNK_MODE_SIZES,
  CHUNK_SIZE_MAX_S,
  CHUNK_SIZE_MIN_S,
  CHUNK_SIZE_S,
  type ChunkMode,
} from "./chunk-config";
import {
  parseAspect,
  parseCaptionStyle,
  parseCta,
  parseGoal,
  parsePlatform,
  parseStyle,
  parseTargetDuration,
  type DirectorRequestForm,
} from "@/lib/director/request";
import { hasDirectorBrief, type DirectorBrief } from "@/lib/director/types";
import type { SelectedVideoType } from "@/lib/firebase/schema";

/** The project fields the builder reads. A ProjectDoc satisfies this. */
export interface RunRequestProjectSlice {
  selectedVideoType?: SelectedVideoType;
  editingTemplateId?: string;
  directorBrief?: DirectorBrief | null;
  analysis?: {
    lastRunOptions?: Partial<AnalysisOptions> | null;
  } | null;
}

/** The per-user workspace settings the builder reads. */
export interface RunRequestWorkspaceSlice {
  analysisEngines?: Partial<CoreGenerationPrefs> | null;
  analysisDetail?: {
    chunkMode?: ChunkMode;
    chunkSizeSeconds?: number;
  } | null;
}

export interface BuildRunRequestInput {
  project: RunRequestProjectSlice;
  workspace?: RunRequestWorkspaceSlice | null;
  /**
   * Explicit choices for THIS run — setup/advanced controls, or the
   * (transitional) dialog's resolved state. Only keys actually present
   * override; everything else resolves from project + workspace exactly as the
   * dialog always seeded itself.
   */
  overrides?: Partial<AnalysisOptions>;
  /**
   * The user's free-text instruction for this run (the Framevo AI composer).
   * Merged into the brief as a DELTA — see `mergeInstructionIntoBrief`.
   */
  instruction?: string;
  /** Structured brief-form changes made through setup controls this run. */
  briefForm?: DirectorRequestForm;
  /** Plan mode: the run proposes instead of applying (Instant/Plan switch). */
  planOnly?: boolean;
  now?: number;
}

export interface AnalysisRunRequest {
  /** The options to hand to `startAnalyze` — complete and captions-stripped. */
  options: AnalysisOptions;
  /**
   * The brief this run should execute under, or null when there is none.
   * When `briefChanged` is true the caller MUST persist it (await
   * `saveDirectorBrief`) BEFORE starting the run — the analyze route reads the
   * brief off the document, and a failed write must stop the run.
   */
  brief: DirectorBrief | null;
  briefChanged: boolean;
  /**
   * True when camera + cuts + speed all resolved off. The run is still legal,
   * but surfaces should say so — the dialog historically blocked on this
   * ("Turn on at least one of Zooms & focus, Cuts, or Speed").
   */
  coreEnginesOff: boolean;
}

/**
 * Merge a free-text instruction into an existing brief.
 *
 * The prompt becomes the instruction (that is what this run is being asked to
 * do); the structured form is PRESERVED, then updated only by (a) explicit
 * control changes passed as `explicitForm`, and (b) fields the instruction is
 * confidently explicit about, via the same conservative parsers the server
 * uses. A parser returning undefined means "the message didn't say" — the
 * existing value stands.
 */
export function mergeInstructionIntoBrief(
  existing: DirectorBrief | null | undefined,
  instruction: string,
  explicitForm?: DirectorRequestForm,
  now?: number
): DirectorBrief {
  const text = instruction.trim();
  const base: DirectorRequestForm = { ...(existing?.form ?? {}) };

  // (a) Explicit control changes — the user touched a setup field.
  const withControls: DirectorRequestForm = { ...base, ...(explicitForm ?? {}) };

  // (b) Confident extractions from the instruction — only defined results land.
  const merged: DirectorRequestForm = { ...withControls };
  if (text.length > 0) {
    const duration = parseTargetDuration(text);
    if (duration !== undefined) merged.targetDurationSeconds = duration;
    const platform = parsePlatform(text);
    if (platform !== undefined) merged.platform = platform;
    const aspect = parseAspect(text);
    if (aspect !== undefined) merged.aspectRatio = aspect;
    const style = parseStyle(text);
    if (style !== undefined) merged.style = style;
    const captionStyle = parseCaptionStyle(text);
    if (captionStyle !== undefined) merged.captionStyle = captionStyle;
    const cta = parseCta(text);
    if (cta !== undefined) merged.cta = cta;
    const goal = parseGoal(text);
    if (goal !== undefined) merged.goal = goal;
  }

  return {
    prompt: text.length > 0 ? text : (existing?.prompt ?? ""),
    form: merged,
    updatedAt: now ?? Date.now(),
  };
}

const sameForm = (a: DirectorRequestForm, b: DirectorRequestForm): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Build the one canonical run request. */
export function buildAnalysisRunRequest(input: BuildRunRequestInput): AnalysisRunRequest {
  const { project } = input;
  const overrides = input.overrides ?? {};
  const workspace = input.workspace ?? {};
  const lastRun = project.analysis?.lastRunOptions ?? undefined;

  const selectedVideoType = normalizeSelectedVideoType(
    overrides.selectedVideoType ?? project.selectedVideoType
  );

  // Toggle resolution — EXACTLY the dialog's historical seeding: core engines
  // last run → per-user prefs → recipe default; overlays last run → recipe
  // default; then this run's explicit choices on top.
  const seeded = resolveInitialGenerationToggles({
    recipeDefaults: recipeGenerationDefaults(selectedVideoType),
    lastRun,
    corePrefs: workspace.analysisEngines ?? undefined,
  });
  const toggle = <K extends keyof GenerationToggles>(key: K): boolean =>
    (overrides[key] as boolean | undefined) ?? seeded[key];

  // Chunk detail: this run's choice → last run → per-user preference → default.
  const chunkMode: ChunkMode =
    overrides.chunkMode ?? lastRun?.chunkMode ?? workspace.analysisDetail?.chunkMode ?? "balanced";
  const clampSize = (s: number) =>
    Math.min(CHUNK_SIZE_MAX_S, Math.max(CHUNK_SIZE_MIN_S, Math.round(s)));
  const chunkSizeSeconds = clampSize(
    overrides.chunkSizeSeconds ??
      (chunkMode === "custom"
        ? (lastRun?.chunkSizeSeconds ??
          workspace.analysisDetail?.chunkSizeSeconds ??
          CHUNK_SIZE_S)
        : (CHUNK_MODE_SIZES[chunkMode] ?? CHUNK_SIZE_S))
  );

  const existingEditMode: ExistingEditMode = overrides.existingEditMode ?? "replace-selected";

  // The brief. An instruction or explicit form change produces a merged brief;
  // otherwise the project's saved brief runs as-is (or nothing does).
  const hasDelta =
    (input.instruction ?? "").trim().length > 0 ||
    (input.briefForm !== undefined && Object.keys(input.briefForm).length > 0);
  const existingBrief = project.directorBrief ?? null;
  const brief = hasDelta
    ? mergeInstructionIntoBrief(existingBrief, input.instruction ?? "", input.briefForm, input.now)
    : existingBrief;
  const briefChanged =
    hasDelta &&
    (!existingBrief ||
      existingBrief.prompt !== (brief?.prompt ?? "") ||
      !sameForm(existingBrief.form ?? {}, brief?.form ?? {}));

  const options: AnalysisOptions = {
    ...DEFAULT_ANALYSIS_OPTIONS,
    generateCameraEdits: toggle("generateCameraEdits"),
    generateCut: toggle("generateCut"),
    generateSpeed: toggle("generateSpeed"),
    generateHookText: toggle("generateHookText"),
    generateTextOverlays: toggle("generateTextOverlays"),
    generateSmartCrop: toggle("generateSmartCrop"),
    generateCallouts: toggle("generateCallouts"),
    generateTransitions: toggle("generateTransitions"),
    generateCta: toggle("generateCta"),
    selectedVideoType,
    existingEditMode,
    chunkMode,
    chunkSizeSeconds,
    ...(overrides.chunkCount !== undefined ? { chunkCount: overrides.chunkCount } : {}),
    // Conditional spread — the options object is persisted verbatim as
    // `lastRunOptions`, and Firestore rejects `undefined` values.
    ...((overrides.templateId ?? project.editingTemplateId) !== undefined
      ? { templateId: overrides.templateId ?? project.editingTemplateId }
      : {}),
    applyDirectorBrief:
      overrides.applyDirectorBrief ?? (brief ? hasDirectorBrief(brief) : false),
    directorPlanOnly: input.planOnly === true,
    ...(overrides.transcriptLanguageMode !== undefined
      ? { transcriptLanguageMode: overrides.transcriptLanguageMode }
      : {}),
    ...(overrides.transcriptLanguageCode !== undefined
      ? { transcriptLanguageCode: overrides.transcriptLanguageCode }
      : {}),
    ...(overrides.transcriptLocaleHint !== undefined
      ? { transcriptLocaleHint: overrides.transcriptLocaleHint }
      : {}),
  };
  // THE CAPTION SEPARATION RULE: analysis can never start ASR. The dialog
  // stripped this from its payload; the builder makes it structural for every
  // entry point (tests/caption-separation pins the concept; run-request tests
  // pin this line).
  delete options.generateCaptions;

  return {
    options,
    brief,
    briefChanged,
    coreEnginesOff:
      !options.generateCameraEdits && !options.generateCut && !options.generateSpeed,
  };
}
