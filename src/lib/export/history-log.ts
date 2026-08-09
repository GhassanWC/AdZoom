"use client";

import { getFirebase } from "@/lib/firebase/client";

import { apiFetch } from "@/lib/platform/api";
/**
 * Best-effort logging of an IN-BROWSER (editframe) export to the user's Export
 * history. In-browser renders create no cloud job and are never stored, so
 * without this they'd be invisible in the dashboard — a canceled or failed one
 * would vanish without a trace. This POSTs a lightweight AUDIT record (no
 * usage/billing) that the server writes via the Admin SDK.
 *
 * Deliberately fire-and-forget: a logging failure must NEVER affect the export
 * itself. `keepalive` lets the final (cancel / navigate-away) call survive an
 * unload.
 */
export interface ExportHistoryLog {
  /** Stable id for the record — same value on the start and terminal calls. */
  exportId: string;
  /** Client ms; the server pins `createdAt` to this so the row keeps its place. */
  startedAt: number;
  projectId: string;
  projectTitle: string;
  status: "exporting" | "ready" | "failed" | "canceled";
  engine?: "editframe" | "browser";
  container?: "mp4" | "webm";
  resolution?: "720p" | "1080p";
  fps?: 30 | 60;
  outputWidth?: number;
  outputHeight?: number;
  errorMessage?: string;
}

export async function logExportHistory(payload: ExportHistoryLog): Promise<void> {
  try {
    const { auth } = getFirebase();
    const token = await auth.currentUser?.getIdToken();
    if (!token) return;
    await apiFetch("/api/export/history", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch (err) {
    console.warn("[export-history] log failed", err);
  }
}
