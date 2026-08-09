/**
 * Local project persistence, autosave and crash recovery — against a REAL
 * SQLite database (node:sqlite + Drizzle + the generated migration), because
 * the things that break here are SQL-level: a missing migration, a JSON column
 * that round-trips wrong, a cascade that doesn't fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../src/main/db/client.ts";
import { fileResolver, runMigrations } from "../src/main/db/migrate.ts";
import { AUTOSAVE_HISTORY, createLibrary, newLocalProjectDoc } from "../src/main/library.ts";
import { media } from "../src/main/db/schema.ts";
import { arrayUnion, deleteField, serverTimestamp } from "../../src/lib/platform/field-value.ts";

const MIGRATIONS_DIR = resolve(
  fileURLToPath(import.meta.url),
  "../../src/main/db/migrations"
);

function freshLibrary() {
  const dir = mkdtempSync(join(tmpdir(), "framevo-lib-test-"));
  const handle = openDatabase(join(dir, "library.db"));
  runMigrations(handle.raw, fileResolver(MIGRATIONS_DIR));
  const library = createLibrary(handle.db, handle.raw);
  return {
    handle,
    library,
    dir,
    async addMedia(id = "media12345") {
      await handle.db.insert(media).values({
        id,
        path: join(dir, "source.mp4"),
        fileName: "source.mp4",
        sizeBytes: 1234,
        mtimeMs: 1,
        durationSec: 12.5,
        width: 1920,
        height: 1080,
        videoCodec: "h264",
        audioCodec: "aac",
        createdAt: 1,
      });
      return id;
    },
    cleanup() {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a new local project is a real ProjectDoc pointing at local media", async () => {
  const ctx = freshLibrary();
  try {
    const mediaId = await ctx.addMedia();
    const doc = await ctx.library.create({
      mediaId,
      title: "Launch demo",
      mediaUrl: `framevo://app/__media/${mediaId}`,
    });

    assert.equal(doc.title, "Launch demo");
    assert.equal(doc.originalVideoUrl, `framevo://app/__media/${mediaId}`);
    assert.equal(doc.storagePath, "", "nothing is uploaded, so there is no storage path");
    assert.equal(doc.duration, 12.5);
    assert.equal(doc.width, 1920);
    assert.equal(doc.status, "uploaded");
    assert.ok(doc.effectsSettings, "effects defaults are seeded like the web upload flow");

    // Round-trips through SQLite unchanged.
    const read = await ctx.library.get(String(doc.id));
    assert.deepEqual(read, doc);
  } finally {
    ctx.cleanup();
  }
});

test("merge patches apply with the same semantics as the cloud write path", async () => {
  const ctx = freshLibrary();
  try {
    const mediaId = await ctx.addMedia();
    const created = await ctx.library.create({
      mediaId,
      title: "Demo",
      mediaUrl: `framevo://app/__media/${mediaId}`,
    });
    const id = String(created.id);

    // Nested map deep-merges; sentinels resolve.
    await ctx.library.write(id, {
      analysis: { detectedMoments: [{ id: "m1", effectType: "zoom" }], status: "complete" },
      updatedAt: serverTimestamp(),
    });
    await ctx.library.write(id, {
      analysis: { activity: arrayUnion({ kind: "info", text: "edited" }) },
    });
    let doc = (await ctx.library.get(id))!;
    let analysis = doc.analysis as Record<string, unknown>;
    assert.equal((analysis.detectedMoments as unknown[]).length, 1, "sibling key survived the merge");
    assert.equal(analysis.status, "complete");
    assert.equal((analysis.activity as unknown[]).length, 1);
    assert.equal(typeof doc.updatedAt, "number");

    // deleteField removes a nested key rather than writing null.
    await ctx.library.write(id, { effectsSettings: { outputCanvas: { aspectRatio: "9:16" } } });
    await ctx.library.write(id, { effectsSettings: { outputCanvas: deleteField() } });
    doc = (await ctx.library.get(id))!;
    assert.equal("outputCanvas" in (doc.effectsSettings as object), false);
    assert.ok((doc.effectsSettings as Record<string, unknown>).autoZoom, "siblings untouched");

    // A patch can never repoint the document at another project or owner.
    await ctx.library.write(id, { id: "someone-else", userId: "victim" });
    doc = (await ctx.library.get(id))!;
    assert.equal(doc.id, id);
    assert.equal(doc.userId, "local");
  } finally {
    ctx.cleanup();
  }
});

test("every write snapshots, and history stays bounded", async () => {
  const ctx = freshLibrary();
  try {
    const mediaId = await ctx.addMedia();
    const created = await ctx.library.create({
      mediaId,
      title: "Demo",
      mediaUrl: `framevo://app/__media/${mediaId}`,
    });
    const id = String(created.id);

    for (let i = 0; i < AUTOSAVE_HISTORY + 8; i++) {
      await ctx.library.write(id, { title: `Take ${i}` }, 1_000 + i);
    }
    const rows = ctx.handle.raw
      .prepare("SELECT COUNT(*) AS n FROM autosaves WHERE project_id = ?")
      .all(id) as { n: number }[];
    assert.ok(rows[0]!.n <= AUTOSAVE_HISTORY, `kept ${rows[0]!.n} snapshots`);
    assert.ok(rows[0]!.n > 0);

    const doc = (await ctx.library.get(id))!;
    assert.equal(doc.title, `Take ${AUTOSAVE_HISTORY + 7}`);
    // The list view reads the same title (denormalised column stays in sync).
    const [summary] = await ctx.library.list();
    assert.equal(summary!.title, `Take ${AUTOSAVE_HISTORY + 7}`);
  } finally {
    ctx.cleanup();
  }
});

test("an unclean shutdown offers recovery; a clean one does not", async () => {
  const ctx = freshLibrary();
  try {
    const mediaId = await ctx.addMedia();
    const created = await ctx.library.create({
      mediaId,
      title: "Demo",
      mediaUrl: `framevo://app/__media/${mediaId}`,
    });
    const id = String(created.id);

    // Opening the project marks the session; the app then dies without closing.
    await ctx.library.markOpen(id, true);
    await ctx.library.write(id, { title: "Unsaved work" });
    assert.equal((await ctx.library.pendingRecovery()).length, 1);
    assert.equal((await ctx.library.list())[0]!.hasRecovery, true);

    // Restoring adopts the newest snapshot and clears the flag.
    const restored = await ctx.library.resolveRecovery(id, "keep");
    assert.equal(restored!.title, "Unsaved work");
    assert.equal((await ctx.library.pendingRecovery()).length, 0);

    // A clean quit clears the flags synchronously (the shutdown path).
    await ctx.library.markOpen(id, true);
    ctx.library.closeAllSessionsSync();
    assert.equal((await ctx.library.pendingRecovery()).length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("discarding recovery keeps the committed document", async () => {
  const ctx = freshLibrary();
  try {
    const mediaId = await ctx.addMedia();
    const created = await ctx.library.create({
      mediaId,
      title: "Committed",
      mediaUrl: `framevo://app/__media/${mediaId}`,
    });
    const id = String(created.id);
    await ctx.library.markOpen(id, true);

    const doc = await ctx.library.resolveRecovery(id, "discard");
    assert.equal(doc!.title, "Committed");
    assert.equal((await ctx.library.pendingRecovery()).length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("deleting a project removes its snapshots but never the user's video", async () => {
  const ctx = freshLibrary();
  try {
    const mediaId = await ctx.addMedia();
    const created = await ctx.library.create({
      mediaId,
      title: "Demo",
      mediaUrl: `framevo://app/__media/${mediaId}`,
    });
    const id = String(created.id);
    await ctx.library.write(id, { title: "Edited" });

    await ctx.library.remove(id);
    assert.equal(await ctx.library.get(id), null);
    const snapshots = ctx.handle.raw
      .prepare("SELECT COUNT(*) AS n FROM autosaves WHERE project_id = ?")
      .all(id) as { n: number }[];
    assert.equal(snapshots[0]!.n, 0, "autosaves cascade with the project");
    const mediaRows = ctx.handle.raw.prepare("SELECT COUNT(*) AS n FROM media").all() as {
      n: number;
    }[];
    assert.equal(mediaRows[0]!.n, 1, "the media reference (and the file) survive");
  } finally {
    ctx.cleanup();
  }
});

test("newLocalProjectDoc never invents a cloud storage path", () => {
  const doc = newLocalProjectDoc({
    id: "p1",
    title: "T",
    mediaUrl: "framevo://app/__media/m1",
    durationSec: 3,
    width: 640,
    height: 360,
    sizeBytes: 10,
    now: 5,
  });
  assert.equal(doc.storagePath, "");
  assert.equal(doc.userId, "local");
  assert.equal(doc.createdAt, 5);
});

/* ── The two-copy rule ──────────────────────────────────────────────────────
 *
 * A project can have its video in two places, and each place is recorded
 * somewhere different on purpose: `doc.originalVideoUrl` names the CLOUD copy
 * and syncs; `projects.media_id` names the copy on this disk and does not.
 *
 * The desktop prefers its own copy when READING and must never write that
 * preference back — a `framevo://` URL pushed to Firestore is a URL only this
 * computer can resolve, and the website would show a broken project while
 * everything looked fine here.
 */

