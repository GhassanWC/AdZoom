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
  uploadBytes,
  uploadBytesResumable,
  type UploadTaskSnapshot,
} from "firebase/storage";
import type { Interaction, SourceCrop } from "@/lib/recording/types";
import { assessCoordinateTrust } from "@/lib/recording/interaction-trust";
import type { CaptureDimensions } from "@/lib/recording/scope-detect";
import { getFirebase } from "./client";
import {
  DEFAULT_EFFECTS_SETTINGS,
  type ProjectDoc,
  type ProjectStatus,
} from "./schema";
import { BUILTIN_PRESETS_BY_ID } from "@/lib/presets";
import { trackEvent } from "@/lib/analytics/trackEvent";
import { EVENTS } from "@/lib/analytics/events";

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
  /** Real interaction events captured during recording (in-tab only). */
  interactions?: Interaction[];
  /** "tab" means events are authoritative; "external" means rely on CV. */
  interactionScope?: "tab" | "external";
  /** Capture geometry, persisted so the analyzer can re-validate scope. */
  captureDimensions?: CaptureDimensions;
  /** Global source-frame crop, seeded when the green-band detector fires. */
  sourceCrop?: SourceCrop;
}

/**
 * Read the user's workspace defaults (preset id + export format) and
 * fold them into the standard `DEFAULT_EFFECTS_SETTINGS` so the new
 * project starts already configured the way the user wants. Failure
 * to read settings is non-fatal — the project simply gets the
 * built-in defaults.
 *
 * Applied to NEW projects only — existing projects are untouched, as
 * documented in the Settings UI.
 */
async function loadWorkspaceDefaults(
  uid: string
): Promise<{ effectsSettings: typeof DEFAULT_EFFECTS_SETTINGS; selectedPresetId?: string }> {
  try {
    const { db } = getFirebase();
    const snap = await getDoc(doc(db, "users", uid, "settings", "workspace"));
    if (!snap.exists()) return { effectsSettings: DEFAULT_EFFECTS_SETTINGS };
    const data = snap.data() as {
      defaultPresetId?: string;
      defaultExportFormat?: typeof DEFAULT_EFFECTS_SETTINGS.defaultExportFormat;
    };
    // Resolve the preset id to its EffectsSettings via the static
    // built-in table — saves a round trip and means custom presets
    // (not in the built-in table) safely fall through.
    const preset = data.defaultPresetId
      ? BUILTIN_PRESETS_BY_ID[data.defaultPresetId]
      : undefined;
    return {
      effectsSettings: {
        ...DEFAULT_EFFECTS_SETTINGS,
        ...(preset?.effects ?? {}),
        ...(data.defaultExportFormat
          ? { defaultExportFormat: data.defaultExportFormat }
          : {}),
      },
      selectedPresetId: data.defaultPresetId,
    };
  } catch {
    return { effectsSettings: DEFAULT_EFFECTS_SETTINGS };
  }
}

