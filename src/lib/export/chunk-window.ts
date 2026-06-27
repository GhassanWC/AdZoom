/**
 * Pure, dependency-free chunk-window math — the single source of truth for how a
 * chunked export TILES the OUTPUT timeline into per-chunk render/emit windows.
 *
 * Why integer FRAMES (not seconds): two adjacent chunks must agree on their shared
 * boundary EXACTLY, or the concat seam drops/duplicates a frame. Deriving both
 * sides of a seam from the same `i * chunkFrameStep` expression (rather than
 * independently `round()`-ing two different second values) guarantees
 * `trimEndFrame(i) === trimStartFrame(i+1)` and that the windows sum to exactly
 * `totalFrames`. This mirrors the orchestrator's window derivation (C#
 * ChunkTaskRunner) and the worker's render loop (services/export-worker render.ts).
 *
 * Pure on purpose (no `@/` runtime imports, no `server-only`) so it unit-tests
 * cleanly under `node --test`. The worker and the C# orchestrator each re-derive
 * the SAME math; the unit tests here pin the invariants so the three can't drift.
 */

/** A single chunk's render/emit windows, in both integer frames and output seconds. */
export interface ChunkWindow {
  /** 0-based chunk index. */
  index: number;
  // ── EMIT (trim) window — the EXACT output span this chunk contributes. ──────
  /** First output frame this chunk emits (inclusive). Begins on an IDR. */
  trimStartFrame: number;
  /** One past the last output frame this chunk emits (exclusive). */
  trimEndFrame: number;
  // ── RENDER window — emit window grown by boundary padding (decode warm-up). ──
  /** First output frame the chunk RENDERS (≤ trimStartFrame; pad frames are
   *  decode/composite-only and MUST NOT reach the encoder). */
  renderStartFrame: number;
  /** One past the last output frame the chunk RENDERS (≥ trimEndFrame). */
  renderEndFrame: number;
  // ── Output seconds (frame / fps) the worker passes to the render CLI. ────────
  trimStartSec: number;
  trimEndSec: number;
  renderStartSec: number;
  renderEndSec: number;
}

export interface ChunkTilingInput {
  /** OUTPUT duration in seconds (post cuts/speed) — recipe.timelineMap.outputDuration. */
  outputDurationSeconds: number;
  /** Output frames per second (the recipe fps; constant across all chunks). */
  fps: number;
  /** Number of chunks the planner decided (== ceil(outputDuration/chunkSeconds)). */
  chunkCount: number;
  /** Output seconds per chunk (the planner's chunkSeconds). */
  chunkSeconds: number;
  /** Boundary padding in seconds (EXPORT_CHUNK_BOUNDARY_PADDING_SECONDS, default 0). */
  paddingSeconds?: number;
}

/** Total OUTPUT frames — the authoritative output length the chunks must tile. */
export function totalOutputFrames(outputDurationSeconds: number, fps: number): number {
  return Math.max(1, Math.round(outputDurationSeconds * fps));
}

/**
 * Derive ONE chunk's render/emit windows. Tiles by integer frames so chunks are
 * gap-free and overlap-free:
 *   - trimStartFrame(i) = min(total, i * step)
 *   - trimEndFrame(i)   = LAST chunk → total ; else min(total, (i+1) * step)
 * The last chunk absorbs the rounding remainder so the windows sum to `total`.
 *
 * Render window = trim window grown by `padFrames` on each side, clamped to
 * [0, total]. With padding 0 the render window EQUALS the trim window.
 */
export function deriveChunkWindow(index: number, input: ChunkTilingInput): ChunkWindow {
  const fps = input.fps;
  const total = totalOutputFrames(input.outputDurationSeconds, fps);
  const count = Math.max(1, input.chunkCount);
  const step = Math.max(1, Math.round(input.chunkSeconds * fps));
  const padFrames = Math.max(0, Math.round((input.paddingSeconds ?? 0) * fps));

  const i = Math.max(0, Math.min(count - 1, index));
  const trimStartFrame = Math.min(total, i * step);
  const trimEndFrame = i === count - 1 ? total : Math.min(total, (i + 1) * step);

  const renderStartFrame = Math.max(0, trimStartFrame - padFrames);
  const renderEndFrame = Math.min(total, trimEndFrame + padFrames);

  return {
    index: i,
    trimStartFrame,
    trimEndFrame,
    renderStartFrame,
    renderEndFrame,
    trimStartSec: trimStartFrame / fps,
    trimEndSec: trimEndFrame / fps,
    renderStartSec: renderStartFrame / fps,
    renderEndSec: renderEndFrame / fps,
  };
}

/** Derive every chunk's window for a job (index 0..chunkCount-1). */
export function deriveAllChunkWindows(input: ChunkTilingInput): ChunkWindow[] {
  const count = Math.max(1, input.chunkCount);
  return Array.from({ length: count }, (_, i) => deriveChunkWindow(i, input));
}
