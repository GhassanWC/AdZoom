"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Mic, MicOff, Monitor, Video, VideoOff, Volume2, VolumeX, Sparkles, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { WebcamPreview } from "./WebcamPreview";
import type { RecordingOptions } from "@/lib/recording";

/**
 * Pre-recording setup — the "feel premium and intentional" surface. A single
 * massive CTA, three opinionated toggles, a live device preview. Nothing else.
 *
 * The page owns the actual `prepare()` + `start()` calls; this component is
 * pure UI bound to options and a `onStart` handler.
 */
export function RecordingSetup({
  options,
  onOptionsChange,
  onStart,
  starting,
  webcamPreview,
  micLevel,
  error,
}: {
  options: RecordingOptions;
  onOptionsChange: (next: RecordingOptions) => void;
  onStart: () => void;
  starting: boolean;
  webcamPreview: MediaStream | null;
  micLevel: number;
  error: string | null;
}) {
  const micPermission = usePermissionState("microphone");
  const camPermission = usePermissionState("camera");

  return (
    <div className="relative mx-auto flex min-h-[72vh] max-w-4xl flex-col items-center justify-center gap-10 px-4 py-12 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[720px] w-[720px] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.16),transparent_60%)] blur-3xl"
      />

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="space-y-4"
      >
        <div className="inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-200">
          <Sparkles size={11} />
          New recording
        </div>
        <h1 className="font-display text-5xl font-semibold tracking-tight text-white sm:text-6xl">
          Record once.
          <br />
          <span className="bg-gradient-to-r from-violet-300 via-violet-200 to-cyan-300 bg-clip-text text-transparent">
            AI edits the rest.
          </span>
        </h1>
        <p className="mx-auto max-w-xl text-base leading-relaxed text-fog">
          Capture your screen and we&apos;ll draft the cinematic cut — zooms,
          focus, cursor smoothing, subtitles. You stay in control of every beat.
        </p>
      </motion.div>

      {/* Big CTA */}
      <motion.button
        type="button"
        onClick={onStart}
        disabled={starting}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
        whileHover={{ scale: starting ? 1 : 1.02 }}
        whileTap={{ scale: starting ? 1 : 0.98 }}
        className="group relative inline-flex h-16 items-center gap-3 rounded-full bg-gradient-to-r from-violet-500 to-violet-600 px-9 text-base font-semibold text-white shadow-[0_24px_60px_-20px_rgba(139,92,246,0.65)] transition-shadow duration-300 hover:shadow-[0_30px_70px_-20px_rgba(139,92,246,0.8)] disabled:opacity-70"
      >
        <span
          aria-hidden
          className="absolute -inset-px rounded-full bg-gradient-to-r from-violet-400/0 via-violet-300/30 to-cyan-300/0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        />
        {starting ? (
          <Loader2 size={20} className="animate-spin" />
        ) : (
          <span className="relative inline-flex size-5 items-center justify-center">
            <span className="absolute inset-0 rounded-full bg-rose-400 animate-pulse" />
            <span className="relative size-2.5 rounded-full bg-white" />
          </span>
        )}
        {starting ? "Preparing…" : "Start recording"}
      </motion.button>

      <p className="text-[12px] text-fog/80">
        You&apos;ll choose what to share — full screen, window, or browser tab.
      </p>

      {/* Toggle row */}
      <div className="grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
        <Toggle
          label="Microphone"
          subtitle="Narrate while you record"
          active={options.mic}
          onToggle={() => onOptionsChange({ ...options, mic: !options.mic })}
          ActiveIcon={Mic}
          IdleIcon={MicOff}
          accent="violet"
          status={options.mic ? <PermissionPill state={micPermission} /> : null}
          extra={
            options.mic && webcamPreview === null ? (
              <MicMeter level={micLevel} />
            ) : null
          }
        />
        <Toggle
          label="Webcam"
          subtitle="Add yourself as a floating bubble"
          active={options.webcam}
          onToggle={() =>
            onOptionsChange({ ...options, webcam: !options.webcam })
          }
          ActiveIcon={Video}
          IdleIcon={VideoOff}
          accent="cyan"
          status={options.webcam ? <PermissionPill state={camPermission} /> : null}
          extra={
            options.webcam ? (
              <div className="flex items-center justify-center pt-1">
                <WebcamPreview stream={webcamPreview} size={84} />
              </div>
            ) : null
          }
        />
        <Toggle
          label="System audio"
          subtitle="Pick a browser tab to capture sound"
          active={options.systemAudio}
          onToggle={() =>
            onOptionsChange({ ...options, systemAudio: !options.systemAudio })
          }
          ActiveIcon={Volume2}
          IdleIcon={VolumeX}
          accent="amber"
        />
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 text-[11.5px] text-fog/70">
        <span className="inline-flex items-center gap-1.5">
          <Monitor size={11} className="text-violet-300" />
          Screen, window, or Chrome tab
        </span>
        <span aria-hidden>·</span>
        <span>Local capture, your file stays in your workspace</span>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-400/30 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  subtitle,
  active,
  onToggle,
  ActiveIcon,
  IdleIcon,
  accent,
  status,
  extra,
}: {
  label: string;
  subtitle: string;
  active: boolean;
  onToggle: () => void;
  ActiveIcon: typeof Mic;
  IdleIcon: typeof Mic;
  accent: "violet" | "cyan" | "amber";
  status?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const accentRing =
    accent === "violet"
      ? "border-violet-400/40 bg-violet-500/[0.08] text-violet-100"
      : accent === "cyan"
        ? "border-cyan-300/40 bg-cyan-400/[0.08] text-cyan-100"
        : "border-amber-300/40 bg-amber-400/[0.08] text-amber-100";
  const Icon = active ? ActiveIcon : IdleIcon;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={cn(
        "group relative rounded-2xl border px-4 py-4 text-left transition-all duration-200",
        active
          ? accentRing
          : "border-white/10 bg-white/[0.02] text-fog hover:border-white/25 hover:bg-white/[0.04] hover:text-white"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">{label}</div>
          <div className="mt-0.5 text-[11.5px] text-fog">{subtitle}</div>
          {status && <div className="mt-1.5">{status}</div>}
        </div>
        <span
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-200",
            active
              ? "bg-white/10 text-white"
              : "bg-white/[0.04] text-fog group-hover:text-white"
          )}
        >
          <Icon size={15} />
        </span>
      </div>
      {extra && <div className="mt-3">{extra}</div>}
    </button>
  );
}

