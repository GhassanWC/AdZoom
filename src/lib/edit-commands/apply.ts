/**
 * The ONE executor for edit commands — whoever produced them (the local
 * parser, Gemini, a future Claude integration, a test).
 *
 * Contract:
 *  • PURE: (state, commands, requestId) → new moments + a change list. No React,
 *    no Firestore; the editor context commits the result as ONE undo step.
 *  • ALL-OR-NOTHING: every command is validated against the state produced by
 *    the commands before it; a single invalid command rejects the whole
 *    request, so a user never gets half of what they asked for silently.
 *  • DETERMINISTIC: new edits get ids derived from `requestId` + position, so
 *    re-running the same request against the same timeline yields the same
 *    ids. The context additionally records applied request ids, which is what
 *    makes a retry a no-op instead of a duplicate.
 *  • NON-DESTRUCTIVE: the source media is never touched. "Removing" footage is
 *    a `cut` moment, "restoring" it deactivates/shrinks cuts — the same
 *    representation the manual Cuts lane uses, so preview and every exporter
 *    already render it.
 */

import type { DetectedMoment, TextStyle } from "@/lib/firebase/schema";
import { buildTimelineMap, DEFAULT_CUT, DEFAULT_SPEED, isActiveCut } from "@/lib/timeline/crop-speed";
import { visibleMoments, isLayerVisible, type LayerVisibility } from "@/lib/timeline/layers";
import { splitMoment } from "@/lib/timeline/split";
import { generateCaptionMoments } from "@/lib/analysis/caption-generator";
import { getPreset } from "@/lib/presets/registry";
import { applyPreset } from "@/lib/presets/apply";
import { aspectOf, safeAreaFor } from "@/lib/presets/layout";
import type { PresetAnimation } from "@/lib/presets/animation";
import type { GraphicPart } from "@/lib/firebase/schema";
import { composeMove, slowerMove, holdLonger, beatsFromKeyframes, MIN_MOVE_SECONDS } from "./camera";
import { dishLabelParts } from "@/lib/graphics/design";
import { compileProgram, parseHex, type EffectProgram, type FxParamValues } from "@/lib/effects/program";
import { deriveClips, clipAtSource, sourceAtOutput, type Clip } from "./clips";
import type {
  ApplyResult,
  EditChange,
  EditCommand,
  EditError,
  EditState,
  EntranceAnimation,
  GraphicPosition,
} from "./types";

/** Shortest footage a trim may leave behind, in viewer seconds. */
export const MIN_KEEP_SECONDS = 0.3;
/** Shortest range a command may cut/restore/speed. */
const MIN_RANGE = 0.05;
/** Shortest element an update may leave (matches the timeline's MIN_MOMENT_LEN). */
const MIN_ELEMENT = 0.3;
/** Ops that remove or retime footage — refused while the soundtrack is locked. */
const AUDIO_CHANGING_OPS: ReadonlySet<string> = new Set(["trim_clip", "delete_clip", "remove_range", "set_speed", "tighten_pauses"]);

/** Only the program's declared params, with valid values (an instance never stores junk keys). */
function pickParams(program: EffectProgram, values: FxParamValues): FxParamValues {
  const out: FxParamValues = {};
  for (const p of program.params) {
    const v = values[p.id];
    if (p.type === "number" && typeof v === "number" && Number.isFinite(v)) out[p.id] = v;
    else if (p.type === "color" && typeof v === "string" && parseHex(v)) out[p.id] = v;
  }
  return out;
}
/** Shortest composed graphic — below this a label is a flash nobody reads. */
export const MIN_GRAPHIC_SECONDS = 2;
const MAX_SPEED = 16;

