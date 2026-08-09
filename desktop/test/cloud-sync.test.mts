/**
 * "Turn on cloud sync" — the step that was missing.
 *
 * A project recorded in the desktop app is local-only, and AI analysis runs on
 * Framevo's servers against an uploaded source. The editor said "turn on cloud
 * sync for this project first" and offered no way to do it, so Generate AI Edit
 * — the headline feature — was unreachable for anything recorded in the app.
 *
 * Two rules decide whether that now works correctly: which edits survive the
 * move, and when the button may be pressed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CARRIED_FIELDS,
  NEVER_CARRIED,
  carriedEdits,
  cloudSyncBlocker,
} from "@/lib/projects/cloud-sync-rules.ts";
import { LOCAL_OWNER } from "@/lib/platform/local.ts";
import type { ProjectDoc } from "@/lib/firebase/schema.ts";

const LOCAL_URL = "framevo://app/__media/abcdef123456";

function localProject(over: Partial<ProjectDoc> = {}): ProjectDoc {
  return {
    id: "local-1",
    userId: LOCAL_OWNER,
    title: "Untitled recording",
    originalVideoUrl: LOCAL_URL,
    storagePath: "",
    status: "uploaded",
    effectsSettings: {} as ProjectDoc["effectsSettings"],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  } as ProjectDoc;
}

/** A platform that CAN link (i.e. the desktop bridge). */
const desktop = { projects: { linkCloud: async () => {} } } as never;
/** The web bridge, which has no local library to link. */
const web = { projects: {} } as never;

// ── When the button may be pressed ─────────────────────────────────────────

test("a local project with a signed-in user can be synced", () => {
  assert.equal(cloudSyncBlocker(localProject(), desktop, "uid-1"), null);
});

test("signing in is required — the upload goes to the user's own account", () => {
  const blocker = cloudSyncBlocker(localProject(), desktop, null);
  assert.match(String(blocker), /sign in/i);
});

test("a project whose source file is gone cannot be synced", () => {
  // Nothing to upload: the media reference no longer resolves.
  const blocker = cloudSyncBlocker(
    localProject({ originalVideoUrl: "" }),
    desktop,
    "uid-1"
  );
  assert.match(String(blocker), /isn't available on this computer/i);
});

test("a CLOUD project is never offered the sync action", () => {
  // Already uploaded — `null` here means "no blocker", and the banner hides
  // itself for cloud projects, so this must not be treated as syncable.
  const cloud = localProject({ userId: "firebase-uid", originalVideoUrl: "https://x/y.mp4" });
  assert.equal(cloudSyncBlocker(cloud, desktop, "uid-1"), null);
});

test("the web build reports that it cannot sync", () => {
  const blocker = cloudSyncBlocker(localProject(), web, "uid-1");
  assert.match(String(blocker), /can't sync/i);
});

test("a project still loading is not syncable", () => {
  assert.match(String(cloudSyncBlocker(null, desktop, "uid-1")), /finished loading/i);
});

// ── Which edits survive ────────────────────────────────────────────────────

test("edits made before syncing are carried onto the cloud copy", () => {
  const analysis = { detectedMoments: [{ id: "m1", effectType: "zoom" }] };
  const project = localProject({
    analysis: analysis as ProjectDoc["analysis"],
    selectedPresetId: "preset-7",
    sourceCrop: { x: 0, y: 0, width: 1, height: 0.9 } as ProjectDoc["sourceCrop"],
  });

  const edits = carriedEdits(project);
  assert.deepEqual(edits.analysis, analysis);
  assert.equal(edits.selectedPresetId, "preset-7");
  assert.ok(edits.sourceCrop);
});

test("nothing identifying the OLD project is carried", () => {
  // Copying any of these would point the new document at the local project's
  // identity or at a file the server cannot read.
  const project = localProject({
    analysis: { detectedMoments: [] } as ProjectDoc["analysis"],
    interactionsPath: "local/path.json",
    exportUrl: "framevo://app/__media/old",
  });
  const edits = carriedEdits(project) as Record<string, unknown>;

  for (const key of NEVER_CARRIED) {
    assert.ok(!(key in edits), `${key} must not be carried to the cloud project`);
  }
  assert.ok(!("interactionsPath" in edits));
});

test("absent fields are omitted rather than written as undefined", () => {
  // A patch full of `undefined` would be a no-op at best and, through the
  // field-value layer, ambiguous at worst.
  const edits = carriedEdits(localProject());
  for (const [key, value] of Object.entries(edits)) {
    assert.notEqual(value, undefined, `${key} was carried as undefined`);
  }
});

test("a freshly recorded project carries only its defaults", () => {
  const edits = carriedEdits(localProject());
  // effectsSettings is always present on a materialized document.
  assert.deepEqual(Object.keys(edits), ["effectsSettings"]);
});

test("the two field lists never overlap", () => {
  const carried = new Set<string>(CARRIED_FIELDS);
  for (const key of NEVER_CARRIED) {
    assert.ok(!carried.has(key), `${key} is in both lists`);
  }
});