type PermissionState = "granted" | "denied" | "prompt" | "unsupported";

/**
 * Reads the current `navigator.permissions` state for a device and re-renders
 * when it changes (the Permissions API exposes an `onchange` event when the
 * user flips a site setting). Returns `"unsupported"` when the API isn't
 * available or doesn't recognise the descriptor — Safari < 16 throws.
 */
function usePermissionState(name: "microphone" | "camera"): PermissionState {
  const [state, setState] = React.useState<PermissionState>("unsupported");

  React.useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const handle = () => {
      if (status && !cancelled) setState(status.state as PermissionState);
    };
    navigator.permissions
      .query({ name: name as PermissionName })
      .then((s) => {
        if (cancelled) return;
        status = s;
        setState(s.state as PermissionState);
        s.addEventListener("change", handle);
      })
      .catch(() => {
        // Safari throws on unknown descriptors; leave as "unsupported".
      });
    return () => {
      cancelled = true;
      status?.removeEventListener("change", handle);
    };
  }, [name]);

  return state;
}

function PermissionPill({ state }: { state: PermissionState }) {
  if (state === "unsupported") return null;
  const cfg =
    state === "granted"
      ? { dot: "bg-emerald-400", text: "text-emerald-300", label: "Ready" }
      : state === "denied"
        ? { dot: "bg-rose-400", text: "text-rose-300", label: "Blocked" }
        : { dot: "bg-fog/70", text: "text-fog", label: "Will prompt" };
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[10px]", cfg.text)}>
      <span className={cn("size-1.5 rounded-full", cfg.dot)} />
      {cfg.label}
    </span>
  );
}

function MicMeter({ level }: { level: number }) {
  const bars = 18;
  const active = Math.round(level * bars);
  return (
    <div className="mt-1 flex h-4 items-center justify-center gap-[2px]">
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-full w-[3px] rounded-full transition-colors duration-100",
            i < active
              ? i > bars - 4
                ? "bg-rose-400/85"
                : "bg-violet-300/85"
              : "bg-white/10"
          )}
        />
      ))}
    </div>
  );
}