/** Short, stable prefix for ids minted by one request. */
export function requestIdPrefix(requestId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < requestId.length; i++) {
    h ^= requestId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `ai${(h >>> 0).toString(36)}`;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const fmtS = (v: number) => `${r3(v).toFixed(v < 10 ? 1 : 0)}s`;
const clock = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

export function applyEditCommands(
  state: EditState & { layers?: LayerVisibility },
  commands: readonly EditCommand[],
  requestId: string,
  /**
   * `partial`: apply every command that validates and report the rest as
   * blocked (a multi-part chat request — "calm walkthrough WITH captions" —
   * keeps the part that worked). Default is all-or-nothing.
   */
  opts: { partial?: boolean } = {}
): ApplyResult {
  const prefix = requestIdPrefix(requestId);
  let seq = 0;
  const mint = () => `${prefix}_${++seq}`;

  const dur = state.sourceDuration;
  let moments = state.moments.slice();
  const changes: EditChange[] = [];
  const errors: EditError[] = [];
  const clipRenames: { from: string; to: string }[] = [];

  const clipsNow = (): { clips: Clip[]; map: ReturnType<typeof buildTimelineMap> } => {
    const visible = visibleMoments(moments, state.layers ?? {});
    const map = buildTimelineMap(visible, dur);
    return { clips: deriveClips(visible, dur, map), map };
  };
  const findMoment = (id: string) => moments.find((m) => m.id === id) ?? null;
  const replace = (next: DetectedMoment) => {
    moments = moments.map((m) => (m.id === next.id ? next : m));
  };
  const add = (m: DetectedMoment) => {
    moments = [...moments, m].sort((a, b) => a.startTime - b.startTime);
  };
  const inVideo = (start: number, end: number) =>
    Number.isFinite(start) && Number.isFinite(end) && start >= -1e-6 && end <= dur + 1e-6 && end - start >= MIN_RANGE;

  const cutsHidden = !isLayerVisible(state.layers ?? {}, "cut");

  commands.forEach((cmd, i) => {
    const fail = (code: EditError["code"], message: string) => errors.push({ commandIndex: i, op: cmd?.op ?? "?", code, message });
    if (!cmd || typeof cmd !== "object" || typeof (cmd as { op?: unknown }).op !== "string") {
      fail("unknown_op", "Not a command.");
      return;
    }
    if (state.audioLocked && AUDIO_CHANGING_OPS.has(cmd.op)) {
      return fail("locked", "You asked to keep the original commentary, so I won't cut, trim or speed up the footage.");
    }

    switch (cmd.op) {
      // ── Footage ───────────────────────────────────────────────────────────
      case "trim_clip": {
        if (cutsHidden) return fail("bad_args", "The Cuts layer is hidden, so trims wouldn't show. Show the Cuts layer first.");
        if (!(cmd.seconds > 0)) return fail("bad_args", "Trim amount must be more than 0 seconds.");
        const { clips, map } = clipsNow();
        const clip = clips.find((c) => c.id === cmd.clipId);
        if (!clip) return fail("not_found", "That clip no longer exists — the timeline changed. Select it again and retry.");
        const len = clip.outputEnd - clip.outputStart;
        if (cmd.seconds > len - MIN_KEEP_SECONDS) {
          return fail("too_short", `Clip ${clip.index} is only ${fmtS(len)} long; trimming ${fmtS(cmd.seconds)} would leave less than ${MIN_KEEP_SECONDS}s.`);
        }
        let keepPoint: number;
        if (cmd.edge === "start") {
          const at = r3(sourceAtOutput(map, clip.outputStart + cmd.seconds));
          keepPoint = at;
          const boundary = clip.leftBoundary !== "in" ? findMoment(clip.leftBoundary) : null;
          if (boundary && isActiveCut(boundary)) {
            replace({ ...boundary, endTime: at, edited: true });
            changes.push({ kind: "updated", elementId: boundary.id, effectType: "cut", summary: `Trimmed ${fmtS(cmd.seconds)} from the start of clip ${clip.index}`, at });
          } else {
            const id = mint();
            add(cutMoment(id, clip.sourceStart, at, `Trimmed start of clip ${clip.index}`));
            changes.push({ kind: "added", elementId: id, effectType: "cut", summary: `Trimmed ${fmtS(cmd.seconds)} from the start of clip ${clip.index}`, at });
          }
        } else {
          const at = r3(sourceAtOutput(map, clip.outputEnd - cmd.seconds));
          keepPoint = Math.max(clip.sourceStart, at - 0.01);
          const boundary = clip.rightBoundary !== "out" ? findMoment(clip.rightBoundary) : null;
          if (boundary && isActiveCut(boundary)) {
            replace({ ...boundary, startTime: at, edited: true });
            changes.push({ kind: "updated", elementId: boundary.id, effectType: "cut", summary: `Trimmed ${fmtS(cmd.seconds)} from the end of clip ${clip.index}`, at });
          } else {
            const id = mint();
            add(cutMoment(id, at, clip.sourceEnd, `Trimmed end of clip ${clip.index}`));
            changes.push({ kind: "added", elementId: id, effectType: "cut", summary: `Trimmed ${fmtS(cmd.seconds)} from the end of clip ${clip.index}`, at });
          }
        }
        const after = clipAtSource(clipsNow().clips, keepPoint + 1e-3);
        if (after && after.id !== clip.id) clipRenames.push({ from: clip.id, to: after.id });
        return;
      }

      case "delete_clip": {
        if (cutsHidden) return fail("bad_args", "The Cuts layer is hidden. Show it first.");
        const { clips } = clipsNow();
        const clip = clips.find((c) => c.id === cmd.clipId);
        if (!clip) return fail("not_found", "That clip no longer exists — the timeline changed.");
        if (clips.length === 1) return fail("bad_args", "That's the only clip left — removing it would leave an empty video.");
        const id = mint();
        add(cutMoment(id, clip.sourceStart, clip.sourceEnd, `Removed clip ${clip.index}`));
        changes.push({ kind: "added", elementId: id, effectType: "cut", summary: `Removed clip ${clip.index} (${fmtS(clip.outputEnd - clip.outputStart)})`, at: clip.sourceStart });
        return;
      }

      case "remove_range": {
        if (cutsHidden) return fail("bad_args", "The Cuts layer is hidden. Show it first.");
        if (!inVideo(cmd.start, cmd.end)) return fail("out_of_range", `Range ${clock(cmd.start)}–${clock(cmd.end)} is outside the video.`);
        const id = mint();
        add(cutMoment(id, r3(cmd.start), r3(cmd.end), cmd.reason || "Removed on request"));
        changes.push({ kind: "added", elementId: id, effectType: "cut", summary: `Removed ${clock(cmd.start)}–${clock(cmd.end)}${cmd.reason ? ` (${cmd.reason})` : ""}`, at: cmd.start });
        return;
      }

      case "restore_range": {
        if (!inVideo(cmd.start, cmd.end)) return fail("out_of_range", "Range is outside the video.");
        const hits = moments.filter((m) => isActiveCut(m) && m.endTime > cmd.start && m.startTime < cmd.end);
        if (hits.length === 0) return fail("no_change", `Nothing is cut between ${clock(cmd.start)} and ${clock(cmd.end)}.`);
        for (const c of hits) {
          const coversLeft = cmd.start <= c.startTime;
          const coversRight = cmd.end >= c.endTime;
          if (coversLeft && coversRight) {
            replace({ ...c, cut: { ...(c.cut ?? DEFAULT_CUT), active: false }, edited: true });
          } else if (coversLeft) {
            replace({ ...c, startTime: r3(cmd.end), edited: true });
          } else if (coversRight) {
            replace({ ...c, endTime: r3(cmd.start), edited: true });
          } else {
            const rightId = mint();
            replace({ ...c, endTime: r3(cmd.start), edited: true });
            add({ ...c, id: rightId, startTime: r3(cmd.end), edited: true, source: "user" });
          }
          changes.push({ kind: "updated", elementId: c.id, effectType: "cut", summary: `Restored footage ${clock(Math.max(cmd.start, c.startTime))}–${clock(Math.min(cmd.end, c.endTime))}`, at: Math.max(cmd.start, c.startTime) });
        }
        return;
      }

      case "set_speed": {
        if (!inVideo(cmd.start, cmd.end)) return fail("out_of_range", "Range is outside the video.");
        if (!(cmd.multiplier > 1) || cmd.multiplier > MAX_SPEED) {
          return fail("bad_args", cmd.multiplier > 0 && cmd.multiplier <= 1
            ? "Slow motion isn't supported by the renderer yet — only speed-ups (above 1×)."
            : `Speed must be between 1× and ${MAX_SPEED}×.`);
        }
        const id = mint();
        add({
          ...baseMoment(id, r3(cmd.start), r3(cmd.end), `Speed ${cmd.multiplier}×`, "speed-up"),
          speed: { ...DEFAULT_SPEED, multiplier: cmd.multiplier },
        });
        changes.push({ kind: "added", elementId: id, effectType: "speed-up", summary: `Sped up ${clock(cmd.start)}–${clock(cmd.end)} to ${cmd.multiplier}×`, at: cmd.start });
        return;
      }

      // ── Captions ──────────────────────────────────────────────────────────
      case "add_captions": {
        const gen = generateCaptionMoments(state.transcript, state.videoType ?? "auto");
        if (gen.moments.length === 0) {
          return fail("no_transcript", "There's no finished transcript yet, so I can't add captions. Generate captions (speech-to-text) first.");
        }
        const lo = cmd.start ?? 0;
        const hi = cmd.end ?? dur;
        const fresh = gen.moments.filter((m) => m.endTime > lo && m.startTime < hi);
        if (fresh.length === 0) return fail("no_change", "Nobody speaks in that range, so there's nothing to caption.");
        // Replace captions in the range instead of stacking a second set.
        const replaced = moments.filter((m) => m.effectType === "captions" && m.endTime > lo && m.startTime < hi);
        const replacedIds = new Set(replaced.map((m) => m.id));
        moments = moments.filter((m) => !replacedIds.has(m.id));
        for (const m of replaced) changes.push({ kind: "removed", elementId: m.id, effectType: "captions", summary: "", at: m.startTime });
        let firstId = "";
        fresh.forEach((m) => {
          const id = mint();
          if (!firstId) firstId = id;
          add({ ...m, id, source: "user", provenance: "user", edited: true });
        });
        changes.push({
          kind: "added",
          elementId: firstId,
          effectType: "captions",
          summary: `Added ${fresh.length} caption${fresh.length === 1 ? "" : "s"}${replaced.length ? ` (replacing ${replaced.length})` : ""}`,
          at: fresh[0].startTime,
        });
        return;
      }

      // ── Graphics & effects ────────────────────────────────────────────────
      case "add_graphic": {
        const preset = getPreset(cmd.presetId);
        if (!preset) return fail("unknown_preset", `There's no graphic called "${cmd.presetId}".`);
        if (!(cmd.start >= 0 && cmd.start < dur)) return fail("out_of_range", `Start ${clock(cmd.start)} is outside the video.`);
        const id = mint();
        const m = applyPreset({
          preset,
          startTime: cmd.start,
          duration: dur,
          canvasWidth: state.canvasWidth,
          canvasHeight: state.canvasHeight,
          id,
          text: cmd.text,
        });
        if (!m) return fail("bad_args", "That graphic needs some text.");
        if (cmd.duration && cmd.duration > 0) m.endTime = r3(Math.min(dur, m.startTime + Math.max(MIN_ELEMENT, cmd.duration)));
        styleGraphic(m, cmd, state);
        add(m);
        changes.push({ kind: "added", elementId: id, effectType: m.effectType, summary: `Added ${preset.name} "${cmd.text}" at ${clock(m.startTime)} for ${fmtS(m.endTime - m.startTime)}`, at: m.startTime });
        return;
      }

      case "add_zoom": {
        if (!inVideo(cmd.start, cmd.end) || cmd.end - cmd.start < MIN_ELEMENT) return fail("out_of_range", "Zoom range is outside the video or too short.");
        const scale = Math.min(4, Math.max(1.1, cmd.scale ?? 1.6));
        const w = 1 / scale;
        const cx = Math.min(1 - w / 2, Math.max(w / 2, cmd.x ?? 0.5));
        const cy = Math.min(1 - w / 2, Math.max(w / 2, cmd.y ?? 0.5));
        const id = mint();
        add({
          ...baseMoment(id, r3(cmd.start), r3(cmd.end), `Zoom ${scale.toFixed(1)}×`, "zoom"),
          focusRegion: { x: cx - w / 2, y: cy - w / 2, width: w, height: w },
          targetRegionSource: "user",
        } as DetectedMoment);
        changes.push({ kind: "added", elementId: id, effectType: "zoom", summary: `Added a ${scale.toFixed(1)}× zoom at ${clock(cmd.start)}`, at: cmd.start });
        return;
      }

      case "add_transition": {
        const len = Math.min(2, Math.max(0.3, cmd.duration ?? 0.6));
        if (!(cmd.at >= 0 && cmd.at < dur)) return fail("out_of_range", `${clock(cmd.at)} is outside the video.`);
        const start = r3(Math.max(0, Math.min(cmd.at, dur - len)));
        const style = cmd.style ?? "fade";
        const id = mint();
        add({ ...baseMoment(id, start, r3(start + len), `${style} transition`, "transition"), transition: { style } } as DetectedMoment);
        changes.push({ kind: "added", elementId: id, effectType: "transition", summary: `Added a ${style.replace("_", " ")} transition at ${clock(start)}`, at: start });
        return;
      }

      case "add_click_zooms": {
        const lo = cmd.start ?? 0;
        const hi = cmd.end ?? dur;
        const clicks = (state.clicks ?? []).filter((c) => c.t >= lo && c.t <= hi).sort((a, b) => a.t - b.t);
        if (clicks.length === 0) {
          return fail("no_clicks", "I couldn't find any clicks in this footage, so no zooms were added.");
        }
        const scale = Math.min(3, Math.max(1.2, cmd.scale ?? 1.8));
        const w = 1 / scale;
        let added = 0;
        clicks.forEach((c, i) => {
          const next = clicks[i + 1]?.t ?? Infinity;
          const start = Math.max(0, c.t - CLICK_ZOOM_LEAD);
          const end = Math.min(dur, c.t + CLICK_ZOOM_HOLD, next - 0.15);
          if (end - start < MIN_ELEMENT) return;
          // Don't stack a second zoom on a click that already has one.
          if (moments.some((m) => (m.effectType === "zoom" || m.effectType === "cursor-focus") && m.startTime <= c.t && m.endTime >= c.t)) return;
          const cx = Math.min(1 - w / 2, Math.max(w / 2, c.x));
          const cy = Math.min(1 - w / 2, Math.max(w / 2, c.y));
          const id = mint();
          add({
            ...baseMoment(id, r3(start), r3(end), "Zoom on click", "zoom"),
            focusRegion: { x: cx - w / 2, y: cy - w / 2, width: w, height: w },
            targetRegionSource: "user",
          } as DetectedMoment);
          added += 1;
        });
        if (added === 0) return fail("no_change", "Every click already has a zoom.");
        changes.push({
          kind: "added",
          elementId: `${prefix}_${seq - added + 1}`,
          effectType: "zoom",
          summary: `Added ${added} zoom${added === 1 ? "" : "s"} on clicks`,
          at: Math.max(0, clicks[0].t - CLICK_ZOOM_LEAD),
        });
        return;
      }

      case "tighten_pauses": {
        if (cutsHidden) return fail("bad_args", "The Cuts layer is hidden, so removed pauses wouldn't show. Show the Cuts layer first.");
        const minPause = Math.max(0.4, cmd.minPause ?? 1.0);
        const keep = Math.min(minPause, Math.max(0.1, cmd.keep ?? 0.35));
        if (!(state.transcript?.status === "complete" && (state.transcript.words?.length ?? 0) > 1) && !(state.silences?.length)) {
          return fail("no_audio", "I couldn't measure the pauses in this video.");
        }
        const allRanges = pauseCuts(state, minPause, keep);
        // A clip with no real speech is one long "pause": refuse rather than
        // delete the video. Pacing edits may never remove most of the footage.
        const removedTotal = allRanges.reduce((s, r) => s + (r.end - r.start), 0);
        if (removedTotal > dur * 0.6) {
          return fail("no_audio", "There's little or no speech here to pace around — tightening pauses would remove most of the video, so I left it alone.");
        }
        const ranges = allRanges.filter(
          // Skip pauses that are already removed.
          (r) => !moments.some((m) => isActiveCut(m) && m.startTime <= r.start + 1e-3 && m.endTime >= r.end - 1e-3)
        );
        if (ranges.length === 0) return fail("no_change", `There are no pauses longer than ${minPause}s to tighten.`);
        let removed = 0;
        let firstId = "";
        for (const r of ranges) {
          const id = mint();
          if (!firstId) firstId = id;
          add(cutMoment(id, r.start, r.end, "Pause"));
          removed += r.end - r.start;
        }
        changes.push({
          kind: "added",
          elementId: firstId,
          effectType: "cut",
          summary: `Tightened ${ranges.length} pause${ranges.length === 1 ? "" : "s"} (−${removed.toFixed(1)}s)`,
          at: ranges[0].start,
        });
        return;
      }

      // ── Composed camera moves ─────────────────────────────────────────────
      case "set_camera": {
        // A move shorter than the minimum is extended to it (the subject is
        // usually still on screen a moment longer) rather than refused —
        // refusing made the model abandon otherwise-correct plans.
        let moveEnd = cmd.end;
        let extended = false;
        if (cmd.end - cmd.start < MIN_MOVE_SECONDS && cmd.start + MIN_MOVE_SECONDS <= dur) {
          moveEnd = r3(cmd.start + MIN_MOVE_SECONDS);
          extended = true;
        }
        if (!inVideo(cmd.start, moveEnd) || moveEnd - cmd.start < MIN_MOVE_SECONDS) {
          return fail("out_of_range", `A camera move needs at least ${MIN_MOVE_SECONDS}s inside the video.`);
        }
        const beats = Array.isArray(cmd.beats) ? cmd.beats.filter((b) => b && [b.at, b.x, b.y, b.zoom].every((v) => typeof v === "number" && Number.isFinite(v))) : [];
        const move = composeMove(beats, moveEnd - cmd.start);
        if ("error" in move) return fail("bad_args", move.error);
        const existing = cmd.elementId ? findMoment(cmd.elementId) : null;
        if (cmd.elementId && (!existing || (existing.effectType !== "zoom" && existing.effectType !== "cursor-focus"))) {
          return fail("not_found", "That zoom no longer exists — the timeline changed.");
        }
        const patch = {
          startTime: r3(cmd.start),
          endTime: r3(moveEnd),
          keyframes: move.keyframes,
          focusRegion: move.focusRegion,
          cameraMotion: { ...(existing?.cameraMotion ?? {}), preset: move.preset },
          targetRegionSource: "user" as const,
          edited: true,
        };
        const where = `${clock(cmd.start)}–${clock(moveEnd)}${extended ? " (extended to the 2s minimum)" : ""}`;
        const what = `${move.keyframes.length} beat${move.keyframes.length === 1 ? "" : "s"}, up to ${move.maxZoom.toFixed(2)}×`;
        if (existing) {
          replace({ ...existing, ...patch } as DetectedMoment);
          changes.push({ kind: "updated", elementId: existing.id, effectType: existing.effectType, summary: `Recomposed the camera move ${where} (${what})`, at: cmd.start });
        } else {
          const id = mint();
          add({ ...baseMoment(id, patch.startTime, patch.endTime, "Camera move", "zoom"), ...patch } as DetectedMoment);
          changes.push({ kind: "added", elementId: id, effectType: "zoom", summary: `Added a camera move ${where} (${what})`, at: cmd.start });
        }
        return;
      }

      case "update_camera": {
        const m = findMoment(cmd.elementId);
        if (!m || (m.effectType !== "zoom" && m.effectType !== "cursor-focus")) return fail("not_found", "That zoom no longer exists — the timeline changed.");
        let next: DetectedMoment = { ...m, edited: true };
        const notes: string[] = [];
        if (cmd.slower) {
          next = { ...next, ...slowerMove(next, 1.5, -25) } as DetectedMoment;
          notes.push("slower push-in");
        }
        if (cmd.faster) {
          next = { ...next, ...slowerMove(next, 0.67, 25) } as DetectedMoment;
          notes.push("quicker push-in");
        }
        if (cmd.holdSeconds != null) {
          if (!(cmd.holdSeconds > 0)) return fail("bad_args", "Hold time must be more than 0 seconds.");
          const held = holdLonger(next, cmd.holdSeconds, dur);
          if (!held) return fail("out_of_range", "There's no room to hold longer — the video ends there.");
          next = { ...next, ...held } as DetectedMoment;
          notes.push(`holds ${fmtS(cmd.holdSeconds)} longer`);
        }
        if (cmd.zoom != null) {
          if (!(cmd.zoom > 1)) return fail("bad_args", "Zoom must be above 1×.");
          const beats = beatsFromKeyframes(next);
          if (beats.length === 0) return fail("bad_args", "That zoom has no camera move to rescale — recompose it with set_camera.");
          const maxZoom = Math.max(...beats.map((b) => b.zoom));
          const move = composeMove(beats.map((b) => ({ ...b, zoom: 1 + (b.zoom - 1) * ((cmd.zoom! - 1) / Math.max(0.01, maxZoom - 1)) })), next.endTime - next.startTime);
          if ("error" in move) return fail("bad_args", move.error);
          next = { ...next, keyframes: move.keyframes, focusRegion: move.focusRegion, cameraMotion: { ...(next.cameraMotion ?? {}), preset: move.preset } };
          notes.push(`up to ${move.maxZoom.toFixed(2)}×`);
        }
        if (notes.length === 0) return fail("no_change", "Nothing to change on that camera move.");
        replace(next);
        changes.push({ kind: "updated", elementId: m.id, effectType: m.effectType, summary: `Updated the camera move: ${notes.join(", ")}`, at: next.startTime });
        return;
      }

      // ── Composed graphics ─────────────────────────────────────────────────
      // ── Effect programs ───────────────────────────────────────────────────
      case "add_effect": {
        const fx = cmd.fx;
        if (!(cmd.at >= 0 && cmd.at < dur)) return fail("out_of_range", `${clock(cmd.at)} is outside the video.`);
        if (!fx || !fx.program || !fx.ref?.effectId) return fail("bad_args", "An effect needs a program and a library reference.");
        const compiled = compileProgram(fx.program);
        if (!compiled.ok) return fail("bad_args", `The effect program is invalid: ${compiled.issues.slice(0, 3).map((x) => `${x.path} ${x.message}`).join("; ")}`);
        const anchor = fx.inputs?.anchor;
        if (fx.program.inputs.includes("anchor") && !(anchor && anchor.x >= 0 && anchor.x <= 1 && anchor.y >= 0 && anchor.y <= 1)) {
          return fail("bad_args", "This effect needs an anchor position (x, y as fractions of the frame).");
        }
        const end = Math.min(dur, cmd.at + fx.program.duration);
        if (end - cmd.at < 0.2) return fail("out_of_range", "No room for the effect there — it would run past the end of the video.");
        const id = mint();
        const params = pickParams(fx.program, fx.params ?? {});
        add({
          ...baseMoment(id, r3(cmd.at), r3(end), fx.ref.name, "fx"),
          fx: { ref: fx.ref, program: fx.program, params, inputs: fx.inputs ?? {} },
        } as DetectedMoment);
        changes.push({ kind: "added", elementId: id, effectType: "fx", summary: `Added "${fx.ref.name}" (v${fx.ref.version}) at ${clock(cmd.at)}`, at: cmd.at });
        return;
      }

      case "update_effect": {
        const m = findMoment(cmd.elementId);
        if (!m || m.effectType !== "fx" || !m.fx) return fail("not_found", "That effect no longer exists — the timeline changed.");
        let fx = { ...m.fx, params: { ...m.fx.params }, inputs: { ...m.fx.inputs } };
        const notes: string[] = [];
        if (cmd.program) {
          const compiled = compileProgram(cmd.program.program);
          if (!compiled.ok) return fail("bad_args", `The new version is invalid: ${compiled.issues.slice(0, 3).map((x) => `${x.path} ${x.message}`).join("; ")}`);
          fx = { ...fx, program: cmd.program.program, ref: { ...fx.ref, version: cmd.program.version }, params: pickParams(cmd.program.program, fx.params) };
          notes.push(`now v${cmd.program.version}${cmd.program.note ? ` (${cmd.program.note})` : ""}`);
        }
        if (cmd.params && Object.keys(cmd.params).length) {
          const declared = new Map(fx.program.params.map((p) => [p.id, p]));
          for (const [key, value] of Object.entries(cmd.params)) {
            const def = declared.get(key);
            if (!def) return fail("bad_args", `"${fx.ref.name}" has no setting "${key}". Settings: ${[...declared.keys()].join(", ") || "none"}.`);
            const before = fx.params[key] ?? def.default;
            if (def.type === "number") {
              if (typeof value !== "number" || !Number.isFinite(value)) return fail("bad_args", `"${key}" takes a number.`);
              const v = r3(Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, value)));
              fx.params[key] = v;
              notes.push(`${def.label || key} ${before} → ${v}`);
            } else {
              if (typeof value !== "string" || !parseHex(value)) return fail("bad_args", `"${key}" takes a colour like "#d4af37".`);
              fx.params[key] = value;
              notes.push(`${def.label || key} ${before} → ${value}`);
            }
          }
        }
        let start = m.startTime;
        if (cmd.at != null) {
          if (!(cmd.at >= 0 && cmd.at < dur)) return fail("out_of_range", `${clock(cmd.at)} is outside the video.`);
          start = r3(cmd.at);
          notes.push(`starts at ${clock(start)}`);
        }
        if (cmd.anchor) {
          if (!(cmd.anchor.x >= 0 && cmd.anchor.x <= 1 && cmd.anchor.y >= 0 && cmd.anchor.y <= 1)) return fail("bad_args", "Anchor x/y are fractions of the frame (0..1).");
          fx.inputs = { ...fx.inputs, anchor: { x: r3(cmd.anchor.x), y: r3(cmd.anchor.y) }, track: undefined };
          if (!fx.inputs.track) delete fx.inputs.track;
          notes.push("moved");
        }
        if (!notes.length) return fail("no_change", "Nothing to change on that effect.");
        const end = Math.min(dur, start + fx.program.duration);
        replace({ ...m, startTime: start, endTime: r3(end), fx, edited: true });
        changes.push({ kind: "updated", elementId: m.id, effectType: "fx", summary: `Updated "${fx.ref.name}": ${notes.join(", ")}`, at: start });
        return;
      }

      case "compose_graphic": {
        if (!(cmd.start >= 0 && cmd.start < dur)) return fail("out_of_range", `Start ${clock(cmd.start)} is outside the video.`);
        let parts: GraphicPart[] = [];
        if (cmd.label?.title?.trim()) {
          parts = dishLabelParts(cmd.label.title.trim(), cmd.label.sub?.trim() || undefined, { tone: cmd.label.tone, x: cmd.label.x, y: cmd.label.y });
        } else if (Array.isArray(cmd.parts)) {
          parts = sanitizeParts(cmd.parts);
        }
        if (parts.length === 0) return fail("bad_args", "A graphic needs at least one part (text, shape or line).");
        // A graphic shorter than this can't be read; the model sometimes asks
        // for 0.5s. Floor it (bounded by the room left in the video).
        const length = Math.min(dur - cmd.start, Math.max(MIN_GRAPHIC_SECONDS, cmd.duration ?? 4));
        if (length < MIN_ELEMENT) return fail("out_of_range", "No room for a graphic there.");
        const id = mint();
        add({ ...baseMoment(id, r3(cmd.start), r3(cmd.start + length), "Graphic", "graphic"), graphic: { parts } } as DetectedMoment);
        const kinds = [...new Set(parts.map((p) => p.kind))].join(" + ");
        const titleText = parts.find((p): p is Extract<GraphicPart, { kind: "text" }> => p.kind === "text")?.text;
        changes.push({ kind: "added", elementId: id, effectType: "graphic", summary: `Added a graphic${titleText ? ` "${titleText}"` : ""} (${kinds}) at ${clock(cmd.start)}`, at: cmd.start });
        return;
      }

      case "update_graphic": {
        const m = findMoment(cmd.elementId);
        if (!m || m.effectType !== "graphic" || !m.graphic) return fail("not_found", "That graphic no longer exists — the timeline changed.");
        let parts = [...m.graphic.parts];
        const notes: string[] = [];
        const pick = (ref: string): GraphicPart[] => {
          const r = ref.trim().toLowerCase();
          const byId = parts.filter((p) => p.id.toLowerCase() === r);
          if (byId.length) return byId;
          if (r === "text" || r === "title" || r === "label") return parts.filter((p) => p.kind === "text").slice(0, 1);
          if (r === "sub" || r === "price" || r === "subtitle" || r === "second text") return parts.filter((p) => p.kind === "text").slice(1, 2);
          if (r === "line" || r === "accent" || r === "rule" || r === "underline") return parts.filter((p) => p.kind === "line");
          if (r === "rect" || r === "box" || r === "shape" || r === "plate" || r === "background") return parts.filter((p) => p.kind === "rect");
          return [];
        };
        for (const ref of cmd.removeParts ?? []) {
          const hit = pick(ref);
          if (!hit.length) return fail("not_found", `This graphic has no "${ref}" to remove.`);
          const ids = new Set(hit.map((p) => p.id));
          parts = parts.filter((p) => !ids.has(p.id));
          notes.push(`removed the ${ref}`);
        }
        for (const st of cmd.setText ?? []) {
          const hit = pick(st.part).filter((p) => p.kind === "text");
          if (!hit.length) return fail("not_found", `This graphic has no "${st.part}" text.`);
          parts = parts.map((p) => (p.id === hit[0].id && p.kind === "text" ? { ...p, text: st.text } : p));
          notes.push(`${st.part} → "${st.text}"`);
        }
        for (const sc of cmd.setColor ?? []) {
          if (!/^#[0-9a-f]{6}$/i.test(sc.color)) return fail("bad_args", `"${sc.color}" isn't a hex colour.`);
          const hit = pick(sc.part);
          if (!hit.length) return fail("not_found", `This graphic has no "${sc.part}".`);
          const ids = new Set(hit.map((p) => p.id));
          parts = parts.map((p) => (!ids.has(p.id) ? p : p.kind === "text" ? { ...p, style: { ...(p.style ?? {}), color: sc.color } } : { ...p, color: sc.color }));
          notes.push(`${sc.part} colour ${sc.color}`);
        }
        if (cmd.move) {
          const { dx, dy } = cmd.move;
          parts = parts.map((p) =>
            p.kind === "line"
              ? { ...p, x: r3(p.x + dx), y: r3(p.y + dy), x2: r3(p.x2 + dx), y2: r3(p.y2 + dy) }
              : { ...p, x: r3(p.x + dx), y: r3(p.y + dy) }
          );
          notes.push("moved");
        }
        const next: DetectedMoment = { ...m, graphic: { parts }, edited: true };
        if (cmd.start != null || cmd.end != null) {
          const s0 = cmd.start ?? m.startTime;
          const e0 = cmd.end ?? m.endTime;
          if (!inVideo(s0, e0) || e0 - s0 < MIN_ELEMENT) return fail("out_of_range", "That timing is outside the video or too short.");
          next.startTime = r3(s0);
          next.endTime = r3(e0);
          notes.push(`timing ${clock(s0)}–${clock(e0)}`);
        }
        if (notes.length === 0) return fail("no_change", "Nothing to change on that graphic.");
        if (parts.length === 0) {
          moments = moments.filter((x) => x.id !== m.id);
          changes.push({ kind: "removed", elementId: m.id, effectType: "graphic", summary: "Removed the graphic (no parts left)", at: m.startTime });
          return;
        }
        replace(next);
        changes.push({ kind: "updated", elementId: m.id, effectType: "graphic", summary: `Updated the graphic: ${notes.join(", ")}`, at: next.startTime });
        return;
      }

      case "update_element": {
        const m = findMoment(cmd.elementId);
        if (!m) return fail("not_found", "That element no longer exists — the timeline changed.");
        const next: DetectedMoment = { ...m, edited: true };
        const notes: string[] = [];
        if (cmd.start != null || cmd.end != null) {
          const s = cmd.start ?? m.startTime;
          const e = cmd.end ?? m.endTime;
          if (!inVideo(s, e) || e - s < MIN_ELEMENT) return fail("out_of_range", `${clock(s)}–${clock(e)} is outside the video or shorter than ${MIN_ELEMENT}s.`);
          next.startTime = r3(s);
          next.endTime = r3(e);
          notes.push(`timing ${clock(s)}–${clock(e)}`);
        }
        if (cmd.text != null) {
          if (!setText(next, cmd.text)) return fail("bad_args", `A ${m.effectType} has no text to change.`);
          notes.push(`text "${cmd.text}"`);
        }
        if (cmd.position || cmd.color || cmd.backgroundColor || cmd.fontScale != null || cmd.animation) {
          if (!hasTextStyle(m)) return fail("bad_args", `Position, colour and animation only apply to text and graphics, not a ${m.effectType}.`);
          styleGraphic(next, cmd, state);
          if (cmd.position) notes.push(`moved to ${cmd.position.replace("-", " ")}`);
          if (cmd.color) notes.push(`text colour ${cmd.color}`);
          if (cmd.backgroundColor) notes.push(`background ${cmd.backgroundColor}`);
          if (cmd.fontScale != null) notes.push("size");
          if (cmd.animation) notes.push(`${cmd.animation} entrance`);
        }
        if (cmd.enabled != null) {
          next.enabled = cmd.enabled;
          notes.push(cmd.enabled ? "shown" : "hidden");
        }
        if (notes.length === 0) return fail("no_change", "Nothing to change.");
        replace(next);
        changes.push({ kind: "updated", elementId: m.id, effectType: m.effectType, summary: `Updated ${describe(m)}: ${notes.join(", ")}`, at: next.startTime });
        return;
      }

      case "shift_element": {
        const m = findMoment(cmd.elementId);
        if (!m) return fail("not_found", "That element no longer exists — the timeline changed.");
        const s = m.startTime + cmd.seconds;
        const e = m.endTime + cmd.seconds;
        if (!Number.isFinite(cmd.seconds) || cmd.seconds === 0) return fail("bad_args", "Shift amount must be a non-zero number of seconds.");
        if (s < 0 || e > dur) return fail("out_of_range", `Moving ${describe(m)} by ${cmd.seconds}s would push it outside the video.`);
        replace({ ...m, startTime: r3(s), endTime: r3(e), edited: true });
        changes.push({ kind: "updated", elementId: m.id, effectType: m.effectType, summary: `${cmd.seconds > 0 ? "Delayed" : "Moved earlier"} ${describe(m)} by ${fmtS(Math.abs(cmd.seconds))} (now ${clock(s)})`, at: s });
        return;
      }

      case "split_element": {
        const m = findMoment(cmd.elementId);
        if (!m) return fail("not_found", "That element no longer exists — the timeline changed.");
        const id = mint();
        const res = splitMoment(m, cmd.at, id);
        if (!res) return fail("bad_args", `Can't split ${describe(m)} at ${clock(cmd.at)} — both halves must be at least 0.3s.`);
        replace(res.left);
        add(res.right);
        changes.push({ kind: "added", elementId: id, effectType: m.effectType, summary: `Split ${describe(m)} at ${clock(cmd.at)}`, at: cmd.at });
        return;
      }

      case "remove_element": {
        const m = findMoment(cmd.elementId);
        if (!m) return fail("not_found", "That element no longer exists — the timeline changed.");
        moments = moments.filter((x) => x.id !== m.id);
        changes.push({ kind: "removed", elementId: m.id, effectType: m.effectType, summary: `Removed ${describe(m)}`, at: m.startTime });
        return;
      }

      default:
        return fail("unknown_op", `Unknown command "${(cmd as { op: string }).op}".`);
    }
  });

  const realChanges = changes.filter((c) => c.summary);
  if (errors.length > 0 && !(opts.partial && realChanges.length > 0)) return { ok: false, errors };
  return { ok: true, moments, changes: realChanges, clipRenames, errors };
}

