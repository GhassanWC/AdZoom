/**
 * Smart Clips panel STATE — the pure decisions behind the button and the status
 * line, kept out of the component so they can be unit-tested (the repo's
 * *-behavior / *-state convention).
 *
 * The rule this module exists to enforce: the panel NEVER shows a bare "No clips
 * yet". Every state — before a run, during, after a success, after an empty run,
 * after a failure — resolves to a sentence that says what happened and what to
 * do about it, and the primary button is always visible and always clickable
 * except while a run is actually in flight.
 */

import type { ClipGenerationResult } from "@/lib/clips/clip-generation";
import { clipGenMessage } from "@/lib/clips/clip-generator";

export interface ClipsPanelInput {
  /** A generation run is in flight right now. */
  running: boolean;
  /**
   * Clips actually being RENDERED as cards — the visible list. Every number the
   * panel says out loud is derived from this, never from the last run's own
   * count, so "3 smart clips generated" can't appear above zero cards.
   */
  clipCount: number;
  /** Clips PERSISTED on the project, including any that failed to render. */
  storedCount: number;
  /** Outcome of the last run this session (null before the first run). */
  lastRun: ClipGenerationResult | null;
  /** Analysis finished — the one hard prerequisite for generating. */
  analysisComplete: boolean;
}

export type ClipsStatusTone = "info" | "success" | "error";

export interface ClipsStatus {
  tone: ClipsStatusTone;
  text: string;
}

/**
 * The primary button's label. Four states, in precedence order: an in-flight run
 * beats everything, a failure asks to retry, existing clips get "Regenerate",
 * and the first-run default is the explicit call to action.
 */
export function clipsButtonLabel(s: ClipsPanelInput): string {
  if (s.running) return "Generating clips…";
  if (s.lastRun?.status === "failed") return "Try Again";
  if (s.clipCount > 0) return "Regenerate Clips";
  return "Generate Smart Clips";
}

/**
 * Disabled ONLY while a run is actively in flight. Not when analysis is missing
 * (clicking then explains what to do), not after a failure, not when the last
 * run came back empty — a dead-looking button is what made this feature feel
 * broken in the first place.
 */
export function clipsButtonDisabled(s: ClipsPanelInput): boolean {
  return s.running;
}

/** Regenerating replaces the existing set, so it needs a confirm first. */
export function clipsNeedsRegenerateConfirm(s: ClipsPanelInput): boolean {
  return !s.running && s.clipCount > 0;
}

/** A failed run gets an explicit retry affordance next to the reason. */
export function clipsShowRetry(s: ClipsPanelInput): boolean {
  return !s.running && s.lastRun?.status === "failed";
}

/**
 * What the panel header says right now — never vague, never silent, and never in
 * conflict with the cards below it. Any count in the text comes from
 * `clipCount` (what's actually rendered), NOT from the last run's own tally.
 */
export function clipsStatus(s: ClipsPanelInput): ClipsStatus {
  if (s.running) return { tone: "info", text: "Finding the best moments…" };

  const last = s.lastRun;

  // Clips ARE on screen → say so, whatever the last run thought.
  if (s.clipCount > 0) {
    if (last?.status === "generated") {
      return {
        tone: "success",
        text: clipGenMessage(last.fallbackUsed ? "fallback" : "ok", s.clipCount),
      };
    }
    return {
      tone: "info",
      text: `${s.clipCount} suggested clip${s.clipCount === 1 ? "" : "s"} · shorts from this video`,
    };
  }

  // Nothing rendered but clips ARE saved → a rendering problem, not an empty
  // one. Say that plainly instead of claiming there are no clips.
  if (s.storedCount > 0) {
    return {
      tone: "error",
      text: `${s.storedCount} saved clip${s.storedCount === 1 ? "" : "s"} could not be displayed.`,
    };
  }

  if (last) {
    switch (last.status) {
      case "failed":
        return { tone: "error", text: "Clip generation failed" };
      case "empty":
        // The generator's exact reason — "shorter than 8 seconds", "analyze
        // first", "length isn't known yet".
        return { tone: "error", text: last.message };
      case "generated":
        // Generated, saved… and nothing to show. Should be unreachable; if it
        // ever happens, name it rather than contradict ourselves.
        return { tone: "error", text: "Clips were generated but could not be displayed." };
      case "busy":
        break; // a no-op click; fall through to the resting state
    }
  }

  if (!s.analysisComplete) {
    return { tone: "info", text: "Analyze video first to generate smart clips." };
  }
  return { tone: "info", text: "Generate short clips from this edited video." };
}

/**
 * The empty state appears ONLY when there is genuinely nothing: nothing rendered
 * AND nothing persisted. If clips are saved but unrenderable, the panel owes the
 * user the reason (see `clipsUnrenderableNote`) — not a "no clips" shrug that
 * contradicts its own header.
 */
export function clipsShowEmptyState(s: ClipsPanelInput): boolean {
  return !s.running && s.clipCount === 0 && s.storedCount === 0;
}

/**
 * Saved clips that never made it to a card. Nothing is EVER filtered out of the
 * panel without this sentence appearing.
 */
export function clipsUnrenderableNote(
  s: ClipsPanelInput,
  reasons: readonly string[] = []
): string | null {
  const hidden = s.storedCount - s.clipCount;
  if (hidden <= 0) return null;
  const why = reasons.length > 0 ? ` (${[...new Set(reasons)].join("; ")})` : "";
  return `${hidden} of ${s.storedCount} saved clip${
    s.storedCount === 1 ? "" : "s"
  } could not be displayed${why}. Regenerate to rebuild them.`;
}

/**
 * An honest note about what the clips were scored from when a signal is missing.
 * A missing transcript never BLOCKS generation (attention + edit density carry
 * it), but the user should know why the titles are timestamps and not quotes.
 */
export function clipsSignalNote(opts: {
  analysisComplete: boolean;
  transcriptAvailable: boolean;
  clipCount: number;
}): string | null {
  if (!opts.analysisComplete || opts.transcriptAvailable) return null;
  if (opts.clipCount === 0) return null;
  return "No transcript available yet — these clips were scored from attention and edit density.";
}
