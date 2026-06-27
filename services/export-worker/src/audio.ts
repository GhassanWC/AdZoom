/**
 * Build the FFmpeg `filter_complex` that reconstructs the export's audio from
 * the source, honoring the SAME cut/speed timeline the video uses (so A/V stay
 * locked). One trimmed+retimed segment per `TimelineSegment`, concatenated:
 *
 *   - cuts        — segments simply exclude removed ranges (the timeline map
 *                   already did this), so no audio comes from a cut.
 *   - speed       — per the section's `audioMode`, matching the browser's
 *                   `applySpeedForFrame` (preservesPitch = audioMode !== "keep"):
 *                     • "keep"          → pitch RISES with speed → asetrate/aresample
 *                     • "pitch-correct" → pitch preserved        → atempo (placeholder)
 *                     • "mute"          → pitch-preserved length + volume=0
 *
 * Operates on input #1 (`[1:a]`, the source file) and yields `[aout]`. Returns
 * null when there's nothing to build (no segments) — the caller then muxes `-an`.
 *
 * ── Extension seam (future music / fades / SFX) ──────────────────────────────
 * This builder is the single place final audio is composed, so it is the seam to
 * grow when background-music / SFX tracks land: build each extra track as its own
 * input chain (trim/volume/afade) and `amix` it with `[aout]` here, keeping the
 * source-audio timeline (cuts/speed) intact. The whole-timeline `audiomux` CLI
 * stage already runs AFTER the video chunks are concatenated, so a global mix
 * stays in sync regardless of how the video was chunked. `opts.padToFill` appends
 * `apad` so the composed track can be `-shortest`-trimmed to the exact video
 * length (used by audiomux; off for the in-render whole-video path to preserve its
 * existing behavior).
 */
import { activeSpeedAt } from "@/lib/timeline/crop-speed";
import type { DetectedMoment } from "@/lib/firebase/schema";
import type { TimelineSegment } from "@/lib/timeline/crop-speed";

const EPS = 1e-3;

export interface AudioFilterOptions {
  /** Append `apad` to the composed track so `-shortest` trims it to the video
   *  length exactly (prevents a too-short audio track from truncating the video). */
  padToFill?: boolean;
}

/** Decompose a tempo ratio into a chain of atempo filters (each in [0.5, 2]). */
function atempoChain(mult: number): string[] {
  const parts: string[] = [];
  let r = mult;
  while (r > 2 + 1e-9) {
    parts.push("atempo=2.0");
    r /= 2;
  }
  while (r < 0.5 - 1e-9) {
    parts.push("atempo=0.5");
    r /= 0.5;
  }
  parts.push(`atempo=${r.toFixed(6)}`);
  return parts;
}

export function buildAudioFilterComplex(
  segments: TimelineSegment[],
  moments: DetectedMoment[],
  sampleRate: number,
  opts: AudioFilterOptions = {}
): string | null {
  if (!segments.length) return null;

  const chains: string[] = [];
  const labels: string[] = [];

  segments.forEach((seg, i) => {
    const mid = (seg.sourceStart + seg.sourceEnd) / 2;
    const sp = activeSpeedAt(moments, mid);
    const mult = seg.speedMultiplier;
    const mode = sp?.audioMode ?? "keep";

    const filters: string[] = [
      `atrim=start=${seg.sourceStart.toFixed(6)}:end=${seg.sourceEnd.toFixed(6)}`,
      "asetpts=PTS-STARTPTS",
    ];

    if (Math.abs(mult - 1) > EPS) {
      if (mode === "keep") {
        // Pitch rises: speed the samples up, then resample back to `sampleRate`.
        filters.push(`asetrate=${Math.round(sampleRate * mult)}`, `aresample=${sampleRate}`);
      } else {
        // "pitch-correct" + "mute" preserve pitch; tempo-shift to match the video.
        filters.push(...atempoChain(mult));
      }
    }

    if (mode === "mute") {
      filters.push("volume=0");
    }

    const out = `a${i}`;
    chains.push(`[1:a]${filters.join(",")}[${out}]`);
    labels.push(`[${out}]`);
  });

  const tail = opts.padToFill ? ",apad" : "";
  const concat = `${labels.join("")}concat=n=${labels.length}:v=0:a=1${tail}[aout]`;
  return [...chains, concat].join(";");
}
