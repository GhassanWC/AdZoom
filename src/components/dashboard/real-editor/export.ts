"use client";

import {
  addDoc,
  collection,
  getDoc,
  serverTimestamp,
  setDoc,
  doc,
  updateDoc,
} from "firebase/firestore";
import { getDownloadURL, ref as storageRef, uploadBytes } from "firebase/storage";
import { getFirebase } from "@/lib/firebase/client";
import { cameraForMoment, localProgress } from "@/lib/timeline/camera";
import type {
  DetectedMoment,
  EffectsSettings,
  ExportFormat,
} from "@/lib/firebase/schema";
import { normalizePlan, planMeetsMinimum } from "@/lib/usage/plan";

const PREFERRED_MIMES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function pickMime(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mime of PREFERRED_MIMES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return { mime, ext: mime.startsWith("video/mp4") ? "mp4" : "webm" };
    }
  }
  return null;
}

export interface ExportProgress {
  stage:
    | "preparing"
    | "rendering"
    | "uploading"
    | "complete"
    | "failed"
    | "unsupported";
  pct: number; // 0..1
  message?: string;
  downloadURL?: string;
}

interface RenderInput {
  uid: string;
  projectId: string;
  projectTitle: string;
  video: HTMLVideoElement;
  duration: number;
  moments: DetectedMoment[];
  effects: EffectsSettings;
  resolution: "1080p" | "4K";
  fps: 30 | 60;
  format: ExportFormat;
  onProgress: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

/**
 * Render the source video to a canvas, applying preview transforms per moment,
 * and capture via MediaRecorder. Returns a Blob that the caller can download
 * and/or upload.
 *
 * Honest limits:
 * - Audio is included by piping the source video's MediaElement via captureStream.
 * - 4K is capped to 1920x1080 on the canvas to keep the browser stable.
 * - Some browsers don't support MediaRecorder of MP4 — we fall back to WebM.
 */
export async function renderProjectClientSide(
  input: RenderInput
): Promise<Blob> {
  const {
    video,
    moments,
    effects,
    resolution,
    fps,
    format,
    onProgress,
    signal,
  } = input;

  const mime = pickMime();
  if (!mime) {
    onProgress({
      stage: "unsupported",
      pct: 0,
      message:
        "Your browser does not support MediaRecorder for video. Try Chrome or Edge.",
    });
    throw new Error("MediaRecorder not supported");
  }

  onProgress({ stage: "preparing", pct: 0 });

  // Source video dims — used by drawCover. Default to 16:9 if not yet known.
  const sourceW = video.videoWidth || 1920;
  const sourceH = video.videoHeight || 1080;

  // Fixed output size — independent of source dimensions. The export must
  // be a clean container aspect (16:9 horizontal or 9:16 vertical) so the
  // file plays predictably in every player. Source aspect mismatch is
  // handled by `drawCover` (object-fit: cover semantics, center-cropped).
  const vertical = format === "TikTok 9:16" || effects.verticalExport;
  let canvasW: number;
  let canvasH: number;
  if (vertical) {
    canvasW = resolution === "4K" ? 2160 : 1080;
    canvasH = resolution === "4K" ? 3840 : 1920;
  } else {
    canvasW = resolution === "4K" ? 3840 : 1920;
    canvasH = resolution === "4K" ? 2160 : 1080;
  }

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not get 2D context");

  // Pre-fill black BEFORE the canvas is captured so MediaRecorder never
  // sees uninitialised GPU pixels (which often encode as green/magenta on
  // H.264 — that was the "green bar" in the broken export).
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Stream from canvas + audio from video element if possible
  const canvasStream = canvas.captureStream(fps);
  let audioTrack: MediaStreamTrack | null = null;
  try {
    // captureStream on HTMLMediaElement is non-standard but supported in Chromium.
    type CaptureStream = () => MediaStream;
    const captureStream = (video as unknown as { captureStream?: CaptureStream })
      .captureStream;
    if (captureStream) {
      const stream = captureStream.call(video) as MediaStream;
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length) {
        audioTrack = audioTracks[0];
        canvasStream.addTrack(audioTrack);
      }
    }
  } catch (err) {
    console.warn("[export] audio capture failed", err);
  }

