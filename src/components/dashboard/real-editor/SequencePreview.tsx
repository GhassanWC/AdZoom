"use client";

/**
 * The preview for SEQUENCE projects (several assets, freezes, ramps, fades,
 * dissolves, audio mix).
 *
 * It does not play a <video> and decorate it — it draws every frame with the
 * SAME `composeEvaluatedFrame` the exporters use, fed by `evaluateTimeline`
 * at an OUTPUT-time clock. Hidden <video> elements (one per asset per layer
 * slot) are only frame sources and audio outlets: each tick they are kept
 * at the evaluator's source time and rate (paused on a freeze), with their
 * volume set to the evaluator's gain. Parity with export is therefore by
 * construction: one timing contract, one compositor.
 *
 * The clock is sequence time; the context's `seek`/`togglePlay` delegate to
 * the handle this component registers (see context.tsx).
 */

import * as React from "react";
import { useEditorReal } from "./context";
import { useSetPlaybackTime } from "./playback-clock";
import { buildRenderRecipe } from "@/lib/render/recipe";
import { composeEvaluatedFrame } from "@/lib/render/compose-frame";
import { evaluateTimeline, outputDurationOf, type EvalLayer, type TimelineRevision } from "@/lib/timeline/evaluate";
import { SOURCE_ASSET_ID } from "@/lib/timeline/sequence";
import { visibleMoments } from "@/lib/timeline/layers";
import { speechWindowsOf } from "@/lib/timeline/speech";
import { DEFAULT_EFFECTS_SETTINGS } from "@/lib/firebase/schema";
import { cn } from "@/lib/cn";

export interface SequencePlayerHandle {
  seek(t: number): void;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  duration(): number;
}

/** Drift beyond which a hidden element is re-seeked to the evaluator's source time. */
const DRIFT_SECONDS = 0.14;

interface Slot {
  el: HTMLVideoElement;
  assetId: string;
  /** Source time last requested (so a frozen frame isn't re-seeked every tick). */
  wantedAt: number | null;
  seeking: boolean;
  seekStartedAt: number;
}

