"use client";

/**
 * The CLOUD implementation of `ProjectStorage` — Firestore, exactly as the web
 * app has always done it.
 *
 * This file is a thin translation layer, deliberately dumb: it maps the
 * backend-agnostic sentinels from ./field-value onto real Firestore
 * `FieldValue`s and calls `setDoc(ref, patch, { merge: true })` through the
 * existing per-project write queue. Nothing about the web behaviour changes —
 * same document, same queue, same coalescing, same swallow-on-failure semantics
 * (see lib/firebase/project-writer.ts).
 */
import {
  arrayRemove as fsArrayRemove,
  arrayUnion as fsArrayUnion,
  deleteField as fsDeleteField,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp as fsServerTimestamp,
  setDoc,
  type DocumentReference,
} from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
import { materializeProject } from "@/lib/firebase/materialize-project";
import { enqueueProjectWrite } from "@/lib/firebase/project-writer";
import type { ProjectDoc } from "@/lib/firebase/schema";
import { FIELD_SENTINEL, isFieldSentinel, type DocPatch } from "./field-value";
import type { ProjectStorage, ProjectWriteOptions } from "./types";

/** Plain object = a nested map to walk into. Arrays and class instances are leaves. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-map our sentinels onto Firestore's. Everything else passes through
 * untouched, so a patch is byte-for-byte what the old inline `setDoc` calls
 * sent.
 */
export function toFirestorePatch(patch: DocPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isFieldSentinel(value)) {
      switch (value[FIELD_SENTINEL]) {
        case "arrayUnion":
          out[key] = fsArrayUnion(...value.elements);
          break;
        case "arrayRemove":
          out[key] = fsArrayRemove(...value.elements);
          break;
        case "delete":
          out[key] = fsDeleteField();
          break;
        case "serverTimestamp":
          out[key] = fsServerTimestamp();
          break;
      }
      continue;
    }
    out[key] = isPlainObject(value) ? toFirestorePatch(value) : value;
  }
  return out;
}

export function createCloudProjectStorage(uid: string): ProjectStorage {
  const ref = (projectId: string): DocumentReference =>
    doc(getFirebase().db, "users", uid, "projects", projectId);

  return {
    kind: "cloud",
    label: "Firestore",

    subscribe(projectId, onChange) {
      return onSnapshot(
        ref(projectId),
        (snap) => onChange(snap.exists() ? materializeProject(snap.id, snap.data()) : null),
        (err) => {
          console.warn("[cloud-storage] subscription error", err);
          onChange(null);
        }
      );
    },

    async get(projectId): Promise<ProjectDoc | null> {
      const snap = await getDoc(ref(projectId));
      return snap.exists() ? materializeProject(snap.id, snap.data()) : null;
    },

    async write(projectId, patch, options: ProjectWriteOptions = {}) {
      const data = toFirestorePatch(patch);
      const commit = () => setDoc(ref(projectId), data, { merge: true });
      // Direct by default so failures still reach the caller (toast / retry);
      // queued only where the pre-port code queued, keeping error semantics.
      if (!options.queue && !options.coalesceTag) {
        await commit();
        return;
      }
      await enqueueProjectWrite(
        projectId,
        options.label ?? "project-write",
        commit,
        options.coalesceTag ? { coalesceTag: options.coalesceTag } : undefined
      );
    },
  };
}