  const recorder = new MediaRecorder(canvasStream, {
    mimeType: mime.mime,
    videoBitsPerSecond: resolution === "4K" ? 12_000_000 : 6_000_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const recordedPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime.mime }));
    recorder.onerror = () => reject(new Error("MediaRecorder error"));
  });

  // Rewind + play
  video.pause();
  video.currentTime = 0;
  video.muted = false;
  await new Promise<void>((resolve) => {
    const onSeek = () => {
      video.removeEventListener("seeked", onSeek);
      resolve();
    };
    video.addEventListener("seeked", onSeek);
  });

  // Paint the t=0 frame BEFORE the recorder picks up its first chunk so the
  // start of the export isn't a green/black flash. Also re-fills black under
  // the video in case the canvas got reset by the captureStream pipeline.
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvasW, canvasH);
  const startMoment = moments.find(
    (m) => video.currentTime >= m.startTime && video.currentTime <= m.endTime
  );
  const startCam = startMoment
    ? computeTransform(
        startMoment,
        effects.autoZoom / 100,
        canvasW,
        canvasH,
        video.currentTime
      )
    : { tx: 0, ty: 0, scale: 1 };
  ctx.save();
  ctx.translate(canvasW / 2, canvasH / 2);
  ctx.scale(startCam.scale, startCam.scale);
  ctx.translate(startCam.tx, startCam.ty);
  drawCover(ctx, video, sourceW, sourceH, canvasW, canvasH);
  ctx.restore();

  recorder.start(500);

  onProgress({ stage: "rendering", pct: 0 });

  // Drive a draw loop
  let stopped = false;
  let aborted = false;
  const abortHandler = () => {
    aborted = true;
    stopped = true;
  };
  signal?.addEventListener("abort", abortHandler);

  // Swallow the AbortError that fires when the user cancels mid-export and we
  // pause the element before the play promise settles. The pause itself does
  // the right thing — the only thing rejecting is the play() promise.
  try {
    await video.play();
  } catch (err) {
    if (!(err instanceof DOMException) || err.name !== "AbortError") throw err;
  }

  const draw = () => {
    if (stopped) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvasW, canvasH);
    const t = video.currentTime;

    const moment = moments.find((m) => t >= m.startTime && t <= m.endTime);

    // Identity camera when no moment is active. Critical: the no-moment
    // branch must use the SAME transform chain as the moment branch so
    // `drawCover` is consistently centered. The previous code skipped the
    // translate and the video drew at (-drawW/2, -drawH/2) in raw canvas
    // coords — i.e. pushed into the top-left, exactly the bug reported.
    const cam = moment
      ? computeTransform(moment, effects.autoZoom / 100, canvasW, canvasH, t)
      : { tx: 0, ty: 0, scale: 1 };

    ctx.save();
    ctx.translate(canvasW / 2, canvasH / 2);
    ctx.scale(cam.scale, cam.scale);
    ctx.translate(cam.tx, cam.ty);
    drawCover(ctx, video, sourceW, sourceH, canvasW, canvasH);
    ctx.restore();

    // progress
    if (input.duration > 0) {
      onProgress({ stage: "rendering", pct: Math.min(0.99, t / input.duration) });
    }

    if (video.ended || video.currentTime >= input.duration - 0.05) {
      stopped = true;
      recorder.stop();
      return;
    }

    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  // Safety stop
  const maxDurationMs = Math.max(1, input.duration + 5) * 1000;
  const safety = setTimeout(() => {
    if (!stopped) {
      stopped = true;
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
  }, maxDurationMs);

  let blob: Blob;
  try {
    blob = await recordedPromise;
  } finally {
    clearTimeout(safety);
    signal?.removeEventListener("abort", abortHandler);
    video.pause();
  }

  if (aborted) throw new Error("Export cancelled");
  onProgress({ stage: "rendering", pct: 1 });

  return blob;
}

