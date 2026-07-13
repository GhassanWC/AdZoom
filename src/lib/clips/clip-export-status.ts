/**
 * Per-clip export lifecycle + duplicate-export prevention. PURE.
 *
 * A clip's export status is tracked SEPARATELY from the full-video export: the
 * project can have a completed full export while a clip is failed, and several
 * clips can sit in different states at once. Identity of a completed clip render
 * is (clipId + sourceFingerprint + settingsHash) — if all three match a new
 * request, it's the same bytes, so we offer the existing download instead of
 * burning another render.
 */

import type { ClipExportStatus, GeneratedClip } from "@/lib/firebase/schema";

/** Terminal states — a job in these is no longer occupying the pipeline. */
export function isTerminalClipStatus(s: ClipExportStatus): boolean {
  return s === "completed" || s === "failed" || s === "idle";
}

/** True while a clip render is in flight (blocks a second job for that clip). */
export function isClipExportActive(clip: Pick<GeneratedClip, "exportStatus">): boolean {
  return clip.exportStatus === "queued" || clip.exportStatus === "rendering";
}

export interface ClipExportIdentity {
  sourceFingerprint: string;
  settingsHash: string;
}

/**
 * Is this export request a duplicate of the clip's completed render? Requires a
 * COMPLETED status, a stored download URL, and BOTH identity parts to match —
 * anything else (different settings, re-uploaded source, failed/idle) is a
 * genuinely new render.
 */
export function isDuplicateClipExport(
  clip: Pick<
    GeneratedClip,
    "exportStatus" | "exportUrl" | "exportSettingsHash" | "exportSourceFingerprint"
  >,
  identity: ClipExportIdentity
): boolean {
  return (
    clip.exportStatus === "completed" &&
    !!clip.exportUrl &&
    !!clip.exportSettingsHash &&
    clip.exportSettingsHash === identity.settingsHash &&
    clip.exportSourceFingerprint === identity.sourceFingerprint
  );
}

/** What the UI should offer for a clip export request. */
export type ClipExportDecision =
  | { kind: "reuse"; url: string }
  | { kind: "blocked"; reason: string }
  | { kind: "start" };

export interface ClipExportDecisionOpts {
  /** The user explicitly clicked "Re-export anyway" — bypasses the duplicate check. */
  force?: boolean;
  /**
   * Is a render ACTUALLY in flight right now? The persisted `exportStatus` can go
   * stale (e.g. the user closed the dialog mid-render, so nothing was around to
   * write the terminal status). The live signal, when supplied, is authoritative
   * — otherwise a stale "rendering" would permanently block the clip from ever
   * being exported again.
   */
  liveActive?: boolean;
}

/** The single decision point before creating a clip export job. */
export function decideClipExport(
  clip: Pick<
    GeneratedClip,
    "exportStatus" | "exportUrl" | "exportSettingsHash" | "exportSourceFingerprint"
  >,
  identity: ClipExportIdentity,
  opts: ClipExportDecisionOpts = {}
): ClipExportDecision {
  const active = opts.liveActive ?? isClipExportActive(clip);
  if (active) {
    return { kind: "blocked", reason: "This clip is already exporting." };
  }
  if (!opts.force && isDuplicateClipExport(clip, identity)) {
    return { kind: "reuse", url: clip.exportUrl! };
  }
  return { kind: "start" };
}

export interface ClipExportEvent {
  status: ClipExportStatus;
  jobId?: string;
  url?: string;
  error?: string;
  identity?: ClipExportIdentity;
  /** Injected for deterministic tests. */
  now?: number;
}

/**
 * Fold an export event into a clip. Non-mutating; returns the SAME clip object
 * when nothing would change, so a Firestore write can be skipped.
 *
 * Identity (fingerprint + settings hash) is stamped on the way IN (queued), so a
 * completed render is always attributable to the exact settings that produced
 * it. A failure clears the URL (there's nothing to download) but keeps the
 * error so the card can explain itself.
 */
