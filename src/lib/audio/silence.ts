/**
 * Pure silence / speech detection over a loudness (RMS) timeline. DOM-free +
 * deterministic so it's unit-testable and reusable on client or server. The
 * browser shell (`analyze-audio.ts`) decodes the media audio into the `rms`
 * array; this module turns it into speech/silence structure.
 */
import type {
  AudioAnalysis,
  LongPause,
  SilenceSegment,
  SpeakingDensityBucket,
  SpeechSegment,
} from "@/lib/firebase/schema";

export interface SilenceOptions {
  /** RMS below this (0..1) is "silent". */
  silenceRms: number;
  /** Minimum silence length to record as a segment (s). */
  minSilenceSec: number;
  /** Silence at/above this is a removal candidate / long pause (s). */
  longPauseSec: number;
  /** Minimum speech run to record (s). */
  minSpeechSec: number;
  /** Speaking-density window (s). */
  densityWindowSec: number;
  /** Bridge silences separated by a speech blip shorter than this (s). */
  mergeGapSec: number;
  /** Usable-speech gate: need at least this many speech seconds… */
  usableSpeechMinSec: number;
  /** …AND this fraction of the media. */
  usableSpeechMinFraction: number;
}

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  silenceRms: 0.015,
  minSilenceSec: 0.4,
  longPauseSec: 0.8,
  minSpeechSec: 0.3,
  densityWindowSec: 2,
  mergeGapSec: 0.16,
  usableSpeechMinSec: 2.5,
  usableSpeechMinFraction: 0.12,
};

interface Run {
  silent: boolean;
  start: number;
  end: number;
}

/** Detect speech/silence structure from an RMS-per-bucket timeline. */
export function detectSilence(
  rms: number[],
  hz: number,
  options: Partial<SilenceOptions> = {}
): Pick<
  AudioAnalysis,
  | "speechSegments"
  | "silenceSegments"
  | "longPauses"
  | "speakingDensity"
  | "hasUsableSpeech"
  | "totalSilenceSeconds"
> {
  const o = { ...DEFAULT_SILENCE_OPTIONS, ...options };
  const n = rms.length;
  const dur = hz > 0 ? n / hz : 0;
  if (n === 0 || hz <= 0) {
    return {
      speechSegments: [],
      silenceSegments: [],
      longPauses: [],
      speakingDensity: [],
      hasUsableSpeech: false,
      totalSilenceSeconds: 0,
    };
  }
  const tOf = (i: number) => i / hz;

  // 1. Raw runs of silent / loud buckets.
  const runs: Run[] = [];
  for (let i = 0; i < n; i++) {
    const silent = rms[i] < o.silenceRms;
    const last = runs[runs.length - 1];
    if (last && last.silent === silent) last.end = i + 1;
    else runs.push({ silent, start: i, end: i + 1 });
  }

  // 2. Denoise: a very short LOUD blip between two silences is bridged into
  // silence (a click/breath shouldn't split a pause); a very short SILENT gap
  // inside speech stays speech.
  const bridgeBuckets = Math.max(1, Math.round(o.mergeGapSec * hz));
  const merged: Run[] = [];
  for (const run of runs) {
    const len = run.end - run.start;
    const prev = merged[merged.length - 1];
    if (prev) {
      const bridgeLoud = !run.silent && len <= bridgeBuckets && prev.silent;
      const bridgeSilent = run.silent && len <= bridgeBuckets && !prev.silent;
      if (bridgeLoud || bridgeSilent) {
        prev.end = run.end; // absorb the blip into the previous run
        continue;
      }
    }
    merged.push({ ...run });
  }
  // Coalesce now-adjacent same-type runs.
  const coalesced: Run[] = [];
  for (const run of merged) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.silent === run.silent) prev.end = run.end;
    else coalesced.push({ ...run });
  }

  const silenceSegments: SilenceSegment[] = [];
  const longPauses: LongPause[] = [];
  const speechSegments: SpeechSegment[] = [];
  let totalSilenceSeconds = 0;
  let totalSpeechSeconds = 0;

  for (const run of coalesced) {
    const start = tOf(run.start);
    const end = tOf(run.end);
    const duration = end - start;
    if (run.silent) {
      if (duration >= o.minSilenceSec) {
        silenceSegments.push({ startTime: start, endTime: end, duration });
        totalSilenceSeconds += duration;
        if (duration >= o.longPauseSec) longPauses.push({ startTime: start, endTime: end, duration });
      }
    } else if (duration >= o.minSpeechSec) {
      speechSegments.push({ startTime: start, endTime: end });
      totalSpeechSeconds += duration;
    }
  }

  // 3. Speaking density per fixed window (fraction of loud buckets).
  const speakingDensity: SpeakingDensityBucket[] = [];
  const win = Math.max(1, Math.round(o.densityWindowSec * hz));
  for (let i = 0; i < n; i += win) {
    const end = Math.min(n, i + win);
    let loud = 0;
    for (let j = i; j < end; j++) if (rms[j] >= o.silenceRms) loud++;
    speakingDensity.push({
      startTime: tOf(i),
      endTime: tOf(end),
      density: (end - i) > 0 ? loud / (end - i) : 0,
    });
  }

  const hasUsableSpeech =
    totalSpeechSeconds >= o.usableSpeechMinSec &&
    (dur > 0 ? totalSpeechSeconds / dur : 0) >= o.usableSpeechMinFraction;

  return {
    speechSegments,
    silenceSegments,
    longPauses,
    speakingDensity,
    hasUsableSpeech,
    totalSilenceSeconds: Math.round(totalSilenceSeconds * 100) / 100,
  };
}