/** Longest a zoom on one click holds (s) — the next click ends it sooner. */
const CLICK_ZOOM_HOLD = 2.4;
/** Lead-in so the zoom has arrived when the click lands. */
const CLICK_ZOOM_LEAD = 0.6;

/**
 * The pauses `tighten_pauses` would cut: gaps between transcript words longer
 * than `minPause`, else audio silences. Each is shortened to `keep` seconds,
 * centred so the breath is split between the two sentences.
 */
export function pauseCuts(
  state: Pick<EditState, "transcript" | "silences" | "sourceDuration">,
  minPause: number,
  keep: number
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const words = state.transcript?.status === "complete" ? state.transcript.words ?? [] : [];
  const gaps: { start: number; end: number }[] = [];
  if (words.length > 1) {
    const ws = [...words].sort((a, b) => a.startTime - b.startTime);
    // Leading silence before the first word.
    if (ws[0].startTime > minPause) gaps.push({ start: 0, end: ws[0].startTime });
    for (let i = 1; i < ws.length; i++) gaps.push({ start: ws[i - 1].endTime, end: ws[i].startTime });
    const last = ws[ws.length - 1].endTime;
    if (state.sourceDuration - last > minPause) gaps.push({ start: last, end: state.sourceDuration });
  } else {
    gaps.push(...(state.silences ?? []));
  }
  for (const g of gaps) {
    const len = g.end - g.start;
    if (len <= minPause) continue;
    const edgeKeep = g.start <= 0.01 || g.end >= state.sourceDuration - 0.01 ? 0.15 : keep / 2;
    const start = g.start <= 0.01 ? 0 : g.start + edgeKeep;
    const end = g.end >= state.sourceDuration - 0.01 ? state.sourceDuration : g.end - edgeKeep;
    if (end - start >= 0.25) out.push({ start: r3(start), end: r3(end) });
  }
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function baseMoment(id: string, start: number, end: number, label: string, effectType: DetectedMoment["effectType"]): DetectedMoment {
  return {
    id,
    startTime: start,
    endTime: end,
    label,
    reason: "Requested in chat.",
    focusRegion: { x: 0, y: 0, width: 1, height: 1 },
    effectType,
    enabled: true,
    source: "user",
    provenance: "user",
    edited: true,
    intensity: 0.7,
    attentionScore: 0.6,
  } as DetectedMoment;
}

function cutMoment(id: string, start: number, end: number, label: string): DetectedMoment {
  return { ...baseMoment(id, start, end, label, "cut"), cut: { ...DEFAULT_CUT } };
}

/** A short human name for an element in chat lines. */
export function describe(m: DetectedMoment): string {
  const text = textOf(m);
  const kind =
    m.preset?.id === "callout-lower-third"
      ? "lower third"
      : m.effectType === "text-overlay"
        ? "title"
        : m.effectType === "zoom" && (m.keyframes?.length ?? 0) > 1
          ? "camera move"
          : m.effectType === "fx"
            ? `effect "${m.fx?.ref.name ?? "custom"}"`
            : m.effectType.replace("-", " ");
  return text ? `${kind} "${text.length > 32 ? `${text.slice(0, 30)}…` : text}"` : kind;
}

export function textOf(m: DetectedMoment): string | null {
  return (
    m.graphic?.parts.find((p): p is Extract<GraphicPart, { kind: "text" }> => p.kind === "text" && !!p.text.trim())?.text ??
    m.textOverlay?.text ??
    m.hookText?.text ??
    m.captions?.text ??
    m.callout?.text ??
    m.brandingCta?.ctaText ??
    null
  );
}

function setText(m: DetectedMoment, text: string): boolean {
  if (m.graphic) {
    const first = m.graphic.parts.find((p) => p.kind === "text");
    if (!first) return false;
    m.graphic = { parts: m.graphic.parts.map((p) => (p.id === first.id && p.kind === "text" ? { ...p, text } : p)) };
  } else if (m.textOverlay) m.textOverlay = { ...m.textOverlay, text };
  else if (m.hookText) m.hookText = { ...m.hookText, text };
  else if (m.captions) m.captions = { ...m.captions, text, words: undefined };
  else if (m.callout) m.callout = { ...m.callout, text };
  else if (m.brandingCta) m.brandingCta = { ...m.brandingCta, ctaText: text };
  else return false;
  return true;
}

function hasTextStyle(m: DetectedMoment): boolean {
  return ["captions", "hook-text", "text-overlay", "callout", "branding-cta"].includes(m.effectType);
}

/**
 * Position/colour/animation overrides, written into the moment's persisted
 * `textStyle` / `animation` — the SAME fields the inspector edits and every
 * renderer reads (overlay-draw.ts), so preview and export cannot diverge.
 */
function styleGraphic(
  m: DetectedMoment,
  cmd: { position?: GraphicPosition; color?: string; backgroundColor?: string; fontScale?: number; animation?: EntranceAnimation },
  state: Pick<EditState, "canvasWidth" | "canvasHeight">
): void {
  const style: TextStyle = { ...(m.textStyle ?? {}) };
  if (cmd.position) Object.assign(style, positionStyle(cmd.position, state.canvasWidth, state.canvasHeight));
  if (cmd.color && /^#[0-9a-f]{6}$/i.test(cmd.color)) style.color = cmd.color.toLowerCase();
  if (cmd.backgroundColor && /^#[0-9a-f]{6}$/i.test(cmd.backgroundColor)) {
    style.backgroundColor = cmd.backgroundColor.toLowerCase();
    if (!style.background || style.background === "none") style.background = "box";
  }
  if (cmd.fontScale != null && cmd.fontScale > 0) style.fontScale = Math.min(0.2, Math.max(0.015, cmd.fontScale));
  m.textStyle = style;
  if (cmd.animation) {
    const anim = entranceAnimation(cmd.animation);
    if (anim) m.animation = anim;
    else delete m.animation;
  }
}

/** A named position → custom anchor INSIDE the platform safe area (presets/layout.ts). */
export function positionStyle(pos: GraphicPosition, canvasW: number, canvasH: number): Pick<TextStyle, "position" | "customX" | "customY" | "align"> {
  const s = safeAreaFor(aspectOf(canvasW, canvasH));
  const top = s.top;
  const bottom = 1 - s.bottom;
  const h = bottom - top;
  const left = s.left + 0.02;
  const right = 1 - s.right - 0.02;
  const cx = (s.left + (1 - s.right)) / 2;
  const row = pos.startsWith("top") ? top + h * 0.08 : pos.startsWith("bottom") ? bottom - h * 0.06 : top + h * 0.5;
  const align: TextStyle["align"] = pos.endsWith("left") ? "left" : pos.endsWith("right") ? "right" : "center";
  const x = align === "left" ? left : align === "right" ? right : cx;
  return { position: "custom", customX: Math.round(x * 1e4) / 1e4, customY: Math.round(row * 1e4) / 1e4, align };
}

export function entranceAnimation(kind: EntranceAnimation): PresetAnimation | null {
  switch (kind) {
    case "slide-left":
      return {
        in: { durationSeconds: 0.7, ease: "spring", translateX: [-0.2, 0], opacity: [0, 1] },
        out: { durationSeconds: 0.4, ease: "ease-in", opacity: [1, 0], translateX: [0, -0.05] },
      };
    case "slide-up":
      return {
        in: { durationSeconds: 0.6, ease: "ease-out", translateY: [0.06, 0], opacity: [0, 1] },
        out: { durationSeconds: 0.35, ease: "ease-in", opacity: [1, 0] },
      };
    case "fade":
      return {
        in: { durationSeconds: 0.5, ease: "ease-out", opacity: [0, 1] },
        out: { durationSeconds: 0.4, ease: "ease-in", opacity: [1, 0] },
      };
    case "pop":
      return {
        in: { durationSeconds: 0.45, ease: "spring", scale: [0.7, 1], opacity: [0, 1] },
        out: { durationSeconds: 0.3, ease: "ease-in", opacity: [1, 0], scale: [1, 0.9] },
      };
    case "none":
      return null;
  }
}

/** Model-supplied parts → valid parts (ids assigned, numbers clamped, junk dropped). */
export function sanitizeParts(input: readonly unknown[]): GraphicPart[] {
  const out: GraphicPart[] = [];
  const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  const hex = (v: unknown, dflt: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : dflt);
  input.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") return;
    const p = raw as Record<string, unknown>;
    const id = typeof p.id === "string" && p.id.trim() ? p.id.trim().slice(0, 32) : `part${i + 1}`;
    const base = {
      id,
      x: num(p.x, 0, 1, 0.1),
      y: num(p.y, 0, 1, 0.8),
      z: num(p.z, -10, 10, 0),
      ...(typeof p.opacity === "number" ? { opacity: num(p.opacity, 0, 1, 1) } : {}),
      ...(typeof p.delay === "number" ? { delay: num(p.delay, 0, 10, 0) } : {}),
      ...(p.animation && typeof p.animation === "object" ? { animation: p.animation as PresetAnimation } : {}),
    };
    if (p.kind === "text" && typeof p.text === "string" && p.text.trim()) {
      out.push({ ...base, kind: "text", text: p.text.slice(0, 200), ...(p.style && typeof p.style === "object" ? { style: p.style as TextStyle } : {}), ...(typeof p.maxWidth === "number" ? { maxWidth: num(p.maxWidth, 0.1, 1, 0.6) } : {}) } as GraphicPart);
    } else if (p.kind === "rect") {
      out.push({ ...base, kind: "rect", w: num(p.w, 0.005, 1, 0.2), h: num(p.h, 0.005, 1, 0.1), color: hex(p.color, "#000000"), ...(typeof p.radius === "number" ? { radius: num(p.radius, 0, 1, 0) } : {}) });
    } else if (p.kind === "line") {
      out.push({ ...base, kind: "line", x2: num(p.x2, 0, 1, Math.min(1, base.x + 0.1)), y2: num(p.y2, 0, 1, base.y), color: hex(p.color, "#ffffff"), thickness: num(p.thickness, 0.001, 0.05, 0.006) });
    }
  });
  return out;
}
