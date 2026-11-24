/**
 * Migration check for project-payload offloading (src/lib/firebase/payloads.ts).
 *
 *   node --import ./tests/register-resolver.mjs scripts/compare-payload-offload.mts <uid> <projectId> [--write]
 *
 * Reads the project, offloads its large fields into an IN-MEMORY store (no
 * document or Storage writes unless --write), inlines them back, and compares:
 *   1. the inlined document against the original (must be identical),
 *   2. the render recipe built from each (output duration, canvas, moment count),
 *   3. the first/middle/last evaluated frames (layers + overlay ids).
 * Only with --write (and PROJECT_PAYLOAD_OFFLOAD=1) does it upload the blobs
 * and patch the document. Exit code 1 on any difference.
 */
import admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { diffInlined, inlinePayloads, offloadPayloads, offloadEnabled, planOffload, type BlobStore } from "../src/lib/firebase/payloads";
import { buildRenderRecipe } from "../src/lib/render/recipe";
import { evaluateTimeline } from "../src/lib/timeline/evaluate";
import { DEFAULT_EFFECTS_SETTINGS, type ProjectDoc } from "../src/lib/firebase/schema";

const [, , uid, projectId, flag] = process.argv;
if (!uid || !projectId) throw new Error("usage: compare-payload-offload <uid> <projectId> [--write]");
const env = Object.fromEntries(readFileSync(".env.local", "utf8").split(/\r?\n/).map((l) => l.split("=")).filter((p) => p.length > 1).map(([k, ...v]) => [k, v.join("=").replace(/^"|"$/g, "")]));
const sa = JSON.parse(Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_B64!, "base64").toString("utf8"));
admin.initializeApp({ credential: admin.credential.cert(sa), storageBucket: env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET });
const ref = admin.firestore().doc(`users/${uid}/projects/${projectId}`);
const original = (await ref.get()).data() as Record<string, unknown>;

const mem = new Map<string, string>();
const memStore: BlobStore = { put: async (p, j) => void mem.set(p, j), get: async (p) => mem.get(p) ?? null };
console.log("plan:", planOffload(original));
const { patch, moved } = await offloadPayloads(original, { uid, projectId, store: memStore, deleteMarker: undefined });
const offloaded = structuredClone(original);
for (const f of moved) {
  const parts = f.split(".");
  let cur = offloaded as Record<string, unknown>;
  for (const k of parts.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  delete cur[parts[parts.length - 1]];
}
offloaded.payloadRefs = patch.payloadRefs;
const { doc: inlined, missing } = await inlinePayloads(offloaded, memStore);
const docDiff = diffInlined(original, inlined);
const recipeFor = (d: Record<string, unknown>) => {
  const p = d as unknown as ProjectDoc;
  return buildRenderRecipe({ sourceWidth: p.width ?? 1920, sourceHeight: p.height ?? 1080, fps: 30, resolution: "1080p", format: "Source", sourceDuration: p.duration ?? 0, moments: p.analysis?.detectedMoments ?? [], effects: { ...DEFAULT_EFFECTS_SETTINGS, ...(p.effectsSettings ?? {}) }, visualAnalysis: p.visualAnalysis, sourceCrop: p.sourceCrop ?? null, applyWatermark: false, sequence: p.sequence ?? null, assets: p.assets ?? [] });
};
const r0 = recipeFor(original);
const r1 = recipeFor(inlined);
const recipeDiff = ["outputDuration", "canvasW", "canvasH", "bgMode", "effectiveFit"].filter((k) => JSON.stringify((r0 as unknown as Record<string, unknown>)[k]) !== JSON.stringify((r1 as unknown as Record<string, unknown>)[k]));
const frameSig = (r: typeof r0, t: number) => {
  const ev = evaluateTimeline(r.revision, t);
  return JSON.stringify({ layers: ev.layers.map((l) => [l.assetId, +l.sourceTime.toFixed(4), +l.opacity.toFixed(3)]), overlays: ev.overlays.map((o) => o.moment.id).sort() });
};
const times = [0, r0.outputDuration / 2, Math.max(0, r0.outputDuration - 1 / 30)];
const frameDiff = times.filter((t) => frameSig(r0, t) !== frameSig(r1, t));
console.log(JSON.stringify({ moved, missing, docDiff, recipeDiff, frameDiff, bytesMoved: moved.reduce((n, f) => n + (patch.payloadRefs as Record<string, { bytes: number }>)[f].bytes, 0) }, null, 1));
const ok = !docDiff.length && !recipeDiff.length && !frameDiff.length && !missing.length;
if (!ok) process.exit(1);
if (flag === "--write") {
  if (!offloadEnabled()) throw new Error("Refusing to write: set PROJECT_PAYLOAD_OFFLOAD=1 to enable offload writes.");
  const { adminBlobStore } = await import("../src/lib/firebase/payload-store");
  const real = await offloadPayloads(original, { uid, projectId, store: adminBlobStore(), deleteMarker: admin.firestore.FieldValue.delete() });
  await ref.set(real.patch, { merge: true });
  console.log("written:", real.moved);
}