export function withClipExportEvent(
  clip: GeneratedClip,
  event: ClipExportEvent
): GeneratedClip {
  const next: GeneratedClip = {
    ...clip,
    exportStatus: event.status,
    updatedAt: event.now ?? Date.now(),
  };

  if (event.jobId !== undefined) next.exportJobId = event.jobId;
  if (event.identity) {
    next.exportSettingsHash = event.identity.settingsHash;
    next.exportSourceFingerprint = event.identity.sourceFingerprint;
  }

  if (event.status === "completed") {
    next.exportUrl = event.url ?? clip.exportUrl;
    delete next.exportError;
  } else if (event.status === "failed") {
    next.exportError = event.error ?? "Export failed.";
    delete next.exportUrl;
  } else {
    // queued / rendering / idle → no terminal artifacts yet.
    delete next.exportError;
    if (event.status === "idle") {
      delete next.exportUrl;
      delete next.exportJobId;
    }
  }
  return next;
}

/** Replace one clip in the list (by id), leaving the rest untouched. */
export function replaceClip(clips: GeneratedClip[], next: GeneratedClip): GeneratedClip[] {
  return clips.map((c) => (c.id === next.id ? next : c));
}

/** Two windows cover the same footage (within a second at each edge). */
const SAME_WINDOW_TOLERANCE = 1;

/**
 * Carry COMPLETED renders across a full regenerate.
 *
 * A regenerated set is a fresh list of windows, so most clips are genuinely new
 * and start at `idle`. But when a new clip lands on the SAME window as one the
 * user already exported, the rendered file is still exactly this clip — throwing
 * the download away would make them pay (in time and minutes) to render bytes we
 * already have. We preserve it only when the window matches AND the old render
 * is a real, downloadable, identity-stamped `completed` one; the dedup check in
 * `isDuplicateClipExport` still re-validates the settings hash before offering a
 * reuse, so a preserved record can never hand back the wrong file.
 *
 * The clip's own content (title, reason, score, edits) always comes from the
 * fresh generation — only the export record rides along.
 */
export function preserveCompletedExports(
  previous: GeneratedClip[],
  next: GeneratedClip[]
): GeneratedClip[] {
  const done = previous.filter(
    (c) => c.exportStatus === "completed" && !!c.exportUrl && !!c.exportSettingsHash
  );
  if (done.length === 0) return next;

  const claimed = new Set<string>();
  return next.map((clip) => {
    const match = done.find(
      (old) =>
        !claimed.has(old.id) &&
        Math.abs(old.startTime - clip.startTime) <= SAME_WINDOW_TOLERANCE &&
        Math.abs(old.endTime - clip.endTime) <= SAME_WINDOW_TOLERANCE
    );
    if (!match) return clip;
    claimed.add(match.id);
    return {
      ...clip,
      exportStatus: match.exportStatus,
      exportUrl: match.exportUrl,
      exportJobId: match.exportJobId,
      exportSettingsHash: match.exportSettingsHash,
      exportSourceFingerprint: match.exportSourceFingerprint,
    };
  });
}

/** Human label for the card badge. */
export const CLIP_STATUS_LABEL: Record<ClipExportStatus, string> = {
  idle: "Not exported",
  queued: "Queued",
  rendering: "Rendering",
  completed: "Exported",
  failed: "Failed",
};

/**
 * A deterministic, BROWSER-SAFE settings hash for clip-export dedup.
 *
 * Deliberately NOT the server's `computeSettingsHash` — that one uses Node's
 * `crypto` and is server-only. This never has to match it: it only has to
 * answer "are these the exact same render settings as the completed one?", and
 * it's computed + compared entirely on the client. Stable key ordering means the
 * same settings always hash the same, regardless of object construction order.
 */
export function stableHash(value: unknown): string {
  const json = stableStringify(value);
  // FNV-1a (32-bit) — tiny, dependency-free, and plenty for an equality check.
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}
