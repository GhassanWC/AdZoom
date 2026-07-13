/**
 * The Smart Clips GENERATION FLOW — everything that happens between the user
 * clicking "Generate Smart Clips" and clips appearing in the panel, with no
 * React and no Firestore in sight.
 *
 * The editor context owns the React state and the Firestore write; this owns the
 * decisions:
 *   • one run at a time      — a second click while a run is in flight is a
 *                              no-op, so clips can never be double-written
 *   • never a silent empty   — a run that produces no clips always comes back
 *                              with the REASON (see ClipGenReasonCode)
 *   • never wipe on empty    — an empty/failed run leaves existing clips alone
 *   • regenerate preserves   — completed exports ride across a regenerate when
 *                              the new clip covers the same window
 *   • counts-only telemetry  — the six clips_* events carry durations and
 *                              counts, never transcript text or clip titles
 *
 * Pure + injected deps → tests/clip-generation.test.ts drives the whole flow
 * with a fake writer and a recording emitter.
 */

import type { GeneratedClip } from "@/lib/firebase/schema";
import {
  clipGenMessage,
  generateClipsDetailed,
  type ClipGenInput,
  type ClipGenReasonCode,
} from "./clip-generator";
import { preserveCompletedExports } from "./clip-export-status";

/** The six debug/analytics events for a generation run. */
export type ClipGenEventName =
  | "clips_generate_clicked"
  | "clips_generation_started"
  | "clips_generation_completed"
  | "clips_generation_empty"
  | "clips_generation_failed"
  | "clips_generation_fallback_used";

/** Counts only — asserted by tests, so a leak of user content fails the build. */
export type ClipGenEventPayload = Record<string, number | boolean | string>;

export type ClipGenRunStatus = "generated" | "empty" | "failed" | "busy";

export interface ClipGenerationResult {
  status: ClipGenRunStatus;
  /** Clips now persisted (0 for empty/failed/busy). */
  count: number;
  fallbackUsed: boolean;
  /** Why — null only for `busy`. */
  reasonCode: ClipGenReasonCode | null;
  /** The exact sentence the panel shows. */
  message: string;
  /** Raw failure text, for the console + a details line. Never logged upstream. */
  error?: string;
}

export type ClipGenMode = "generate" | "regenerate";
export type ClipGenTrigger = "user" | "auto";

export interface ClipGenerationDeps {
  /** The analysis signals to cut from, read fresh at run time. */
  buildInput: () => ClipGenInput;
  /** Clips currently persisted (regenerate preserves their completed exports). */
  readClips: () => GeneratedClip[];
  writeClips: (clips: GeneratedClip[]) => Promise<void>;
  /**
   * Has the analysis finished? The ONLY hard prerequisite — everything else
   * (transcript, attention curve, moments) is optional and degrades to a
   * fallback rather than blocking.
   */
  isAnalyzed: () => boolean;
  emit?: (event: ClipGenEventName, payload: ClipGenEventPayload) => void;
  /** Called with `true` when a run starts and `false` when it settles. */
  onRunningChange?: (running: boolean) => void;
}

export interface ClipGenerationController {
  isRunning(): boolean;
  run(opts?: { mode?: ClipGenMode; trigger?: ClipGenTrigger }): Promise<ClipGenerationResult>;
}

export function createClipGenerationController(
  deps: ClipGenerationDeps
): ClipGenerationController {
  let running = false;
  const emit = (event: ClipGenEventName, payload: ClipGenEventPayload) => {
    try {
      deps.emit?.(event, payload);
    } catch {
      // Telemetry must never break a user flow.
    }
  };

  const setRunning = (next: boolean) => {
    running = next;
    deps.onRunningChange?.(next);
  };

  async function run(
    opts: { mode?: ClipGenMode; trigger?: ClipGenTrigger } = {}
  ): Promise<ClipGenerationResult> {
    const mode: ClipGenMode = opts.mode ?? "generate";
    const trigger: ClipGenTrigger = opts.trigger ?? "user";

    if (trigger === "user") emit("clips_generate_clicked", { mode });

    // A second click while a run is in flight does NOT start a second run — two
    // concurrent runs would each write a full clip list and the loser's write
    // would land last, duplicating (or clobbering) the winner's clips.
    if (running) {
      return {
        status: "busy",
        count: 0,
        fallbackUsed: false,
        reasonCode: null,
        message: "Clip generation is already running.",
      };
    }

    // The one case that genuinely needs the analysis pass to run first.
    if (!deps.isAnalyzed()) {
      emit("clips_generation_empty", { mode, reason: "not_analyzed" });
      return {
        status: "empty",
        count: 0,
        fallbackUsed: false,
        reasonCode: "not_analyzed",
        message: clipGenMessage("not_analyzed", 0),
      };
    }

    setRunning(true);
    try {
      const input = deps.buildInput();
      const out = generateClipsDetailed(input);
      const { stats } = out;

      emit("clips_generation_started", {
        mode,
        durationSeconds: stats.durationSeconds,
        momentCount: stats.momentCount,
        transcriptAvailable: stats.transcriptAvailable,
        attentionSamples: stats.attentionSamples,
      });

      if (out.clips.length === 0) {
        // Empty leaves the existing clips ALONE — a run that couldn't do better
        // has no business deleting what the user already has.
        emit("clips_generation_empty", { ...stats, mode, reason: out.reasonCode });
        return {
          status: "empty",
          count: 0,
          fallbackUsed: false,
          reasonCode: out.reasonCode,
          message: clipGenMessage(out.reasonCode, 0),
        };
      }

      const next =
        mode === "regenerate"
          ? preserveCompletedExports(deps.readClips(), out.clips)
          : out.clips;

      await deps.writeClips(next);

      if (out.fallbackUsed) {
        emit("clips_generation_fallback_used", { ...stats, mode });
      }
      // generatedCount (what the generator produced) vs savedCount (what we
      // actually persisted) — if these ever diverge, the panel's count and its
      // cards will too, so they're logged side by side.
      emit("clips_generation_completed", {
        ...stats,
        mode,
        generatedCount: out.clips.length,
        savedCount: next.length,
      });

      return {
        status: "generated",
        count: next.length,
        fallbackUsed: out.fallbackUsed,
        reasonCode: out.reasonCode,
        message: clipGenMessage(out.reasonCode, next.length),
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emit("clips_generation_failed", { mode });
      return {
        status: "failed",
        count: 0,
        fallbackUsed: false,
        reasonCode: null,
        message: "Clip generation failed",
        error,
      };
    } finally {
      // Always clears the loading state — a thrown generator or a rejected
      // Firestore write must never leave the button stuck on "Generating…".
      setRunning(false);
    }
  }

  return {
    isRunning: () => running,
    run,
  };
}
