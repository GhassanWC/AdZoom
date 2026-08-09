"use client";

/**
 * `RemoteProjectStore` over Firestore — the ONLY place sync talks to the cloud.
 *
 * Deliberately thin. It reuses `toFirestorePatch` (the same translation the web
 * app's writes go through) and `materializeProject`, so a document written from
 * the desktop is byte-for-byte the shape the website reads, and there is no
 * second write dialect to keep in step. Everything interesting — what to send,
 * when, and what to do when it comes back stale — lives in the engine.
 */
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  type DocumentReference,
  type Firestore,
} from "firebase/firestore";
import { getFirebase } from "@/lib/firebase/client";
import { toFirestorePatch } from "@/lib/platform/cloud-project-storage";
import type { DocPatch } from "@/lib/platform/field-value";
import { revisionOf, stampRevision } from "./revision";
import type { CommitResult, RemoteDoc, RemoteProjectStore } from "./ports";

function toRemoteDoc(projectId: string, data: Record<string, unknown> | null): RemoteDoc {
  return {
    projectId,
    doc: data,
    rev: revisionOf(data),
    lastOpId: typeof data?.lastOpId === "string" ? data.lastOpId : undefined,
    updatedAt: typeof data?.updatedAt === "number" ? data.updatedAt : undefined,
  };
}

/**
 * @param firestore Inject a Firestore instance to talk to something other than
 *   the app's own — specifically the EMULATOR, which is the only way the
 *   integration matrix can exercise this file against real `firestore.rules`
 *   without touching a live project. Production passes nothing and gets the
 *   app's single client, exactly as before.
 */
export function createFirestoreRemote(
  uid: string,
  firestore?: Firestore
): RemoteProjectStore {
  const db = () => firestore ?? getFirebase().db;
  const ref = (projectId: string): DocumentReference =>
    doc(db(), "users", uid, "projects", projectId);

  return {
    async commit({ projectId, opId, baseRev, patch, deviceId }): Promise<CommitResult> {
      const reference = ref(projectId);

      // A TRANSACTION, not a read-then-write. Two devices that both saw rev 4
      // would otherwise both conclude they were current and both write rev 5 —
      // the silent overwrite this design exists to prevent. Firestore aborts and
      // retries the callback if the document changed underneath it.
      const outcome = await runTransaction(db(), async (tx) => {
        const snap = await tx.get(reference);
        const data = (snap.exists() ? snap.data() : null) as Record<string, unknown> | null;

        // Already applied: a retry whose first attempt committed but whose ack
        // was lost on the way back. Not a conflict — our own success.
        if (data && data.lastOpId === opId) return "skipped" as const;
        if (revisionOf(data) !== baseRev) return "stale" as const;

        tx.set(
          reference,
          {
            ...toFirestorePatch(patch as DocPatch),
            ...stampRevision({ remote: data, deviceId, opId }),
          },
          { merge: true }
        );
        return "applied" as const;
      });

      // Read back AFTER the transaction rather than predicting the result.
      // The prediction would be wrong for `serverTimestamp()` (which resolves on
      // the server) and, more importantly, this document is what advances the
      // local `baseDoc` — the engine suppresses its own echo from the listener,
      // so if this were approximate the next compare-and-set would fail.
      const after = await getDoc(reference);
      const data = (after.exists() ? after.data() : null) as Record<string, unknown> | null;
      return { status: outcome, remote: toRemoteDoc(projectId, data) };
    },

    async remove(projectId) {
      // Idempotent by Firestore's own semantics: deleting a missing document
      // succeeds, which is what a retried delete needs.
      await deleteDoc(ref(projectId));
    },

    subscribeAll({ onDoc, onError, onSynced }) {
      let delivered = false;
      return onSnapshot(
        collection(db(), "users", uid, "projects"),
        // `includeMetadataChanges` is deliberately OFF: local-write echoes with
        // pending writes would otherwise arrive as separate events and be
        // ingested before the server had confirmed them.
        (snapshot) => {
          for (const change of snapshot.docChanges()) {
            if (change.type === "removed") {
              onDoc({ projectId: change.doc.id, doc: null, rev: 0 });
              continue;
            }
            onDoc(
              toRemoteDoc(change.doc.id, change.doc.data() as Record<string, unknown>)
            );
          }
          if (!delivered) {
            delivered = true;
            onSynced?.();
          }
        },
        (error) => onError(error as Error)
      );
    },
  };
}
