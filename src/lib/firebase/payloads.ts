/**
 * Large-payload OFFLOAD for the project document.
 *
 * Firestore caps a document at 1 MiB and the analysis pipeline writes several
 * bulky, regenerable fields (visual analysis, raw/rejected moment pools,
 * diagnostics, Director history). This module moves those to Storage blobs
 * next to the project (`users/{uid}/projects/{pid}/payloads/<field>.json`)
 * and leaves a small reference in the document:
 *
 *   doc.payloadRefs = { visualAnalysis: { path, bytes, sha1, at } }
 *
 * READ path (`inlinePayloads`) is backward compatible: a legacy document that
 * still carries the field inline wins; a document with only a reference is
 * hydrated on demand. WRITES are gated behind `PROJECT_PAYLOAD_OFFLOAD=1` so
 * the migration can be compared first (scripts/compare-payload-offload.mts
 * renders the same project from the inline and the offloaded form and diffs
 * the recipe + frames) before being enabled on existing projects.
 *
 * Pure except the two Storage helpers, which take an injected bucket so both
 * the Admin SDK (routes, worker) and tests can drive them.
 */

import { createHash } from "node:crypto";

export const OFFLOADABLE_FIELDS = ["visualAnalysis", "analysis.rawMoments", "analysis.rejectedPool", "analysis.editDiagnostics", "analysis.clickPipeline", "analysis.attentionCurve", "director.revisions"] as const;
export type OffloadableField = (typeof OFFLOADABLE_FIELDS)[number];

/** Fields smaller than this stay inline (a round trip isn't worth it). */
export const OFFLOAD_MIN_BYTES = 32 * 1024;

export interface PayloadRef {
  path: string;
  bytes: number;
  sha1: string;
  at: number;
}

export type PayloadRefs = Partial<Record<OffloadableField, PayloadRef>>;

export interface BlobStore {
  put(path: string, json: string): Promise<void>;
  get(path: string): Promise<string | null>;
}

export function offloadEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PROJECT_PAYLOAD_OFFLOAD === "1";
}

function getPath(doc: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), doc);
}
function setPath(doc: Record<string, unknown>, field: string, value: unknown): void {
  const parts = field.split(".");
  let cur = doc;
  for (const k of parts.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  if (value === undefined) delete cur[parts[parts.length - 1]];
  else cur[parts[parts.length - 1]] = value;
}

/** Which fields of `doc` would be offloaded, with their sizes. Pure. */
export function planOffload(doc: Record<string, unknown>, minBytes = OFFLOAD_MIN_BYTES): { field: OffloadableField; bytes: number }[] {
  const out: { field: OffloadableField; bytes: number }[] = [];
  for (const field of OFFLOADABLE_FIELDS) {
    const v = getPath(doc, field);
    if (v === undefined || v === null) continue;
    const bytes = Buffer.byteLength(JSON.stringify(v));
    if (bytes >= minBytes) out.push({ field, bytes });
  }
  return out;
}

/**
 * Move the large fields of `doc` to blobs. Returns the document patch to
 * write (field deleted via `deleteMarker`, reference added) — the caller
 * writes it. Deterministic paths, content-addressed by sha1 so a retry
 * re-uploads the same bytes to the same object.
 */
export async function offloadPayloads(
  doc: Record<string, unknown>,
  args: { uid: string; projectId: string; store: BlobStore; deleteMarker: unknown; now?: number; minBytes?: number }
): Promise<{ patch: Record<string, unknown>; refs: PayloadRefs; moved: OffloadableField[] }> {
  const refs: PayloadRefs = { ...((doc.payloadRefs as PayloadRefs | undefined) ?? {}) };
  const patch: Record<string, unknown> = {};
  const moved: OffloadableField[] = [];
  for (const { field } of planOffload(doc, args.minBytes)) {
    const value = getPath(doc, field);
    const json = JSON.stringify(value);
    const sha1 = createHash("sha1").update(json).digest("hex");
    const path = `users/${args.uid}/projects/${args.projectId}/payloads/${field.replace(/\./g, "-")}.json`;
    if (refs[field]?.sha1 !== sha1) await args.store.put(path, json);
    refs[field] = { path, bytes: Buffer.byteLength(json), sha1, at: args.now ?? Date.now() };
    setPath(patch, field, args.deleteMarker);
    moved.push(field);
  }
  if (moved.length) patch.payloadRefs = refs;
  return { patch, refs, moved };
}

/**
 * Backward-compatible read: hydrate referenced fields that are NOT inline.
 * Legacy documents (everything inline) pass through untouched; a reference
 * whose blob is missing leaves the field absent and is reported.
 */
export async function inlinePayloads(doc: Record<string, unknown>, store: BlobStore): Promise<{ doc: Record<string, unknown>; hydrated: OffloadableField[]; missing: OffloadableField[] }> {
  const refs = (doc.payloadRefs as PayloadRefs | undefined) ?? {};
  const out = structuredClone(doc);
  const hydrated: OffloadableField[] = [];
  const missing: OffloadableField[] = [];
  for (const field of Object.keys(refs) as OffloadableField[]) {
    if (getPath(out, field) !== undefined) continue; // inline copy wins
    const json = await store.get(refs[field]!.path);
    if (json == null) {
      missing.push(field);
      continue;
    }
    setPath(out, field, JSON.parse(json));
    hydrated.push(field);
  }
  return { doc: out, hydrated, missing };
}

/** Key-order-insensitive serialization (a hydrated map has its keys in a different order than the original). */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
}

/** Fields of two documents that differ after both are fully inlined (the migration check). */
export function diffInlined(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (k === "payloadRefs" || k === "updatedAt") continue;
    if (canonical(a[k]) !== canonical(b[k])) out.push(k);
  }
  return out;
}
