"use client";

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Unsubscribe,
} from "firebase/firestore";
import {
  deleteObject,
  getDownloadURL,
  ref as storageRef,
  uploadBytesResumable,
  type UploadTaskSnapshot,
} from "firebase/storage";
import { getFirebase } from "./client";
import {
  DEFAULT_EFFECTS_SETTINGS,
  type ProjectDoc,
  type ProjectStatus,
} from "./schema";

const ACCEPTED_MIME = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];

export function isVideoAccepted(file: File): boolean {
  if (ACCEPTED_MIME.includes(file.type)) return true;
  // Fallback: check extension since some browsers don't set mime for .mov
  return /\.(mp4|mov|webm|mkv)$/i.test(file.name);
}

export function projectPath(uid: string, projectId: string) {
  return `users/${uid}/projects/${projectId}`;
}

export interface UploadResult {
  projectId: string;
  storagePath: string;
  downloadURL: string;
}

interface CreateProjectInput {
  uid: string;
  file: File;
  title?: string;
  duration?: number;
  width?: number;
  height?: number;
  onProgress?: (pct: number, snap: UploadTaskSnapshot) => void;
}

export async function createProjectFromFile({
  uid,
  file,
  title,
  duration,
  width,
  height,
  onProgress,
}: CreateProjectInput): Promise<UploadResult> {
  if (!isVideoAccepted(file)) {
    throw new Error(`Unsupported file type: ${file.type || file.name}`);
  }
  const { db, storage } = getFirebase();

  // 1. Pre-create the Firestore doc to get an ID.
  const projectsCol = collection(db, "users", uid, "projects");
  const created = await addDoc(projectsCol, {
    userId: uid,
    title: title ?? deriveTitle(file.name),
    status: "uploading" as ProjectStatus,
    storagePath: "",
    originalVideoUrl: "",
    duration: duration ?? null,
    width: width ?? null,
    height: height ?? null,
    fileSize: file.size,
    mimeType: file.type || "video/mp4",
    effectsSettings: DEFAULT_EFFECTS_SETTINGS,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const projectId = created.id;

  // 2. Upload to Storage at the canonical path.
  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `users/${uid}/projects/${projectId}/original/${safeName}`;
  const sRef = storageRef(storage, path);

  const task = uploadBytesResumable(sRef, file, {
    contentType: file.type || "video/mp4",
  });

  await new Promise<void>((resolve, reject) => {
    task.on(
      "state_changed",
      (snap) => {
        const pct = (snap.bytesTransferred / snap.totalBytes) * 100;
        onProgress?.(pct, snap);
      },
      (err) => reject(err),
      () => resolve()
    );
  });

  // 3. Get the download URL and finalize the Firestore doc.
  const downloadURL = await getDownloadURL(sRef);
  await updateDoc(doc(db, "users", uid, "projects", projectId), {
    status: "uploaded" as ProjectStatus,
    storagePath: path,
    originalVideoUrl: downloadURL,
    updatedAt: serverTimestamp(),
  });

  return { projectId, storagePath: path, downloadURL };
}

function deriveTitle(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  const cleaned = base.replace(/[_\-]+/g, " ").trim();
  return cleaned || "Untitled recording";
}

export function subscribeProject(
  uid: string,
  projectId: string,
  onChange: (p: ProjectDoc | null) => void
): Unsubscribe {
  const { db } = getFirebase();
  const ref = doc(db, "users", uid, "projects", projectId);
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      onChange(null);
      return;
    }
    onChange(materializeProject(snap.id, snap.data()));
  });
}

export function subscribeProjects(
  uid: string,
  onChange: (p: ProjectDoc[]) => void
): Unsubscribe {
  const { db } = getFirebase();
  const q = query(collection(db, "users", uid, "projects"), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => materializeProject(d.id, d.data())));
  });
}

export async function getProject(uid: string, projectId: string): Promise<ProjectDoc | null> {
  const { db } = getFirebase();
  const snap = await getDoc(doc(db, "users", uid, "projects", projectId));
  if (!snap.exists()) return null;
  return materializeProject(snap.id, snap.data());
}

export async function updateProject(
  uid: string,
  projectId: string,
  patch: Partial<ProjectDoc>
) {
  const { db } = getFirebase();
  await updateDoc(doc(db, "users", uid, "projects", projectId), {
    ...patch,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteProject(uid: string, projectId: string, storagePath?: string) {
  const { db, storage } = getFirebase();
  if (storagePath) {
    try {
      await deleteObject(storageRef(storage, storagePath));
    } catch (err) {
      // Storage object may already be gone — non-fatal.
      console.warn("[deleteProject] storage cleanup", err);
    }
  }
  await deleteDoc(doc(db, "users", uid, "projects", projectId));
}

export async function setAnalysisStage(
  uid: string,
  projectId: string,
  stage: string,
  status: ProjectStatus = "analyzing"
) {
  const { db } = getFirebase();
  await setDoc(
    doc(db, "users", uid, "projects", projectId),
    {
      status,
      analysis: { status: "analyzing", stage },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

function materializeProject(id: string, data: Record<string, unknown>): ProjectDoc {
  return {
    id,
    userId: data.userId as string,
    title: (data.title as string) ?? "Untitled",
    originalVideoUrl: (data.originalVideoUrl as string) ?? "",
    storagePath: (data.storagePath as string) ?? "",
    duration: tsNum(data.duration),
    width: tsNum(data.width),
    height: tsNum(data.height),
    fileSize: tsNum(data.fileSize),
    mimeType: (data.mimeType as string) ?? undefined,
    status: ((data.status as ProjectStatus) ?? "uploaded") as ProjectStatus,
    analysis: (data.analysis as ProjectDoc["analysis"]) ?? undefined,
    effectsSettings:
      (data.effectsSettings as ProjectDoc["effectsSettings"]) ?? DEFAULT_EFFECTS_SETTINGS,
    exportUrl: (data.exportUrl as string) ?? undefined,
    createdAt: tsMs(data.createdAt) ?? Date.now(),
    updatedAt: tsMs(data.updatedAt) ?? Date.now(),
  };
}

function tsNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function tsMs(v: unknown): number | undefined {
  if (v && typeof v === "object" && "toMillis" in v) {
    return (v as { toMillis(): number }).toMillis();
  }
  if (typeof v === "number") return v;
  return undefined;
}
