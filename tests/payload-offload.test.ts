import { test } from "node:test";
import assert from "node:assert/strict";
import { diffInlined, inlinePayloads, offloadPayloads, planOffload, type BlobStore } from "../src/lib/firebase/payloads.ts";

const memStore = (): BlobStore & { map: Map<string, string>; puts: number } => {
  const map = new Map<string, string>();
  const s = { map, puts: 0, put: async (p: string, j: string) => { map.set(p, j); s.puts++; }, get: async (p: string) => map.get(p) ?? null };
  return s;
};
const big = (n: number) => Array.from({ length: n }, (_, i) => ({ i, text: "x".repeat(40) }));

test("offload moves only the large regenerable fields, content-addressed, and the read path inlines them back identically", async () => {
  const doc: Record<string, unknown> = {
    title: "p",
    visualAnalysis: { frames: big(2000) },
    analysis: { detectedMoments: big(10), rawMoments: big(1500), editDiagnostics: { small: true } },
    director: { plan: { a: 1 }, revisions: big(3000) },
  };
  const store = memStore();
  const plan = planOffload(doc);
  assert.deepEqual(plan.map((p) => p.field), ["visualAnalysis", "analysis.rawMoments", "director.revisions"], "small fields and the timeline stay inline");
  const { patch, moved } = await offloadPayloads(doc, { uid: "u", projectId: "p", store, deleteMarker: "__DELETE__", now: 1 });
  assert.deepEqual(moved, plan.map((p) => p.field));
  assert.equal(patch.visualAnalysis, "__DELETE__");
  assert.equal((patch.analysis as { rawMoments: unknown }).rawMoments, "__DELETE__");
  assert.equal(store.puts, 3);
  // The stored document: inline fields removed, refs present.
  const stored = structuredClone(doc);
  delete stored.visualAnalysis;
  delete (stored.analysis as Record<string, unknown>).rawMoments;
  delete (stored.director as Record<string, unknown>).revisions;
  stored.payloadRefs = (patch as { payloadRefs: unknown }).payloadRefs;
  const { doc: back, hydrated, missing } = await inlinePayloads(stored, store);
  assert.deepEqual(hydrated.sort(), ["analysis.rawMoments", "director.revisions", "visualAnalysis"]);
  assert.deepEqual(missing, []);
  assert.deepEqual(diffInlined(doc, back), [], "offloaded + inlined == original");
  // Retry: same content → no second upload.
  const again = await offloadPayloads({ ...doc, payloadRefs: stored.payloadRefs }, { uid: "u", projectId: "p", store, deleteMarker: "__DELETE__", now: 2 });
  assert.equal(store.puts, 3, "unchanged payloads are not re-uploaded");
  assert.deepEqual(again.moved.length, 3);
});

test("legacy documents pass through the read path untouched; a missing blob is reported, not fatal", async () => {
  const legacy = { title: "old", visualAnalysis: { frames: big(5) } };
  const store = memStore();
  const r = await inlinePayloads(legacy, store);
  assert.deepEqual(r.doc, legacy);
  assert.deepEqual(r.hydrated, []);
  const dangling = { title: "x", payloadRefs: { visualAnalysis: { path: "nope.json", bytes: 1, sha1: "0", at: 0 } } };
  const d = await inlinePayloads(dangling, store);
  assert.deepEqual(d.missing, ["visualAnalysis"]);
  assert.equal("visualAnalysis" in d.doc, false);
});
