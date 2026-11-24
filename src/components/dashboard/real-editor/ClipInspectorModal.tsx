"use client";

/**
 * The clip editor for SEQUENCE projects — the manual controls for the
 * footage capabilities (speed / ramp, fades, transition, audio, freeze hold,
 * detach, delete). Every control calls `runCapability`, i.e. the SAME registry
 * operation, validator and executor the chat uses, so a manual change and the
 * equivalent chat request produce the same timeline state.
 */

import * as React from "react";
import { X as XIcon, Snowflake, Scissors, Trash2, Volume2 } from "lucide-react";
import { useEditorReal } from "./context";
import { EditorDialogShell } from "./EditorDialog";
import { rateAt, type SequenceClip, type SequenceFreeze } from "@/lib/timeline/sequence";
import { describeLayout, resolveHolds } from "@/lib/timeline/evaluate";
import { useClockRef } from "./playback-clock";

const FIELD = "h-8 w-full rounded-lg border border-white/10 bg-white/[0.03] px-2 text-[12px] text-white focus:border-violet-400/50 focus:outline-none focus:ring-2 focus:ring-violet-400/30";
const LABEL = "text-[11px] text-fog";
const BTN = "inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-white/90 transition-colors hover:bg-white/[0.08] disabled:opacity-50";