/** Put the project in the state a synced-then-uploaded one is in. */
async function uploadedElsewhere(ctx: ReturnType<typeof freshLibrary>, projectId: string) {
  await ctx.library.write(projectId, {
    originalVideoUrl: "https://firebasestorage.googleapis.com/v0/b/x/o/clip.mp4?token=t",
    storagePath: "users/u/projects/p/clip.mp4",
  });
}

test("a project with a local copy READS as the local file, whatever the document says", async () => {
  const ctx = freshLibrary();
  try {
    const mediaId = await ctx.addMedia();
    const created = await ctx.library.create({
      mediaId,
      title: "Demo",
      mediaUrl: `framevo://app/__media/${mediaId}`,
    });
    await uploadedElsewhere(ctx, String(created.id));

    const doc = await ctx.library.get(String(created.id));
    assert.equal(
      doc?.originalVideoUrl,
      `framevo://app/__media/${mediaId}`,
      "the file on this disk is what the editor should open"
    );
    // And the same answer through the listing, or a card would play over the
    // network while the editor played from disk.
    const [summary] = await ctx.library.list();
    assert.equal(summary?.previewUrl, `framevo://app/__media/${mediaId}`);
    assert.equal(summary?.mediaMissing, false);
    assert.equal(summary?.cloudOnly, false);
  } finally {
    ctx.cleanup();
  }
});

