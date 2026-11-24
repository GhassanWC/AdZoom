"use client";

/**
 * Project ASSETS — additional media (a second angle, music, narration) a
 * sequence can use. Uploaded next to the original at
 * `users/{uid}/projects/{pid}/assets/<file>`; the ProjectAsset record carries
 * the playable URL and the probed duration/dimensions the evaluator needs.
 */
import { getDownloadURL, ref as storageRef, uploadBytesResumable } from "firebase/storage";
import { getFirebase } from "./client";
import { safeVideoContentType } from "./projects";
import type { ProjectAsset } from "@/lib/timeline/sequence";

/** Duration / dimensions / audio presence via a throwaway media element. */
export async function probeMediaFile(file: File): Promise<{ duration: number; width?: number; height?: number; hasAudio: boolean; kind: ProjectAsset["kind"] }> {
  const isAudio = file.type.startsWith("audio/");
  const el = document.createElement(isAudio ? "audio" : "video") as HTMLVideoElement;
  const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      el.preload = "metadata";
      el.onloadedmetadata = () => resolve();
      el.onerror = () => reject(new Error("This file can't be played in the browser."));
      el.src = url;
    });
    const hasAudio =
      isAudio ||
      Boolean((el as HTMLVideoElement & { mozHasAudio?: boolean; webkitAudioDecodedByteCount?: number; audioTracks?: { length: number } }).mozHasAudio) ||
      ((el as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount ?? 0) > 0 ||
      ((el as HTMLVideoElement & { audioTracks?: { length: number } }).audioTracks?.length ?? 1) > 0;
    return { duration: Number.isFinite(el.duration) ? el.duration : 0, width: isAudio ? undefined : el.videoWidth || undefined, height: isAudio ? undefined : el.videoHeight || undefined, hasAudio, kind: isAudio ? "audio" : "video" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function uploadProjectAsset(uid: string, projectId: string, file: File, onProgress?: (pct: number) => void): Promise<ProjectAsset> {
  const { storage } = getFirebase();
  const meta = await probeMediaFile(file);
  if (!(meta.duration > 0)) throw new Error("Couldn't read the media's duration.");
  const id = `a_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `users/${uid}/projects/${projectId}/assets/${id}-${safeName}`;
  const sRef = storageRef(storage, path);
  const task = uploadBytesResumable(sRef, file, { contentType: meta.kind === "audio" ? file.type || "audio/mpeg" : safeVideoContentType(file.type) });
  await new Promise<void>((resolve, reject) => {
    task.on("state_changed", (snap) => onProgress?.((snap.bytesTransferred / snap.totalBytes) * 100), reject, () => resolve());
  });
  const url = await getDownloadURL(sRef);
  return {
    id,
    kind: meta.kind,
    title: file.name.replace(/\.[^.]+$/, ""),
    url,
    storagePath: path,
    mimeType: file.type || undefined,
    duration: Math.round(meta.duration * 1000) / 1000,
    ...(meta.width ? { width: meta.width, height: meta.height } : {}),
    hasAudio: meta.hasAudio,
  };
}
