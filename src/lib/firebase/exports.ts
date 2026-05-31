/**
 * Live subscription helpers for the user's exports collection.
 *
 * Single source of truth — `subscribeExports(uid, onChange)` is the same
 * shape as `subscribeProjects(uid, onChange)` in `projects.ts`. Used by:
 *   - `src/app/dashboard/exports/page.tsx` (the exports list page)
 *   - `src/components/dashboard/NavbarSearch.tsx` (global search)
 *
 * Materialising the Firestore doc into a typed `ExportDoc` happens here
 * so consumers don't reimplement the timestamp / fallback dance.
 */

import {
  collection,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebase } from "./client";
import type { ExportDoc } from "./schema";

function materializeExport(id: string, data: Record<string, unknown>): ExportDoc {
  const createdAt = data.createdAt as { toMillis?: () => number } | undefined;
  const completedAt = data.completedAt as { toMillis?: () => number } | undefined;
  return {
    id,
    projectId: (data.projectId as string) ?? "",
    projectTitle: (data.projectTitle as string) ?? "Untitled",
    format: (data.format as ExportDoc["format"]) ?? "1080p",
    resolution: (data.resolution as ExportDoc["resolution"]) ?? "1080p",
    fps: (data.fps as ExportDoc["fps"]) ?? 30,
    exportUrl: data.exportUrl as string | undefined,
    storagePath: data.storagePath as string | undefined,
    fileSize: data.fileSize as number | undefined,
    status: (data.status as ExportDoc["status"]) ?? "queued",
    errorMessage: data.errorMessage as string | undefined,
    createdAt: createdAt?.toMillis?.() ?? Date.now(),
    completedAt: completedAt?.toMillis?.(),
  };
}

export function subscribeExports(
  uid: string,
  onChange: (exports: ExportDoc[]) => void
): Unsubscribe {
  const { db } = getFirebase();
  const q = query(
    collection(db, "users", uid, "exports"),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map((d) => materializeExport(d.id, d.data())));
  });
}
