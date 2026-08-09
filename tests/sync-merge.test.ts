/**
 * The three-way merge — the piece that decides whether a simultaneous edit is
 * reconciled or reported.
 *
 * These are the cases that cost a user their work when they are wrong, so each
 * one is stated as a scenario ("web trims a caption while desktop moves a zoom")
 * rather than as a data-structure assertion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyConflictChoices, mergeProjectDocs } from "@/lib/sync/merge";
import type { FieldConflict } from "@/lib/sync/types";

type Doc = Record<string, unknown>;

function moment(id: string, over: Doc = {}): Doc {
  return { id, startTime: 1, endTime: 2, effectType: "zoom", ...over };
}

function projectDoc(moments: Doc[], over: Doc = {}): Doc {
  return {
    id: "p1",
    title: "Demo",
    status: "ready",
    effectsSettings: { autoZoom: 1, zoomSpeed: 0.5 },
    analysis: { status: "complete", detectedMoments: moments, boringSections: [] },
    createdAt: 1,
    updatedAt: 10,
    ...over,
  };
}

const pathsOf = (conflicts: FieldConflict[]) => conflicts.map((c) => c.path).sort();

// ── the easy directions ────────────────────────────────────────────────────

test("only the web changed → the change downloads with no conflict", () => {
  const base = projectDoc([moment("a")]);
  const local = projectDoc([moment("a")]);
  const remote = projectDoc([moment("a")], { title: "Renamed on web" });

  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });
  assert.deepEqual(conflicts, []);
  assert.equal(merged.title, "Renamed on web");
});

test("only the desktop changed → the change uploads with no conflict", () => {
  const base = projectDoc([moment("a")]);
  const local = projectDoc([moment("a")], { title: "Renamed on desktop" });
  const remote = projectDoc([moment("a")]);

  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });
  assert.deepEqual(conflicts, []);
  assert.equal(merged.title, "Renamed on desktop");
});

test("both made the SAME change → agreement is not a conflict", () => {
  // Two devices reacting to the same analysis result land here constantly.
  const base = projectDoc([moment("a")]);
  const local = projectDoc([moment("a")], { status: "analyzed" });
  const remote = projectDoc([moment("a")], { status: "analyzed" });

  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });
  assert.deepEqual(conflicts, []);
  assert.equal(merged.status, "analyzed");
});

test("nothing changed anywhere → reported as unchanged so the write is skipped", () => {
  const base = projectDoc([moment("a")]);
  const result = mergeProjectDocs({
    base,
    local: projectDoc([moment("a")]),
    remote: projectDoc([moment("a")]),
  });
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.conflicts, []);
});

// ── the whole point: independent edits must merge silently ─────────────────

test("different moments edited on each side merge without asking", () => {
  const base = projectDoc([moment("a"), moment("b")]);
  const local = projectDoc([moment("a", { startTime: 5 }), moment("b")]);
  const remote = projectDoc([moment("a"), moment("b", { endTime: 9 })]);

  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });
  assert.deepEqual(conflicts, [], "editing different pills is not a conflict");

  const moments = (merged.analysis as Doc).detectedMoments as Doc[];
  const byId = new Map(moments.map((m) => [m.id, m]));
  assert.equal(byId.get("a")!.startTime, 5, "desktop's edit survived");
  assert.equal(byId.get("b")!.endTime, 9, "web's edit survived");
});

test("different sub-fields of effectsSettings merge without asking", () => {
  const base = projectDoc([]);
  const local = projectDoc([], { effectsSettings: { autoZoom: 2, zoomSpeed: 0.5 } });
  const remote = projectDoc([], { effectsSettings: { autoZoom: 1, zoomSpeed: 0.9 } });

  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged.effectsSettings, { autoZoom: 2, zoomSpeed: 0.9 });
});

test("an edit added on one side only is kept", () => {
  const base = projectDoc([moment("a")]);
  const local = projectDoc([moment("a"), moment("new", { startTime: 7 })]);
  const remote = projectDoc([moment("a")]);

  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });
  assert.deepEqual(conflicts, []);
  const ids = ((merged.analysis as Doc).detectedMoments as Doc[]).map((m) => m.id);
  assert.deepEqual(ids, ["a", "new"]);
});

test("an edit deleted on one side and untouched on the other stays deleted", () => {
  const base = projectDoc([moment("a"), moment("b")]);
  const local = projectDoc([moment("a")]); // desktop deleted b
  const remote = projectDoc([moment("a"), moment("b")]);

  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });
  assert.deepEqual(conflicts, []);
  const ids = ((merged.analysis as Doc).detectedMoments as Doc[]).map((m) => m.id);
  assert.deepEqual(ids, ["a"], "the delete is a real change and must not resurrect");
});

test("merged moments come back in timeline order", () => {
  const base = projectDoc([]);
  const local = projectDoc([moment("late", { startTime: 9 })]);
  const remote = projectDoc([moment("early", { startTime: 1 })]);

  const { merged } = mergeProjectDocs({ base, local, remote });
  const ids = ((merged.analysis as Doc).detectedMoments as Doc[]).map((m) => m.id);
  assert.deepEqual(ids, ["early", "late"]);
});

// ── the cases that must ASK ────────────────────────────────────────────────

test("the same field changed on both sides is a conflict", () => {
  const base = projectDoc([moment("a")]);
  const local = projectDoc([moment("a")], { title: "Desktop name" });
  const remote = projectDoc([moment("a")], { title: "Web name" });

  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });
  assert.deepEqual(pathsOf(conflicts), ["title"]);
  assert.equal(conflicts[0]!.local, "Desktop name");
  assert.equal(conflicts[0]!.remote, "Web name");
  assert.equal(conflicts[0]!.base, "Demo");
  assert.equal(merged.title, "Desktop name", "the local view is preserved until resolved");
});

test("the same moment edited on both sides is a conflict naming that moment", () => {
  const base = projectDoc([moment("a")]);
  const local = projectDoc([moment("a", { startTime: 3 })]);
  const remote = projectDoc([moment("a", { startTime: 8 })]);

  const { conflicts } = mergeProjectDocs({ base, local, remote });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.momentId, "a");
  assert.equal(conflicts[0]!.path, "analysis.detectedMoments[a]");
});

test("deleted on one side, edited on the other is a conflict — not a silent delete", () => {
  const base = projectDoc([moment("a")]);
  const local = projectDoc([]); // desktop deleted it
  const remote = projectDoc([moment("a", { startTime: 4 })]); // web edited it

  const { conflicts } = mergeProjectDocs({ base, local, remote });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.momentId, "a");
  assert.equal(conflicts[0]!.local, undefined, "local side is a deletion");
  assert.ok(conflicts[0]!.remote, "remote side is an edit");
});

test("with no common ancestor, a genuine difference is reported rather than guessed", () => {
  // First link of a project that already exists in both places.
  const local = projectDoc([moment("a")], { title: "Desktop" });
  const remote = projectDoc([moment("a")], { title: "Web" });

  const { conflicts } = mergeProjectDocs({ base: null, local, remote });
  assert.ok(conflicts.some((c) => c.path === "title"));
});

// ── sync bookkeeping must never be user data ──────────────────────────────

test("rev / lastOpId never become conflicts and never leak into the merge", () => {
  const base = projectDoc([moment("a")], { rev: 4, lastOpId: "op_base" });
  const local = projectDoc([moment("a")], { rev: 5, lastOpId: "op_local" });
  const remote = projectDoc([moment("a")], { rev: 9, lastOpId: "op_remote" });

  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });
  assert.deepEqual(conflicts, [], "revision counters are not a user-visible disagreement");
  assert.equal("rev" in merged, false, "the caller re-stamps these after merging");
  assert.equal("lastOpId" in merged, false);
});

test("updatedAt takes the newer side instead of conflicting", () => {
  const base = projectDoc([moment("a")], { updatedAt: 10 });
  const local = projectDoc([moment("a")], { updatedAt: 20, title: "Desktop" });
  const remote = projectDoc([moment("a")], { updatedAt: 30 });

  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });
  assert.deepEqual(pathsOf(conflicts), [], "a timestamp is not something to ask a human about");
  assert.equal(merged.updatedAt, 30);
});

// ── resolution ─────────────────────────────────────────────────────────────

test("choosing the web's version applies it to a scalar field", () => {
  const base = projectDoc([moment("a")]);
  const local = projectDoc([moment("a")], { title: "Desktop name" });
  const remote = projectDoc([moment("a")], { title: "Web name" });
  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });

  const resolved = applyConflictChoices(merged, conflicts, { title: "remote" });
  assert.equal(resolved.title, "Web name");
});

test("choosing the web's version applies it to one moment, leaving the rest alone", () => {
  const base = projectDoc([moment("a"), moment("b")]);
  const local = projectDoc([moment("a", { startTime: 3 }), moment("b", { endTime: 4 })]);
  const remote = projectDoc([moment("a", { startTime: 8 }), moment("b")]);
  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });

  const resolved = applyConflictChoices(merged, conflicts, {
    "analysis.detectedMoments[a]": "remote",
  });
  const byId = new Map(
    ((resolved.analysis as Doc).detectedMoments as Doc[]).map((m) => [m.id, m])
  );
  assert.equal(byId.get("a")!.startTime, 8, "the contested moment took the web's value");
  assert.equal(byId.get("b")!.endTime, 4, "the auto-merged moment was untouched");
});

test("resolving a delete-vs-edit in favour of the delete removes the moment", () => {
  const base = projectDoc([moment("a")]);
  const local = projectDoc([]);
  const remote = projectDoc([moment("a", { startTime: 4 })]);
  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });

  const resolved = applyConflictChoices(merged, conflicts, {
    "analysis.detectedMoments[a]": "local",
  });
  assert.deepEqual((resolved.analysis as Doc).detectedMoments, []);
});

test("an unanswered conflict keeps the merge's value rather than reverting", () => {
  const base = projectDoc([moment("a")]);
  const local = projectDoc([moment("a")], { title: "Desktop", status: "draft" });
  const remote = projectDoc([moment("a")], { title: "Web", status: "ready" });
  const { merged, conflicts } = mergeProjectDocs({ base, local, remote });

  // Only one of the two conflicts is answered.
  const resolved = applyConflictChoices(merged, conflicts, { title: "remote" });
  assert.equal(resolved.title, "Web");
  assert.equal(resolved.status, "draft", "the untouched entry kept the merged value");
});
