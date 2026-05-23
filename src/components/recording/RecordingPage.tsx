"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { useRecording } from "./RecordingProvider";
import { RecordingSetup } from "./RecordingSetup";

/**
 * `/dashboard/record` route. The recording engine lives in the Shell-level
 * `RecordingProvider` (so it survives navigation away from this page mid-
 * take), and the HUD + preview render globally via `RecordingChrome`.
 *
 * This page is now just two states: the cinematic setup screen, and a calm
 * "recording in progress" hint when a take is already running. Stop / pause
 * happen from the HUD; preview opens as a global modal from anywhere.
 */
export function RecordingPage() {
  const {
    state,
    options,
    setOptions,
    start,
    starting,
    webcamStream,
    micLevel,
    elapsedSeconds,
    paused,
    error,
  } = useRecording();

  const live = state === "recording" || state === "paused";

  if (live) {
    return (
      <RecordingLive
        elapsed={elapsedSeconds}
        paused={paused}
        micLevel={micLevel}
      />
    );
  }

  return (
    <RecordingSetup
      options={options}
      onOptionsChange={setOptions}
      onStart={start}
      starting={starting}
      webcamPreview={webcamStream}
      micLevel={micLevel}
      error={error}
    />
  );
}

function RecordingLive({
  elapsed,
  paused,
  micLevel,
}: {
  elapsed: number;
  paused: boolean;
  micLevel: number;
}) {
  // micLevel is read so the page can flex slightly when audio is hot — keeps
  // the screen from looking frozen during long takes.
  const pulse = Math.min(1, micLevel * 1.5);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="relative flex min-h-[72vh] flex-col items-center justify-center px-4 text-center"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[640px] w-[640px] -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgba(244,63,94,0.10),transparent_65%)] blur-3xl transition-opacity duration-300"
        style={{ opacity: 0.6 + pulse * 0.4 }}
      />
      <div className="inline-flex items-center gap-2 rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-200">
        <span className="relative inline-flex size-2 items-center justify-center">
          {!paused && (
            <span className="absolute inset-0 -m-1 rounded-full bg-rose-400/40 animate-ping" />
          )}
          <span className="relative size-2 rounded-full bg-rose-400" />
        </span>
        {paused ? "Paused" : "Recording in progress"}
      </div>
      <h2 className="mt-5 font-display text-3xl font-semibold tracking-tight text-white">
        Switch to the window you&apos;re recording.
      </h2>
      <p className="mt-2 max-w-md text-sm text-fog">
        The HUD stays pinned at the bottom of every page — you can navigate
        around AdZoom and the take will keep rolling until you stop it.
      </p>
      <p className="mt-6 font-mono text-4xl font-semibold tabular-nums text-white">
        {fmt(elapsed)}
      </p>
    </motion.div>
  );
}

function fmt(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
