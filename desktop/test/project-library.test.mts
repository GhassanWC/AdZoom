/**
 * The dedup rule for the merged project library.
 *
 * A desktop user has two sources of projects — this computer and their Framevo
 * account — and a project can legitimately be in both. Showing it twice is the
 * obvious bug; showing the CLOUD copy is the subtle one, because that copy
 * can't be opened offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeProjectSources } from "@/lib/projects/merge-projects.ts";
import { LOCAL_OWNER } from "@/lib/platform/local.ts";
import type { ProjectDoc } from "@/lib/firebase/schema.ts";
import type { ProjectSummary } from "@/lib/platform/types.ts";

function local(over: Partial<ProjectSummary> & { id: string }): ProjectSummary {
  return {
    title: "Local project",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...over,
  };
}

function cloud(over: Partial<ProjectDoc> & { id: string }): ProjectDoc {
  return {
    userId: "firebase-uid",
    title: "Cloud project",
    originalVideoUrl: "https://storage.example/v.mp4",
    storagePath: "users/u/projects/p/original/v.mp4",
    status: "analyzed",
    effectsSettings: {} as ProjectDoc["effectsSettings"],
    createdAt: 1_000,
    updatedAt: 2_000,
    ...over,
  } as ProjectDoc;
}

test("unlinked projects from both sources all appear", () => {
  const merged = mergeProjectSources(
    [local({ id: "L1" }), local({ id: "L2" })],
    [cloud({ id: "C1" })]
  );
  assert.deepEqual(merged.map((p) => p.id).sort(), ["C1", "L1", "L2"]);
});

test("a project in both places is listed ONCE, as the local copy", () => {
  const merged = mergeProjectSources(
    [local({ id: "L1", title: "My cut", cloudProjectId: "C1" })],
    [cloud({ id: "C1", title: "My cut" })]
  );
  assert.equal(merged.length, 1);
  // The local id wins: it is the one that opens with no network.
  assert.equal(merged[0]!.id, "L1");
  assert.equal(merged[0]!.userId, LOCAL_OWNER);
});

test("the surviving row adopts the cloud's richer state", () => {
  const merged = mergeProjectSources(
    [local({ id: "L1", cloudProjectId: "C1", updatedAt: 1_000 })],
    [
      cloud({
        id: "C1",
        status: "analyzed",
        updatedAt: 5_000,
        analysis: { detectedMoments: [{ id: "m1" }] } as ProjectDoc["analysis"],
      }),
    ]
  );
  assert.equal(merged.length, 1);
  // Otherwise a synced project would visibly regress to "uploaded" with no
  // moments the moment the desktop app showed it.
  assert.equal(merged[0]!.status, "analyzed");
  assert.equal(merged[0]!.analysis?.detectedMoments?.length, 1);
  assert.equal(merged[0]!.updatedAt, 5_000);
});

test("a link pointing at a cloud project that is gone still shows the local one", () => {
  const merged = mergeProjectSources([local({ id: "L1", cloudProjectId: "C-deleted" })], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.id, "L1");
  assert.equal(merged[0]!.status, "uploaded");
});

test("a missing source file is surfaced, not hidden", () => {
  const merged = mergeProjectSources([local({ id: "L1", mediaMissing: true })], []);
  // The card renders this as "Failed" with an explanation, rather than looking
  // healthy right up until the editor fails to open it.
  assert.equal(merged[0]!.status, "failed");
  assert.equal(merged[0]!.originalVideoUrl, "");
});

test("local projects never carry a fileSize, so they can't consume cloud quota", () => {
  const merged = mergeProjectSources([local({ id: "L1" })], []);
  assert.equal(merged[0]!.fileSize, undefined);
});

test("the list is newest-first regardless of which source a project came from", () => {
  const merged = mergeProjectSources(
    [local({ id: "L1", updatedAt: 300 }), local({ id: "L2", updatedAt: 100 })],
    [cloud({ id: "C1", updatedAt: 200 })]
  );
  assert.deepEqual(
    merged.map((p) => p.id),
    ["L1", "C1", "L2"]
  );
});

test("signed out, only local projects are listed", () => {
  const merged = mergeProjectSources([local({ id: "L1" })], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.userId, LOCAL_OWNER);
});