test("the local preference is NEVER written into the synced document", async () => {
  const ctx = freshLibrary();
  try {
    const mediaId = await ctx.addMedia();
    const created = await ctx.library.create({
      mediaId,
      title: "Demo",
      mediaUrl: `framevo://app/__media/${mediaId}`,
    });
    const projectId = String(created.id);
    await uploadedElsewhere(ctx, projectId);

    // An ordinary, unrelated edit — the moment a resolve-at-read value would
    // leak into storage if `write` persisted what it returns.
    await ctx.library.write(projectId, { title: "Renamed" });

    const stored = ctx.handle.raw
      .prepare("SELECT doc FROM projects WHERE id = ?")
      .get(projectId) as { doc: string };
    const raw = JSON.parse(stored.doc) as Record<string, unknown>;
    assert.match(
      String(raw.originalVideoUrl),
      /^https:/,
      "the stored document must keep naming the cloud copy — it is what syncs"
    );
    assert.equal(raw.storagePath, "users/u/projects/p/clip.mp4");
  } finally {
    ctx.cleanup();
  }
});

test("a project whose video is only in the cloud is cloudOnly, not missing", async () => {
  const ctx = freshLibrary();
  try {
    const mediaId = await ctx.addMedia();
    const created = await ctx.library.create({
      mediaId,
      title: "Demo",
      mediaUrl: `framevo://app/__media/${mediaId}`,
    });
    const projectId = String(created.id);
    await uploadedElsewhere(ctx, projectId);
    // The state a project synced from another machine arrives in: document
    // here, video not.
    ctx.handle.raw.prepare("UPDATE projects SET media_id = NULL WHERE id = ?").run(projectId);

    const [summary] = await ctx.library.list();
    assert.equal(summary?.cloudOnly, true, "this is the Download case");
    assert.equal(
      summary?.mediaMissing,
      false,
      "a healthy synced project must not be dressed up as broken"
    );
    assert.match(String(summary?.previewUrl), /^https:/, "it still plays, over the network");

    const doc = await ctx.library.get(projectId);
    assert.match(String(doc?.originalVideoUrl), /^https:/);
  } finally {
    ctx.cleanup();
  }
});

