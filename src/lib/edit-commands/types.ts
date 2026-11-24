/**
 * The editing command vocabulary shared by the manual-editor bridge, the local
 * command parser and any model (Gemini today, Claude or another model later).
 *
 * A command is DATA. It is validated against the CURRENT timeline and applied
 * by `applyEditCommands` (apply.ts) — the same pure executor whatever produced
 * it. Model integrations live elsewhere (`tools.ts` describes these commands
 * as JSON-schema tools; the Gemini adapter is server-side), so swapping models
 * never touches what an edit does.
 *
 * TIME CONVENTION: every `start`/`end`/`at` is SOURCE seconds — the time in the
 * original upload, which is what the timeline shows and what stays stable when
 * other footage is cut. `seconds` in trim/shift is a DURATION as the viewer
 * experiences it (output time), so "trim the first two seconds" of a sped-up
 * clip removes what the viewer sees as two seconds.
 */

import type { DetectedMoment, EffectType } from "@/lib/firebase/schema";

export type GraphicPosition =
  | "top-left"
  | "top"
  | "top-right"
  | "center"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

export type EntranceAnimation = "slide-left" | "slide-up" | "fade" | "pop" | "none";

export type EditCommand =
  // ── Footage (clips are derived kept spans — see clips.ts) ─────────────────
  | { op: "trim_clip"; clipId: string; edge: "start" | "end"; seconds: number }
  | { op: "delete_clip"; clipId: string }
  | { op: "remove_range"; start: number; end: number; reason?: string }
  | { op: "restore_range"; start: number; end: number }
  | { op: "set_speed"; start: number; end: number; multiplier: number }
  // ── Captions ──────────────────────────────────────────────────────────────
  | { op: "add_captions"; start?: number; end?: number }
  // ── Graphics & effects ────────────────────────────────────────────────────
  | {
      op: "add_graphic";
      presetId: string;
      text: string;
      start: number;
      duration?: number;
      position?: GraphicPosition;
      color?: string;
      backgroundColor?: string;
      animation?: EntranceAnimation;
    }
  | { op: "add_zoom"; start: number; end: number; scale?: number; x?: number; y?: number }
  /**
   * A composed camera move: beats in viewer terms (seconds into the move,
   * focal centre, zoom factor, easing). `elementId` replaces an existing zoom's
   * move instead of adding one. See edit-commands/camera.ts.
   */
  | { op: "set_camera"; start: number; end: number; beats: import("./camera").CameraBeat[]; elementId?: string }
  /** Targeted camera revisions — each touches only the property named. */
  | { op: "update_camera"; elementId: string; slower?: boolean; faster?: boolean; holdSeconds?: number; zoom?: number }
  /**
   * A graphic designed from parts. Either explicit `parts`, or a `label`
   * (title + optional sub-line) composed by the dish-label design.
   */
  | {
      op: "compose_graphic";
      start: number;
      duration?: number;
      parts?: import("@/lib/firebase/schema").GraphicPart[];
      label?: { title: string; sub?: string; tone?: import("@/lib/graphics/design").GraphicTone; x?: number; y?: number };
    }
  /** Targeted graphic revisions. Parts are addressed by id or by kind ("line", "text"). */
  | {
      op: "update_graphic";
      elementId: string;
      removeParts?: string[];
      setText?: { part: string; text: string }[];
      setColor?: { part: string; color: string }[];
      move?: { dx: number; dy: number };
      start?: number;
      end?: number;
    }
  /**
   * One use of an effect program at `at` (source seconds). `fx` carries the
   * exact library version and its program (resolved server-side), this use's
   * params and its footage anchors. See src/lib/effects.
   */
  | { op: "add_effect"; at: number; fx: import("@/lib/firebase/schema").FxSettings }
  /**
   * Revise ONE effect instance: `params` changes only the named settings
   * ("make the sparks fade faster"); `program` swaps in a new library version
   * (an adaptation), keeping this use's settings for params that still exist.
   */
  | {
      op: "update_effect";
      elementId: string;
      params?: import("@/lib/effects/program").FxParamValues;
      program?: { program: import("@/lib/effects/program").EffectProgram; version: number; note?: string };
      at?: number;
      anchor?: { x: number; y: number };
      /** Retime this use: play the whole effect over this many seconds (slower/faster drawing). */
      duration?: number;
    }
  | { op: "add_transition"; at: number; style?: "fade" | "zoom" | "swipe" | "flash" | "smooth_cut"; duration?: number }
  /** One zoom per detected click (EditState.clicks), framed on the click. */
  | { op: "add_click_zooms"; start?: number; end?: number; scale?: number }
  /**
   * Remove dead air: every pause longer than `minPause` seconds is shortened to
   * `keep` seconds. Word gaps from the transcript when available (cuts land
   * between words), else audio silences.
   */
  | { op: "tighten_pauses"; minPause?: number; keep?: number }
  | {
      op: "update_element";
      elementId: string;
      start?: number;
      end?: number;
      text?: string;
      position?: GraphicPosition;
      color?: string;
      backgroundColor?: string;
      fontScale?: number;
      animation?: EntranceAnimation;
      enabled?: boolean;
    }
  | { op: "shift_element"; elementId: string; seconds: number }
  | { op: "split_element"; elementId: string; at: number }
  | { op: "remove_element"; elementId: string }
  /**
   * A sequence capability (src/lib/edit-commands/registry.ts): split_clip,
   * trim_item, delete_item, move_clip, insert_clip, replace_source,
   * freeze_frame, set_hold, set_clip_speed, set_fade, set_transition,
   * set_clip_audio, detach_audio, add_audio_track, update_audio_track,
   * remove_audio_track. `args` are the capability's flat parameters.
   */
  | { op: "capability"; capability: string; args: Record<string, unknown> };