export async function createProjectFromFile({
  uid,
  file,
  title,
  duration,
  width,
  height,
  onProgress,
  interactions,
  interactionScope,
  captureDimensions,
  sourceCrop,
}: CreateProjectInput): Promise<UploadResult> {
  if (!isVideoAccepted(file)) {
    throw new Error(`Unsupported file type: ${file.type || file.name}`);
  }
  const { db, storage } = getFirebase();
  const { effectsSettings, selectedPresetId } = await loadWorkspaceDefaults(uid);

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
    effectsSettings,
    ...(selectedPresetId ? { selectedPresetId } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const projectId = created.id;
  const source = (interactionScope ?? "external") === "tab" ? "recording" : "upload";
  void trackEvent(EVENTS.PROJECT_CREATED, { source, fileSize: file.size }, { projectId });
  void trackEvent(
    EVENTS.VIDEO_UPLOAD_STARTED,
    { source, fileSize: file.size, mimeType: file.type || "video/mp4" },
    { projectId }
  );

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

  // 4. Upload interactions.json whenever we captured ANY events — regardless
  // of scope. Discarding external/untrusted streams here used to hide a click
  // stream that the analyzer could at least count (and, for HiDPI tabs that
  // were misclassified as external, actually use). The manifest carries the
  // scope + a coordinate-trust assessment so the analyzer can LOAD it always
  // and decide separately whether to TRUST the coordinates. Done after the
  // video lands so the project is usable even if this step fails.
  const scope = interactionScope ?? "external";
  const trust = assessCoordinateTrust(scope);
  let interactionsPath: string | null = null;
  if (interactions && interactions.length > 0) {
    const interactionsBlob = new Blob(
      [
        JSON.stringify({
          version: 2,
          scope,
          trusted: trust.trusted,
          trustReason: trust.reason,
          events: interactions,
        }),
      ],
      { type: "application/json" }
    );
    interactionsPath = `users/${uid}/projects/${projectId}/original/interactions.json`;
    try {
      await uploadBytes(storageRef(storage, interactionsPath), interactionsBlob, {
        contentType: "application/json",
      });
    } catch (err) {
      // Non-fatal — analysis will fall back to CV-only.
      console.warn("[createProjectFromFile] interactions upload failed", err);
      interactionsPath = null;
    }
  }

  await updateDoc(doc(db, "users", uid, "projects", projectId), {
    status: "uploaded" as ProjectStatus,
    storagePath: path,
    originalVideoUrl: downloadURL,
    interactionScope: scope,
    ...(interactionsPath ? { interactionsPath } : {}),
    ...(captureDimensions ? { captureDimensions } : {}),
    ...(sourceCrop ? { sourceCrop } : {}),
    updatedAt: serverTimestamp(),
  });

  void trackEvent(
    EVENTS.VIDEO_UPLOAD_COMPLETED,
    {
      source: scope === "tab" ? "recording" : "upload",
      fileSize: file.size,
      duration: duration ?? null,
      mimeType: file.type || "video/mp4",
    },
    { projectId }
  );

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
  void trackEvent(EVENTS.PROJECT_DELETED, {}, { projectId });
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
    interactionScope: (data.interactionScope as ProjectDoc["interactionScope"]) ?? undefined,
    interactionsPath: (data.interactionsPath as string) ?? undefined,
    captureDimensions: (data.captureDimensions as ProjectDoc["captureDimensions"]) ?? undefined,
    sourceCrop: materializeSourceCrop(data),
    createdAt: tsMs(data.createdAt) ?? Date.now(),
    updatedAt: tsMs(data.updatedAt) ?? Date.now(),
  };
}

/**
 * Read the global `sourceCrop`, with a back-compat shim for projects saved
 * under the earlier bottom-only `recordingCleanup` model: synthesize an
 * equivalent bottom-only crop rect so they keep removing the sharing bar.
 */
function materializeSourceCrop(
  data: Record<string, unknown>
): SourceCrop | undefined {
  const direct = data.sourceCrop as SourceCrop | undefined;
  if (direct) return direct;
  const legacy = data.recordingCleanup as
    | {
        removeBottomCaptureBar?: boolean;
        bottomCropPx?: number;
        sourceHeight?: number;
        confidence?: number;
      }
    | undefined;
  if (
    legacy &&
    legacy.removeBottomCaptureBar &&
    (legacy.bottomCropPx ?? 0) > 0 &&
    (legacy.sourceHeight ?? 0) > 0
  ) {
    const height = Math.max(
      0,
      Math.min(1, (legacy.sourceHeight! - legacy.bottomCropPx!) / legacy.sourceHeight!)
    );
    return {
      enabled: true,
      x: 0,
      y: 0,
      width: 1,
      height,
      reason: "browser-bar-cleanup",
      confidence: legacy.confidence,
    };
  }
  return undefined;
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