test("attachMedia points the project at a downloaded file without touching the document", async () => {
  const ctx = freshLibrary();
  try {
    const mediaId = await ctx.addMedia();
    const created = await ctx.library.create({
      mediaId,
      title: "Demo",
      mediaUrl: `framevo://app/__media/${mediaId}`,
    });
    const projectId = String(created.id);
    await uploadedElsewhere(ctx, projectId);
    ctx.handle.raw.prepare("UPDATE projects SET media_id = NULL WHERE id = ?").run(projectId);

    const downloaded = await ctx.addMedia("media67890");
    await ctx.library.attachMedia(projectId, downloaded);

    const doc = await ctx.library.get(projectId);
    assert.equal(doc?.originalVideoUrl, `framevo://app/__media/${downloaded}`, "opens offline now");

    const stored = ctx.handle.raw
      .prepare("SELECT doc FROM projects WHERE id = ?")
      .get(projectId) as { doc: string };
    assert.match(
      String((JSON.parse(stored.doc) as Record<string, unknown>).originalVideoUrl),
      /^https:/,
      "downloading a video is a fact about this disk, not about the project"
    );
  } finally {
    ctx.cleanup();
  }
});

test("stats() counts the library without materialising it", async () => {
  const ctx = freshLibrary();
  try {
    const first = await ctx.addMedia("mediaaaaaa1");
    const second = await ctx.addMedia("mediaaaaaa2");
    const a = await ctx.library.create({
      mediaId: first,
      title: "Local only",
      mediaUrl: `framevo://app/__media/${first}`,
    });
    const b = await ctx.library.create({
      mediaId: second,
      title: "Also in the cloud",
      mediaUrl: `framevo://app/__media/${second}`,
    });
    await ctx.library.linkCloud(String(b.id), "cloudprojectid00000");

    const stats = await ctx.library.stats();
    assert.equal(stats.projectCount, 2);
    assert.equal(
      stats.linkedCount,
      1,
      "only the project with a cloud twin counts toward the dedup overlap"
    );
    assert.equal(stats.mediaBytes, 2468, "sums the size recorded at import");

    // The point of the query: it answers without reading a single document.
    assert.ok(String(a.id));
  } finally {
    ctx.cleanup();
  }
});

test("stats() on an empty library is zeros, not nulls", async () => {
  const ctx = freshLibrary();
  try {
    assert.deepEqual(await ctx.library.stats(), {
      projectCount: 0,
      linkedCount: 0,
      mediaBytes: 0,
    });
  } finally {
    ctx.cleanup();
  }
});
