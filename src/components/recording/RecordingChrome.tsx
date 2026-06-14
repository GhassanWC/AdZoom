"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X as XIcon } from "lucide-react";
import { RecordingHUD } from "./RecordingHUD";
import { RecordingPreview } from "./RecordingPreview";
import { useRecording } from "./RecordingProvider";

/**
 * Global recording chrome — the HUD pill and the post-stop preview modal,
 * both portal-rendered so they survive any route change. Mounted at Shell
 * level so the user can navigate freely while a take is in flight.
 */
export function RecordingChrome() {
  const {
    state,
    elapsedSeconds,
    micLevel,
    paused,
    webcamStream,
    result,
    pause,
    resume,
    stop,
    cancel,
    discardResult,
    useResult,
    setSourceCrop,
    uploading,
    uploadPct,
    error,
  } = useRecording();

  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const recording = state === "recording" || state === "paused";

  return (
    <>
      {recording && (
        <RecordingHUD
          elapsedSeconds={elapsedSeconds}
          micLevel={micLevel}
          paused={paused}
          webcamStream={webcamStream}
          onPause={pause}
          onResume={resume}
          onStop={stop}
          onCancel={cancel}
        />
      )}

      {createPortal(
        <AnimatePresence>
          {result && (
            <motion.div
              key="recording-preview-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[130] flex items-center justify-center bg-ink/85 px-4 py-6 backdrop-blur-xl"
            >
              <motion.div
                initial={{ opacity: 0, y: 16, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.97 }}
                transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
                className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-ink/95 shadow-cinematic"
              >
                {!uploading && (
                  <button
                    type="button"
                    onClick={discardResult}
                    aria-label="Discard take"
                    title="Discard take (Esc)"
                    className="absolute right-4 top-4 z-10 inline-flex size-9 items-center justify-center rounded-full border border-white/15 bg-ink/90 text-fog backdrop-blur-md transition-colors duration-150 hover:border-white/30 hover:text-white"
                  >
                    <XIcon size={14} />
                  </button>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <RecordingPreview
                    blob={result.blob}
                    durationSeconds={result.durationSeconds}
                    width={result.width}
                    height={result.height}
                    displaySurface={result.displaySurface}
                    sourceCrop={result.sourceCrop}
                    onSetSourceCrop={setSourceCrop}
                    onDiscard={discardResult}
                    onUse={useResult}
                    uploading={uploading}
                    uploadPct={uploadPct}
                    error={error}
                  />
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
