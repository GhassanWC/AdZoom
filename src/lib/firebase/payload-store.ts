import "server-only";

/**
 * Admin-SDK Storage store for offloaded project payloads (see payloads.ts),
 * plus the one read helper routes call: `hydrateProjectDoc` returns the raw
 * document with any offloaded fields inlined — a no-op for legacy documents.
 */
import { getAdmin } from "./admin";
import { inlinePayloads, type BlobStore } from "./payloads";

export function adminBlobStore(): BlobStore {
  const { storage } = getAdmin();
  const bucket = storage.bucket();
  return {
    async put(path, json) {
      await bucket.file(path).save(json, { contentType: "application/json", resumable: false });
    },
    async get(path) {
      try {
        const [buf] = await bucket.file(path).download();
        return buf.toString("utf8");
      } catch {
        return null;
      }
    },
  };
}

export async function hydrateProjectDoc(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!raw.payloadRefs) return raw;
  const { doc, missing } = await inlinePayloads(raw, adminBlobStore());
  if (missing.length) console.warn("[payloads] offloaded fields missing in storage", missing);
  return doc;
}