export type EditOp = EditCommand["op"];

/** What the executor needs to know about the project. Pure data. */
export interface EditState {
  moments: DetectedMoment[];
  sourceDuration: number;
  /** Output canvas, for aspect-adapted graphics. */
  canvasWidth: number;
  canvasHeight: number;
  /** Word-timed transcript, when one exists (captions need it). */
  transcript?: import("@/lib/firebase/schema").Transcript | null;
  videoType?: import("@/lib/firebase/schema").SelectedVideoType;
  /**
   * Clicks found in the footage (recording events, frame analysis, or a model
   * watching the video) — what `add_click_zooms` frames. Source seconds; x/y
   * are 0..1 of the frame.
   */
  clicks?: ClickMark[];
  /** Silent stretches (source seconds) from audio analysis — `tighten_pauses` fallback. */
  silences?: { start: number; end: number }[];
  /**
   * The user asked to keep the soundtrack ("keep the commentary") — edits that
   * would remove or retime footage (cuts, speed, trims) are refused.
   */
  audioLocked?: boolean;
  /** The authored multi-source timeline (absent on legacy projects). */
  sequence?: import("@/lib/timeline/sequence").Sequence | null;
  assets?: import("@/lib/timeline/sequence").ProjectAsset[];
}

export interface ClickMark {
  t: number;
  x: number;
  y: number;
  /** Where it came from — reported to the user ("from your recording's clicks"). */
  source: "recording" | "frames" | "model";
}

export interface EditChange {
  kind: "added" | "updated" | "removed";
  elementId: string;
  /** The edit type, or "clip" / "audio-track" / "asset" for sequence changes. */
  effectType: EffectType | "clip" | "audio-track" | "asset";
  /** Plain-language line for the chat ("Trimmed 2.0s from the start of clip 1"). */
  summary: string;
  /** Source time to jump to when the user clicks the change. */
  at: number;
}

export interface EditError {
  commandIndex: number;
  op: EditOp | string;
  code:
    | "unknown_op"
    | "bad_args"
    | "not_found"
    | "out_of_range"
    | "too_short"
    | "no_transcript"
    | "unknown_preset"
    | "no_clicks"
    | "no_audio"
    | "prep_failed"
    | "locked"
    | "constraint"
    | "unsupported"
    | "conflict"
    | "no_change";
  message: string;
}

export type ApplyResult =
  | {
      ok: true;
      moments: DetectedMoment[];
      /** Present when the request touched the sequence (or converted a legacy timeline to one). */
      sequence?: import("@/lib/timeline/sequence").Sequence;
      assets?: import("@/lib/timeline/sequence").ProjectAsset[];
      changes: EditChange[];
      /** A clip whose boundary was created by this edit got a new id. */
      clipRenames: { from: string; to: string }[];
      /** Parts of the request that were blocked (partial mode only; else empty). */
      errors: EditError[];
    }
  | { ok: false; errors: EditError[] };

/** One user request, as the editor context applies it. */
export interface EditRequest {
  /** Stable across retries of the same request — the idempotency key. */
  requestId: string;
  /** What the user said (for history and telemetry). */
  message: string;
  source: "local" | "model";
  commands: EditCommand[];
  /** Apply what validates and report the rest (multi-part requests). */
  partial?: boolean;
  /**
   * The project's `timelineRev` when the request was composed. A commit onto a
   * newer revision re-validates and reports property conflicts instead of
   * overwriting a change made in between.
   */
  baseRev?: number;
  /** Direction to remember with this edit ("I like the ripple"), saved in the same write. */
  memory?: import("@/lib/firebase/schema").AssistantMemoryItem[];
  /**
   * Footage data prepared for THIS request (useFootagePrep). Passed explicitly
   * because the document echo carrying it may not have arrived yet.
   */
  data?: {
    transcript?: import("@/lib/firebase/schema").Transcript | null;
    clicks?: ClickMark[];
    silences?: { start: number; end: number }[];
  };
}

export type EditRequestOutcome =
  | {
      status: "applied";
      entry: import("@/lib/firebase/schema").AssistantLogEntry;
      changes: EditChange[];
      /** Parts that were blocked (partial requests). */
      blocked: EditError[];
    }
  /** Already applied (a retry) — nothing changed. */
  | { status: "duplicate"; entry: import("@/lib/firebase/schema").AssistantLogEntry | null }
  | { status: "rejected"; errors: EditError[] };