function Num({ label, value, min, max, step = 0.1, onCommit, testId }: { label: string; value: number; min?: number; max?: number; step?: number; onCommit: (v: number) => void; testId?: string }) {
  const [draft, setDraft] = React.useState(String(value));
  // Re-seed the draft when the committed value changes (derived-state pattern, no effect).
  const [seen, setSeen] = React.useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(String(value));
  }
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <input
        data-testid={testId}
        type="number"
        className={FIELD}
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = Number(draft);
          if (Number.isFinite(v) && v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export function ClipInspectorModal() {
  const { project, sequenceMode, selectedClipId, setSelectedClipId, runCapability, seek } = useEditorReal();
  const clockRef = useClockRef();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const seq = project.sequence;
  const index = seq?.items.findIndex((i) => i.id === selectedClipId) ?? -1;
  const item = index >= 0 ? seq!.items[index] : null;
  const visible = sequenceMode && !!item;
  const holds = React.useMemo(() => (seq ? safeHolds(seq, project.analysis?.detectedMoments ?? []) : new Map<string, number>()), [seq, project.analysis?.detectedMoments]);

  const run = async (capability: string, args: Record<string, unknown>) => {
    if (!item || busy) return;
    setBusy(true);
    setError(null);
    const err = await runCapability(capability, { clip_id: item.id, ...args });
    setBusy(false);
    if (err) setError(err);
  };

  if (!visible || !item) return null;
  const clip = item.kind === "clip" ? (item as SequenceClip) : null;
  const freeze = item.kind === "freeze" ? (item as SequenceFreeze) : null;
  const rate = clip ? rateAt(clip.speed, clip.sourceIn) : 0;
  const ramp = clip?.speed && clip.speed.keyframes.length > 1;
  const moments = (project.analysis?.detectedMoments ?? []).filter((m) => m.effectType !== "captions" && m.effectType !== "cut" && m.effectType !== "speed-up");

  return (
    <EditorDialogShell open={visible} onClose={() => setSelectedClipId(null)} backdrop={false} closeOnOutsidePress size="editing" ariaLabel="Edit clip" className="max-h-[80vh]">
      <button type="button" onClick={() => setSelectedClipId(null)} aria-label="Close clip settings" className="absolute right-2.5 top-2.5 z-20 inline-flex size-10 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.06] text-fog hover:text-white">
        <XIcon size={15} />
      </button>
      <div className="relative z-[1] min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4" data-testid="clip-inspector" data-clip-id={item.id}>
        <header>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">{freeze ? "Frozen frame" : item.assetId === "source" ? "Clip" : `Clip · ${item.assetId}`}</div>
          <div className="mt-0.5 text-[12.5px] text-white/85">
            {clip ? `${clip.sourceIn.toFixed(2)}s – ${clip.sourceOut.toFixed(2)}s of ${clip.assetId === "source" ? "the recording" : clip.assetId}` : `frame at ${freeze!.sourceAt.toFixed(2)}s`} · position {index + 1} of {seq!.items.length}
          </div>
        </header>
        {error && <p className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1.5 text-[11.5px] text-rose-200" data-testid="clip-inspector-error">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} disabled={busy || !clip} data-testid="clip-split" onClick={() => clip && run("split_clip", { at: Math.max(0.1, (clockRef.current ?? 0) - clipStart(project, item.id)) })}>
            <Scissors size={12} /> Split at playhead
          </button>
          <button type="button" className={BTN} disabled={busy || !clip} data-testid="clip-freeze" onClick={() => clip && run("freeze_frame", { at: Math.max(0, (clockRef.current ?? 0) - clipStart(project, item.id)), duration: 2 })}>
            <Snowflake size={12} /> Freeze frame here
          </button>
          <button type="button" className={BTN} disabled={busy} data-testid="clip-delete" onClick={() => run("delete_item", {})}>
            <Trash2 size={12} /> Delete
          </button>
        </div>

        {clip && (
          <section className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">Speed</h4>
            <div className="grid grid-cols-2 gap-2">
              <Num label={ramp ? "Rate (ramp set)" : "Rate (1 = normal, 0.5 = half)"} value={Number(rate.toFixed(3))} min={0.1} max={16} step={0.05} testId="clip-rate" onCommit={(v) => run("set_clip_speed", { rate: v })} />
              <label className="block">
                <span className={LABEL}>Pitch</span>
                <select className={FIELD} value={clip.audio?.pitch ?? "follow"} onChange={(e) => run("set_clip_speed", { pitch: e.target.value })}>
                  <option value="follow">Follows speed</option>
                  <option value="preserve">Preserved</option>
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Num label="Ramp to (rate at end)" value={clip.speed?.keyframes.at(-1)?.rate ?? rate} min={0.1} max={16} step={0.05} testId="clip-ramp-to" onCommit={(v) => run("set_clip_speed", { ramp_start: 0, ramp_from_rate: rate, ramp_to_rate: v })} />
            </div>
          </section>
        )}

        {freeze && (
          <section className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">Hold</h4>
            <div className="grid grid-cols-2 gap-2">
              <Num label={`Duration (s)${freeze.linkedTo ? " — linked" : ""}`} value={Number((holds.get(freeze.id) ?? freeze.duration ?? 2).toFixed(2))} min={0.1} step={0.1} testId="freeze-duration" onCommit={(v) => run("set_hold", { duration: v })} />
              <label className="block">
                <span className={LABEL}>As long as animation</span>
                <select className={FIELD} data-testid="freeze-link" value={freeze.linkedTo && "momentId" in freeze.linkedTo ? freeze.linkedTo.momentId : ""} onChange={(e) => (e.target.value ? run("set_hold", { link_moment_id: e.target.value }) : run("set_hold", { duration: holds.get(freeze.id) ?? 2 }))}>
                  <option value="">Fixed duration</option>
                  {moments.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label || m.effectType} ({(m.endTime - m.startTime).toFixed(1)}s)
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        )}

        <section className="space-y-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">Fades & transition</h4>
          <div className="grid grid-cols-2 gap-2">
            <Num label="Fade in (s)" value={item.opacity?.fadeIn ?? 0} min={0} step={0.1} testId="clip-fade-in" onCommit={(v) => run("set_fade", { fade_in: v })} />
            <Num label="Fade out (s)" value={item.opacity?.fadeOut ?? 0} min={0} step={0.1} testId="clip-fade-out" onCommit={(v) => run("set_fade", { fade_out: v })} />
          </div>
          {index > 0 && (
            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className={LABEL}>Into this clip</span>
                <select className={FIELD} data-testid="clip-transition" value={item.transitionIn?.kind ?? "none"} onChange={(e) => run("set_transition", { kind: e.target.value, duration: item.transitionIn?.duration ?? 0.75 })}>
                  <option value="none">Cut</option>
                  <option value="dissolve">Cross-dissolve</option>
                  <option value="dip">Dip to colour</option>
                </select>
              </label>
              <Num label="Duration (s)" value={item.transitionIn?.duration ?? 0.75} min={0.1} step={0.05} testId="clip-transition-duration" onCommit={(v) => run("set_transition", { kind: item.transitionIn?.kind ?? "dissolve", duration: v })} />
              <label className="block">
                <span className={LABEL}>Dip colour</span>
                <input type="color" className="h-8 w-full rounded-lg border border-white/10 bg-transparent" value={item.transitionIn?.color ?? "#000000"} onChange={(e) => run("set_transition", { kind: "dip", duration: item.transitionIn?.duration ?? 0.75, color: e.target.value })} />
              </label>
            </div>
          )}
        </section>

        {clip && (
          <section className="space-y-2">
            <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-fog">
              <Volume2 size={12} /> Audio
            </h4>
            {clip.audio?.linked === false ? (
              <p className="text-[11.5px] text-fog">Detached — this clip is picture only; its sound is on its own track.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <Num label="Gain" value={clip.audio?.gain ?? 1} min={0} max={4} step={0.05} testId="clip-gain" onCommit={(v) => run("set_clip_audio", { gain: v })} />
                <Num label="Fade in (s)" value={clip.audio?.fadeIn ?? 0} min={0} step={0.1} onCommit={(v) => run("set_clip_audio", { fade_in: v })} />
                <Num label="Fade out (s)" value={clip.audio?.fadeOut ?? 0} min={0} step={0.1} onCommit={(v) => run("set_clip_audio", { fade_out: v })} />
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BTN} disabled={busy} onClick={() => run("set_clip_audio", { muted: !clip.audio?.muted })}>
                {clip.audio?.muted ? "Unmute" : "Mute"}
              </button>
              {clip.audio?.linked !== false && (
                <button type="button" className={BTN} disabled={busy} data-testid="clip-detach-audio" onClick={() => run("detach_audio", {})}>
                  Detach audio
                </button>
              )}
              <button type="button" className={BTN} onClick={() => seek(clipStart(project, item.id))}>
                Jump to clip
              </button>
            </div>
          </section>
        )}
      </div>
    </EditorDialogShell>
  );
}

function safeHolds(seq: NonNullable<ReturnType<typeof useEditorReal>["project"]["sequence"]>, moments: NonNullable<ReturnType<typeof useEditorReal>["project"]["analysis"]>["detectedMoments"]) {
  try {
    return resolveHolds(seq, moments);
  } catch {
    return new Map<string, number>();
  }
}

/** Sequence start of an item (its cut), from the evaluator's layout. */
function clipStart(project: ReturnType<typeof useEditorReal>["project"], itemId: string): number {
  try {
    return describeLayout({ sequence: project.sequence ?? null, moments: project.analysis?.detectedMoments ?? [], assets: project.assets ?? [], sourceDuration: project.duration ?? 0 }).find((l) => l.itemId === itemId)?.cut ?? 0;
  } catch {
    return 0;
  }
}