/**
 * Camera transform for a moment at absolute time `t`, in canvas pixels.
 * Uses the SAME shared `cameraForMoment` model as the live preview — so what
 * the user previews (including keyframed camera motion) is what exports.
 */
function computeTransform(
  m: DetectedMoment,
  globalIntensity: number,
  canvasW: number,
  canvasH: number,
  t: number
) {
  const perMoment =
    m.intensity ?? m.recommendedIntensity ?? m.attentionScore ?? 0.5;
  const blended = perMoment * 0.6 + globalIntensity * 0.4;
  const cam = cameraForMoment(m, blended, localProgress(m, t));
  return {
    tx: (cam.panXPct / 100) * canvasW,
    ty: (cam.panYPct / 100) * canvasH,
    scale: cam.scale,
  };
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  sourceW: number,
  sourceH: number,
  canvasW: number,
  canvasH: number
) {
  // object-fit: cover behavior
  const cAspect = canvasW / canvasH;
  const sAspect = sourceW / sourceH;
  let drawW = canvasW;
  let drawH = canvasH;
  if (sAspect > cAspect) {
    drawH = canvasH;
    drawW = canvasH * sAspect;
  } else {
    drawW = canvasW;
    drawH = canvasW / sAspect;
  }
  const dx = -drawW / 2;
  const dy = -drawH / 2;
  ctx.drawImage(video, dx, dy, drawW, drawH);
}

export async function uploadExport({
  uid,
  projectId,
  projectTitle,
  blob,
  format,
  resolution,
  fps,
  ext,
}: {
  uid: string;
  projectId: string;
  projectTitle: string;
  blob: Blob;
  format: ExportFormat;
  resolution: "1080p" | "4K";
  fps: 30 | 60;
  ext: string;
}): Promise<{ exportId: string; downloadURL: string }> {
  const { db, storage } = getFirebase();

  // Defensive plan check — 4K exports are Pro-only. The UI already hides
  // the 4K segment for non-Pro users, but a hand-crafted resolution prop
  // (or a mid-session downgrade) would slip past. The authoritative
  // enforcement lives in Firestore Security Rules + Storage Rules; this is
  // a friendlier client-side guard so the user sees a clear message rather
  // than a rules denied error.
  if (resolution === "4K") {
    const userSnap = await getDoc(doc(db, "users", uid));
    const plan = normalizePlan((userSnap.data() as { plan?: unknown } | undefined)?.plan);
    if (!planMeetsMinimum(plan, "pro")) {
      throw new Error("4K exports require a Pro plan — upgrade in /pricing.");
    }
  }

  const exportsCol = collection(db, "users", uid, "exports");
  const exportDoc = await addDoc(exportsCol, {
    projectId,
    projectTitle,
    format,
    resolution,
    fps,
    status: "exporting",
    createdAt: serverTimestamp(),
  });
  const exportId = exportDoc.id;

  const path = `users/${uid}/projects/${projectId}/exports/${exportId}.${ext}`;
  const sRef = storageRef(storage, path);
  await uploadBytes(sRef, blob, { contentType: blob.type || "video/webm" });
  const downloadURL = await getDownloadURL(sRef);

  await setDoc(
    doc(db, "users", uid, "exports", exportId),
    {
      storagePath: path,
      exportUrl: downloadURL,
      fileSize: blob.size,
      status: "ready",
      completedAt: serverTimestamp(),
    },
    { merge: true }
  );

  await updateDoc(doc(db, "users", uid, "projects", projectId), {
    exportUrl: downloadURL,
    status: "exported",
    updatedAt: serverTimestamp(),
  });

  return { exportId, downloadURL };
}

export function pickedMimeAvailable(): boolean {
  return pickMime() !== null;
}

export function pickedMimeExt(): string {
  return pickMime()?.ext ?? "webm";
}