export function SequencePreview({ fill = false }: { fill?: boolean }) {
  const { project, layers, previewMode, playing, setPlaying, setDuration, muted, volume, registerSequencePlayer, exporting } = useEditorReal();
  const setCurrentTime = useSetPlaybackTime();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const poolRef = React.useRef<Map<string, Slot>>(new Map());
  const clockRef = React.useRef({ t: 0, playing: false, startedAt: 0, startT: 0 });
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const assetUrls = React.useMemo(() => {
    const m: Record<string, string> = { [SOURCE_ASSET_ID]: project.originalVideoUrl ?? "" };
    for (const a of project.assets ?? []) m[a.id] = a.url;
    return m;
  }, [project.originalVideoUrl, project.assets]);

  // The revision the evaluator sees: layer-gated moments, exactly like export.
  const rev: TimelineRevision = React.useMemo(
    () => ({
      sequence: project.sequence ?? null,
      moments: previewMode ? visibleMoments(project.analysis?.detectedMoments ?? [], layers) : [],
      assets: project.assets ?? [],
      sourceDuration: project.duration ?? 0,
      speech: speechWindowsOf(project),
    }),
    [project, layers, previewMode]
  );
  const revRef = React.useRef(rev);
  React.useEffect(() => {
    revRef.current = rev;
  }, [rev]);

  // One recipe for the preview — the export geometry at preview resolution.
  const recipe = React.useMemo(() => {
    const effects = { ...DEFAULT_EFFECTS_SETTINGS, ...(project.effectsSettings ?? {}) };
    return buildRenderRecipe({
      sourceWidth: project.width || 1920,
      sourceHeight: project.height || 1080,
      fps: 30,
      resolution: "720p",
      format: "Source",
      sourceDuration: project.duration ?? 0,
      moments: rev.moments,
      effects,
      visualAnalysis: project.visualAnalysis,
      sourceCrop: project.sourceCrop ?? null,
      applyWatermark: false,
      sequence: project.sequence ?? null,
      assets: project.assets ?? [],
      speech: rev.speech,
    });
  }, [project.width, project.height, project.duration, project.effectsSettings, project.visualAnalysis, project.sourceCrop, project.sequence, project.assets, rev]);
  const recipeRef = React.useRef(recipe);
  React.useEffect(() => {
    recipeRef.current = recipe;
  }, [recipe]);

  const outputDuration = React.useMemo(() => {
    try {
      return outputDurationOf(rev);
    } catch {
      return 0;
    }
  }, [rev]);
  React.useEffect(() => {
    setDuration(outputDuration);
  }, [outputDuration, setDuration]);

  // ── hidden element pool ──────────────────────────────────────────────────
  const slotFor = React.useCallback(
    (assetId: string, index: number): Slot | null => {
      const key = `${assetId}#${index}`;
      const hit = poolRef.current.get(key);
      if (hit) return hit;
      const url = assetUrls[assetId];
      const host = hostRef.current;
      if (!url || !host) return null;
      const el = document.createElement("video");
      el.src = url;
      el.preload = "auto";
      el.playsInline = true;
      el.muted = true;
      el.style.position = "absolute";
      el.style.width = "1px";
      el.style.height = "1px";
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
      el.addEventListener("error", () => setLoadError(`Couldn't load media "${assetId}".`));
      host.appendChild(el);
      const slot: Slot = { el, assetId, wantedAt: null, seeking: false, seekStartedAt: 0 };
      el.addEventListener("seeked", () => {
        slot.seeking = false;
      });
      // A seek issued before metadata exists may never report 'seeked' in some
      // browsers; re-issue it once the element knows its duration.
      el.addEventListener("loadedmetadata", () => {
        slot.seeking = false;
        slot.wantedAt = null;
      });
      el.load();
      poolRef.current.set(key, slot);
      return slot;
    },
    [assetUrls]
  );
  // Start loading every asset the sequence uses as soon as the preview mounts,
  // so the first seek/play doesn't wait on a cold fetch.
  React.useEffect(() => {
    const seq = project.sequence;
    const ids = new Set<string>([SOURCE_ASSET_ID]);
    for (const it of seq?.items ?? []) {
      ids.add(it.assetId);
      if (it.kind === "clip" && it.audio?.assetId) ids.add(it.audio.assetId);
    }
    for (const tr of seq?.audioTracks ?? []) ids.add(tr.assetId);
    for (const id of ids) slotFor(id, 0);
  }, [project.sequence, slotFor]);
  React.useEffect(() => {
    const pool = poolRef.current;
    return () => {
      for (const s of pool.values()) {
        s.el.pause();
        s.el.removeAttribute("src");
        s.el.remove();
      }
      pool.clear();
    };
  }, []);

  /** Keep one element at the evaluator's source time / rate / volume. */
  const syncSlot = (slot: Slot, sourceTime: number, rate: number, frozen: boolean, gain: number, isPlaying: boolean) => {
    const el = slot.el;
    const wantPlay = isPlaying && !frozen && rate > 0;
    // Seek watchdog: a 'seeked' that never arrives must not freeze the slot.
    if (slot.seeking && performance.now() - slot.seekStartedAt > 2000) slot.seeking = false;
    if (el.readyState >= 1 && !slot.seeking && (slot.wantedAt == null || Math.abs(el.currentTime - sourceTime) > DRIFT_SECONDS || (!wantPlay && Math.abs(el.currentTime - sourceTime) > 1 / 60))) {
      if (Number.isFinite(sourceTime)) {
        slot.seeking = true;
        slot.seekStartedAt = performance.now();
        slot.wantedAt = sourceTime;
        try {
          el.currentTime = Math.max(0, sourceTime);
        } catch {
          slot.seeking = false;
        }
      }
    }
    const r = Math.max(0.0625, Math.min(16, rate || 1));
    if (Math.abs(el.playbackRate - r) > 0.001) {
      el.playbackRate = r;
      try {
        (el as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
      } catch {
        /* unsupported */
      }
    }
    const vol = Math.max(0, Math.min(1, gain * volume));
    el.muted = muted || vol <= 0.001;
    el.volume = vol;
    if (wantPlay && el.paused) el.play().catch(() => {});
    if (!wantPlay && !el.paused) el.pause();
  };

  // ── the tick ─────────────────────────────────────────────────────────────
  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      const c = clockRef.current;
      const rev = revRef.current;
      const recipe = recipeRef.current;
      const canvas = canvasRef.current;
      const dur = outputDuration;
      if (c.playing) {
        c.t = c.startT + (performance.now() - c.startedAt) / 1000;
        if (c.t >= dur) {
          c.t = Math.max(0, dur - 1 / 60);
          c.playing = false;
          setPlaying(false);
        }
        setCurrentTime(c.t);
      }
      if (canvas && !exporting && dur > 0) {
        let ev;
        try {
          ev = evaluateTimeline(rev, c.t);
        } catch {
          ev = null;
        }
        if (ev) {
          const used = new Set<string>();
          const frames = new Map<string, HTMLVideoElement>();
          const seen = new Map<string, number>();
          for (const layer of ev.layers) {
            const idx = seen.get(layer.assetId) ?? 0;
            seen.set(layer.assetId, idx + 1);
            const slot = slotFor(layer.assetId, idx);
            if (!slot) continue;
            used.add(`${layer.assetId}#${idx}`);
            const stem = ev.audio.find((s) => s.id === `item:${layer.itemId}`);
            const rate = stem?.rate ?? (layer.frozen ? 0 : 1);
            syncSlot(slot, layer.sourceTime, rate, layer.frozen, stem?.gain ?? 0, c.playing);
            if (slot.el.readyState >= 2) frames.set(layer.itemId, slot.el);
          }
          // Independent audio tracks: audible, never drawn.
          for (const stem of ev.audio) {
            if (!stem.id.startsWith("track:")) continue;
            const idx = seen.get(stem.assetId) ?? 0;
            seen.set(stem.assetId, idx + 1);
            const slot = slotFor(stem.assetId, idx);
            if (!slot) continue;
            used.add(`${stem.assetId}#${idx}`);
            syncSlot(slot, stem.sourceTime, 1, false, stem.gain, c.playing);
          }
          for (const [key, slot] of poolRef.current) if (!used.has(key) && !slot.el.paused) slot.el.pause();
          const ctx = canvas.getContext("2d");
          if (ctx) composeEvaluatedFrame(ctx, ev, (layer: EvalLayer) => frames.get(layer.itemId) ?? null, recipe);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputDuration, exporting, slotFor, muted, volume]);

  // ── the handle the context drives ─────────────────────────────────────────
  React.useEffect(() => {
    const handle: SequencePlayerHandle = {
      seek: (t) => {
        const c = clockRef.current;
        c.t = Math.max(0, Math.min(Math.max(0, outputDuration - 1 / 60), t));
        if (c.playing) {
          c.startT = c.t;
          c.startedAt = performance.now();
        }
        setCurrentTime(c.t);
      },
      play: () => {
        const c = clockRef.current;
        if (c.t >= outputDuration - 1 / 60) c.t = 0;
        c.playing = true;
        c.startT = c.t;
        c.startedAt = performance.now();
        setPlaying(true);
      },
      pause: () => {
        clockRef.current.playing = false;
        setPlaying(false);
      },
      isPlaying: () => clockRef.current.playing,
      duration: () => outputDuration,
    };
    registerSequencePlayer(handle);
    // Dev-only hook for the browser verification harness (no UI depends on it).
    if (process.env.NODE_ENV !== "production") {
      const w = window as Window & { __framevoSeek?: (t: number) => void; __framevoPreviewDebug?: () => unknown };
      w.__framevoSeek = (t) => {
        handle.pause();
        handle.seek(t);
      };
      w.__framevoPreviewDebug = () => [...poolRef.current.entries()].map(([k, s]) => ({ k, readyState: s.el.readyState, currentTime: s.el.currentTime, error: s.el.error?.code ?? null, seeking: s.seeking, src: s.el.currentSrc.slice(0, 80) }));
    }
    return () => registerSequencePlayer(null);
  }, [outputDuration, registerSequencePlayer, setCurrentTime, setPlaying]);
  void playing;

  const w = recipe.canvasW;
  const h = recipe.canvasH;
  return (
    <div ref={hostRef} className={cn("relative flex items-center justify-center overflow-hidden bg-black", fill ? "h-full w-full" : "aspect-video w-full")} data-testid="sequence-preview">
      <canvas ref={canvasRef} width={w} height={h} className="max-h-full max-w-full" style={{ aspectRatio: `${w} / ${h}` }} aria-label="Sequence preview" />
      {loadError && <div className="absolute inset-x-0 bottom-3 mx-auto w-max rounded-md bg-rose-500/80 px-3 py-1 text-[12px] text-white">{loadError}</div>}
      <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/50 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/80">Sequence</div>
    </div>
  );
}
