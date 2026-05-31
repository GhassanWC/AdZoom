"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { createProjectFromFile } from "@/lib/firebase/projects";
import {
  createRecordingEngine,
  mimeToExtension,
  RecordingError,
  type RecordingEngine,
  type RecordingOptions,
  type RecordingResult,
  type RecordingState,
} from "@/lib/recording";
import { useNotifications } from "@/lib/notifications/store";

/**
 * Provider that owns the recording engine for the entire dashboard session.
 *
 * The engine MUST outlive any single page — if it lived inside the recording
 * page, navigating to "/dashboard/projects" mid-take would unmount the page,
 * teardown the engine, and silently kill the recording. By mounting it at
 * the Shell level we keep the recording alive across routes and let the HUD
 * + preview surface from anywhere in the app.
 */

const DEFAULT_OPTIONS: RecordingOptions = {
  screen: true,
  mic: true,
  webcam: false,
  systemAudio: false,
};

interface RecordingContextValue {
  state: RecordingState;
  options: RecordingOptions;
  setOptions: (opts: RecordingOptions) => void;
  elapsedSeconds: number;
  micLevel: number;
  paused: boolean;
  starting: boolean;
  webcamStream: MediaStream | null;
  result: RecordingResult | null;
  error: string | null;
  uploading: boolean;
  uploadPct: number | null;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  cancel: () => void;
  discardResult: () => void;
  useResult: () => Promise<void>;
  /**
   * Replace the current result blob (e.g. after the user accepts a crop fix
   * in the preview). The original interactions / scope / mimeType stay; we
   * only swap the blob + width/height so the upload uses the corrected file.
   */
  replaceResultBlob: (next: Blob, info: { width: number; height: number }) => void;
}

const Ctx = React.createContext<RecordingContextValue | null>(null);

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user } = useAuth();
  const notifications = useNotifications();

  const engineRef = React.useRef<RecordingEngine | null>(null);
  if (!engineRef.current && typeof window !== "undefined") {
    engineRef.current = createRecordingEngine();
  }

  const [state, setState] = React.useState<RecordingState>("idle");
  const [options, setOptions] = React.useState<RecordingOptions>(DEFAULT_OPTIONS);
  const [elapsedSeconds, setElapsed] = React.useState(0);
  const [micLevel, setMicLevel] = React.useState(0);
  const [starting, setStarting] = React.useState(false);
  const [webcamStream, setWebcamStream] = React.useState<MediaStream | null>(null);
  const [result, setResult] = React.useState<RecordingResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadPct, setUploadPct] = React.useState<number | null>(null);

  // Bridge engine events into React state.
  React.useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    return engine.on((e) => {
      if (e.type === "tick") {
        setElapsed(e.tick.elapsedSeconds);
        setMicLevel(e.tick.micLevel);
      } else if (e.type === "state") {
        setState(e.state);
        if (e.state !== "recording" && e.state !== "paused") {
          // The webcam stream is owned by the engine; clear our ref once the
          // engine has torn down so we don't try to render a dead stream.
          if (e.state === "idle" || e.state === "stopped" || e.state === "error") {
            setWebcamStream(null);
          }
        }
      } else if (e.type === "result") {
        setResult(e.result);
      } else if (e.type === "error") {
        setError(e.error.message);
      }
    });
  }, []);

  // Last-resort cleanup if the entire dashboard unmounts (signout, etc).
  React.useEffect(() => {
    return () => {
      engineRef.current?.cancel();
    };
  }, []);

  // Warn before unloading mid-take.
  React.useEffect(() => {
    if (state !== "recording" && state !== "paused") return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [state]);

  const start: RecordingContextValue["start"] = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    setError(null);
    setResult(null);
    setStarting(true);
    try {
      await engine.prepare(options);
      // Show webcam preview as soon as it's available, even before the
      // recorder fires its first tick.
      setWebcamStream(engine.getWebcamStream());
      await engine.start();
    } catch (err) {
      if (err instanceof RecordingError && err.kind === "user_cancelled") {
        // benign dismiss — keep the setup screen clean
      } else {
        const msg =
          err instanceof RecordingError ? err.message : "Couldn't start recording.";
        setError(msg);
      }
    } finally {
      setStarting(false);
    }
  };

  const pause = () => engineRef.current?.pause();
  const resume = () => engineRef.current?.resume();

  const stop: RecordingContextValue["stop"] = () => {
    // Fire-and-forget — the `result` event is the canonical channel.
    engineRef.current?.stop().catch((err) => {
      setError(err instanceof Error ? err.message : "Couldn't stop recording.");
    });
  };

  const cancel: RecordingContextValue["cancel"] = () => {
    engineRef.current?.cancel();
    setResult(null);
    setError(null);
    setUploadPct(null);
    setUploading(false);
  };

  const discardResult: RecordingContextValue["discardResult"] = () => {
    setResult(null);
    setError(null);
    setUploadPct(null);
  };

  const replaceResultBlob: RecordingContextValue["replaceResultBlob"] = (
    next,
    info
  ) => {
    setResult((prev) =>
      prev
        ? {
            ...prev,
            blob: next,
            mimeType: next.type || prev.mimeType,
            width: info.width,
            height: info.height,
          }
        : prev
    );
  };

  const useResult: RecordingContextValue["useResult"] = async () => {
    if (!result || !user) return;
    setUploading(true);
    setUploadPct(0);
    setError(null);
    try {
      const ext = mimeToExtension(result.mimeType);
      const filename = `screen-recording-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.${ext}`;
      const file = new File([result.blob], filename, { type: result.mimeType });
      const { projectId } = await createProjectFromFile({
        uid: user.uid,
        file,
        duration: result.durationSeconds,
        width: result.width,
        height: result.height,
        title: "Untitled recording",
        onProgress: (pct) => setUploadPct(pct),
        interactions: result.interactions,
        interactionScope: result.interactionScope,
      });
      // Persistent notification — the navbar bell carries the take
      // forward even if the user navigates away mid-upload. The id is
      // keyed on the freshly minted projectId so retries can't dupe.
      notifications.push({
        id: `upload-completed:${projectId}`,
        kind: "upload-completed",
        title: "Recording uploaded",
        body: `${filename} ready for analysis`,
        href: `/dashboard/projects/${projectId}`,
      });
      setResult(null);
      setUploading(false);
      setUploadPct(null);
      router.push(`/dashboard/projects/${projectId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed.";
      setError(msg);
      setUploadPct(null);
      setUploading(false);
    }
  };

  const value: RecordingContextValue = {
    state,
    options,
    setOptions,
    elapsedSeconds,
    micLevel,
    paused: state === "paused",
    starting,
    webcamStream,
    result,
    error,
    uploading,
    uploadPct,
    start,
    pause,
    resume,
    stop,
    cancel,
    discardResult,
    useResult,
    replaceResultBlob,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRecording(): RecordingContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    throw new Error("useRecording must be called inside <RecordingProvider>");
  }
  return ctx;
}

/** True when the engine is actively capturing (recording or paused). */
export function useIsRecording(): boolean {
  const { state } = useRecording();
  return state === "recording" || state === "paused";
}
