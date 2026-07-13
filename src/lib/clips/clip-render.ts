/**
 * Clips → RENDERABLE clips. PURE.
 *
 * The panel renders whatever is on `ProjectDoc.clips`, and that array is only as
 * trustworthy as whatever wrote it (an older generator, a partial write, a
 * hand-edited doc). The card indexes straight into `CLIP_TYPE_META[clip.clipType]`
 * and calls `clip.editOperations.some(...)`, so ONE malformed entry used to take
 * the whole panel down with a TypeError — which reads to the user as "the clips
 * vanished".
 *
 * So: every clip is normalized before it reaches the UI. A missing OPTIONAL field
 * gets a sane default and the card still renders. The only thing that can drop a
 * clip is an unrecoverable time WINDOW (nothing to open, seek to or export), and
 * when that happens the panel is told how many and why — a clip is never silently
 * filtered out.
 */

import type {
  ClipAspectRatio,
  ClipEditOperation,
  ClipExportStatus,
  ClipType,
  GeneratedClip,
  OverlayTextPreset,
} from "@/lib/firebase/schema";
import { CLIP_TYPE_META } from "./clip-generator";

const ASPECTS: ClipAspectRatio[] = ["9:16", "1:1", "4:5", "16:9"];
const STATUSES: ClipExportStatus[] = ["idle", "queued", "rendering", "completed", "failed"];
const PRESETS: OverlayTextPreset[] = ["clean", "bold_social", "minimal", "podcast", "tutorial"];

const DEFAULT_CLIP_TYPE: ClipType = "best_hook";
const DEFAULT_ASPECT: ClipAspectRatio = "9:16";
const DEFAULT_PRESET: OverlayTextPreset = "clean";

/** A clip we could not render, and the reason — always surfaced, never silent. */
export interface DroppedClip {
  id: string;
  reason: string;
}

export interface RenderableClips {
  /** Safe to render: every required field present, every enum in range. */
  clips: GeneratedClip[];
  /** Structurally un-renderable entries (no usable time window). */
  dropped: DroppedClip[];
}

/**
 * Normalize the persisted clip list for rendering. `stored.length` always equals
 * `clips.length + dropped.length`, so the UI can prove nothing went missing.
 */
export function toRenderableClips(stored: readonly unknown[] | undefined | null): RenderableClips {
  if (!Array.isArray(stored) || stored.length === 0) return { clips: [], dropped: [] };

  const clips: GeneratedClip[] = [];
  const dropped: DroppedClip[] = [];

  stored.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") {
      dropped.push({ id: `#${i + 1}`, reason: "not a clip object" });
      return;
    }
    const clip = normalizeClip(raw as Partial<GeneratedClip>, i);
    if (clip) clips.push(clip);
    else {
      const id = idOf(raw as Partial<GeneratedClip>, i);
      dropped.push({ id, reason: "no usable start/end time" });
    }
  });

  return { clips, dropped };
}

/**
 * One clip, with defaults for everything optional. Returns null ONLY when the
 * time window can't be recovered — the one thing a clip cannot exist without.
 */
export function normalizeClip(raw: Partial<GeneratedClip>, index = 0): GeneratedClip | null {
  const window = resolveWindow(raw);
  if (!window) return null;
  const { startTime, endTime } = window;
  // Always recomputed, so the card's duration can never disagree with its range.
  const duration = endTime - startTime;

  const clipType = pick(raw.clipType, Object.keys(CLIP_TYPE_META) as ClipType[], DEFAULT_CLIP_TYPE);
  const editOperations: ClipEditOperation[] = Array.isArray(raw.editOperations)
    ? raw.editOperations.filter((op): op is ClipEditOperation => !!op && typeof op === "object")
    : [];
  // Every clip is at least its own trim — that's what makes it exportable.
  if (!editOperations.some((op) => op.type === "trim")) {
    editOperations.unshift({ type: "trim", startTime, endTime });
  }

  return {
    id: idOf(raw, index),
    title: text(raw.title) ?? fallbackTitle(clipType, startTime, endTime),
    reason: text(raw.reason) ?? "Suggested clip from this video.",
    startTime,
    endTime,
    duration,
    score: clamp01(num(raw.score) ?? 0.5),
    clipType,
    suggestedAspectRatio: pick(raw.suggestedAspectRatio, ASPECTS, DEFAULT_ASPECT),
    suggestedCaptionStyle: pick(raw.suggestedCaptionStyle, PRESETS, DEFAULT_PRESET),
    suggestedHookText: text(raw.suggestedHookText) ?? "",
    editOperations,
    exportStatus: pick(raw.exportStatus, STATUSES, "idle"),
    ...(raw.exportJobId ? { exportJobId: raw.exportJobId } : {}),
    ...(raw.exportUrl ? { exportUrl: raw.exportUrl } : {}),
    ...(raw.exportError ? { exportError: raw.exportError } : {}),
    ...(raw.exportSettingsHash ? { exportSettingsHash: raw.exportSettingsHash } : {}),
    ...(raw.exportSourceFingerprint
      ? { exportSourceFingerprint: raw.exportSourceFingerprint }
      : {}),
    signals: Array.isArray(raw.signals) ? raw.signals.filter((s) => typeof s === "string") : [],
    ...(raw.fallback ? { fallback: true as const } : {}),
    createdAt: num(raw.createdAt) ?? 0,
    ...(num(raw.updatedAt) !== null ? { updatedAt: num(raw.updatedAt)! } : {}),
  };
}

/**
 * Recover [start,end] from whatever the clip actually carries: an explicit pair,
 * a start + duration, or an end + duration. Only a clip with none of those is
 * genuinely un-renderable.
 */
function resolveWindow(
  raw: Partial<GeneratedClip>
): { startTime: number; endTime: number } | null {
  const s = num(raw.startTime);
  const e = num(raw.endTime);
  const d = num(raw.duration);

  if (s !== null && e !== null && e > s) return { startTime: Math.max(0, s), endTime: e };
  if (s !== null && d !== null && d > 0) {
    const start = Math.max(0, s);
    return { startTime: start, endTime: start + d };
  }
  if (e !== null && d !== null && d > 0 && e - d >= 0) {
    return { startTime: e - d, endTime: e };
  }
  return null;
}

function idOf(raw: Partial<GeneratedClip>, index: number): string {
  return text(raw.id) ?? `clip_${index}`;
}

function fallbackTitle(type: ClipType, s: number, e: number): string {
  return `${CLIP_TYPE_META[type].label} · ${fmt(s)}–${fmt(e)}`;
}

/** Keep the value only if it's a member of the union; otherwise use the default. */
function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as T)
    : fallback;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function text(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}
