/**
 * Export upload: the queue that must never re-render and never double-spend a
 * permit.
 *
 * Both failures are expensive in a way the user feels directly — one costs
 * minutes of their CPU, the other costs one of their monthly exports — so each
 * is asserted rather than assumed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createExportUploadsStore } from "../src/main/export-uploads.ts";
import { exports as exportsTable } from "../src/main/db/schema.ts";
import { UID_A, seedProject, workspace } from "./sync-harness.mts";

const OUTPUT = "out-123";

async function withExport(
  fn: (ctx: {
    ws: ReturnType<typeof workspace>;
    store: ReturnType<typeof createExportUploadsStore>;
    projectId: string;
  }) => Promise<void>
) {
  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    // A finished local render — the file exists; only the cloud record is owed.
    await ws.handle.db.insert(exportsTable).values({
      id: OUTPUT,
      projectId,
      projectTitle: "Demo",
      path: "C:/exports/demo.mp4",
      fileName: "demo.mp4",
      sizeBytes: 5_000_000,
      encoder: "h264_nvenc",
      status: "ready",
      createdAt: 1,
    });
    await fn({ ws, store: createExportUploadsStore(ws.handle.db), projectId });
  } finally {
    ws.cleanup();
  }
}

const uploadRow = (ws: ReturnType<typeof workspace>) =>
  ws.handle.raw.prepare("SELECT * FROM export_uploads WHERE output_id = ?").get(OUTPUT) as Record<
    string,
    unknown
  >;

// ── queueing ───────────────────────────────────────────────────────────────

test("a finished render is queued for upload", async () => {
  await withExport(async ({ store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    assert.equal(await store.stateOf(OUTPUT), "pending");

    const jobs = await store.claim(UID_A, 200);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.outputId, OUTPUT);
    assert.equal(jobs[0]!.exportDocId, null, "no permit has been issued yet");
  });
});

test("queueing twice does not create two uploads", async () => {
  await withExport(async ({ ws, store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 101 });
    const count = ws.handle.raw
      .prepare("SELECT count(*) AS n FROM export_uploads")
      .get() as { n: number };
    assert.equal(count.n, 1);
  });
});

test("a completed upload is not re-queued by a stray request", async () => {
  await withExport(async ({ store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    await store.claim(UID_A, 200);
    await store.recordPermit({
      outputId: OUTPUT,
      exportDocId: "exp-1",
      storagePath: "users/u/projects/p/exports/exp-1.mp4",
      now: 300,
    });
    await store.complete(OUTPUT, 400);

    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 500 });
    assert.equal(await store.stateOf(OUTPUT), "done", "already in the cloud; nothing to do");
  });
});

// ── the permit must not be spent twice ─────────────────────────────────────

test("a failed upload KEEPS its permit so a retry does not buy another", async () => {
  await withExport(async ({ ws, store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    await store.claim(UID_A, 200);
    await store.recordPermit({
      outputId: OUTPUT,
      exportDocId: "exp-1",
      storagePath: "users/u/projects/p/exports/exp-1.mp4",
      now: 300,
    });

    await store.fail(OUTPUT, { message: "connection reset", code: "unavailable" }, 400);

    const row = uploadRow(ws);
    assert.equal(row.state, "pending", "retryable, so back in the queue");
    assert.equal(
      row.export_doc_id,
      "exp-1",
      "the permit this export already paid for must survive the failure"
    );
    assert.equal(row.storage_path, "users/u/projects/p/exports/exp-1.mp4");
    assert.equal(row.last_error, "connection reset");

    // And the next claim hands the SAME permit back, so the worker skips
    // straight to uploading instead of asking the server for another.
    //
    // Claimed well past any backoff on purpose: `decideRetry` applies real
    // jitter, so `nextAttemptAt` lands anywhere in a one-second window. Picking
    // a time inside that window made this test pass or fail on a coin flip —
    // and what it is actually about is the PERMIT surviving, not the schedule.
    // The schedule has its own deterministic tests in tests/sync-idempotency.
    const [job] = await store.claim(UID_A, 10_000);
    assert.equal(job!.exportDocId, "exp-1");
  });
});

test("the permit is recorded before any bytes move", async () => {
  await withExport(async ({ ws, store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    await store.claim(UID_A, 200);
    assert.equal(
      uploadRow(ws).state,
      "permitting",
      "a claim means 'about to spend a permit', and says so"
    );

    await store.recordPermit({
      outputId: OUTPUT,
      exportDocId: "exp-1",
      storagePath: "p",
      now: 300,
    });
    assert.equal(
      uploadRow(ws).state,
      "uploading",
      "a crash after this point finds the permit already on disk"
    );
  });
});

// ── the render is never repeated ───────────────────────────────────────────

test("a failed upload leaves the rendered file's record untouched", async () => {
  await withExport(async ({ ws, store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    await store.claim(UID_A, 200);
    await store.fail(OUTPUT, { message: "network down", code: "unavailable" }, 300);

    const local = ws.handle.raw
      .prepare("SELECT * FROM exports WHERE id = ?")
      .get(OUTPUT) as Record<string, unknown>;
    assert.equal(local.status, "ready", "the file on disk is still finished and playable");
    assert.equal(local.path, "C:/exports/demo.mp4", "nothing about the render was disturbed");
  });
});

test("a permanent failure parks the upload without discarding the render", async () => {
  await withExport(async ({ ws, store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    await store.claim(UID_A, 200);
    await store.fail(
      OUTPUT,
      { message: "Missing or insufficient permissions", code: "permission-denied" },
      300
    );

    assert.equal(await store.stateOf(OUTPUT), "failed");
    assert.equal((await store.claim(UID_A, 10_000_000)).length, 0, "parked, not spinning");
    assert.equal(uploadRow(ws).last_error, "Missing or insufficient permissions");

    const local = ws.handle.raw
      .prepare("SELECT status FROM exports WHERE id = ?")
      .get(OUTPUT) as { status: string };
    assert.equal(local.status, "ready", "the user still has their video");
  });
});

test("retry re-arms without touching the permit", async () => {
  await withExport(async ({ store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    await store.claim(UID_A, 200);
    await store.recordPermit({ outputId: OUTPUT, exportDocId: "exp-1", storagePath: "p", now: 250 });
    await store.fail(OUTPUT, { message: "nope", code: "permission-denied" }, 300);

    await store.retry(OUTPUT, 400);
    const [job] = await store.claim(UID_A, 400);
    assert.equal(job!.exportDocId, "exp-1", "the same permit is reused after an explicit retry");
    assert.equal(job!.attempts, 0, "with a fresh ladder");
  });
});

// ── completion ─────────────────────────────────────────────────────────────

test("completion marks the cloud record done and leaves the local file local", async () => {
  await withExport(async ({ ws, store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    await store.claim(UID_A, 200);
    await store.recordPermit({ outputId: OUTPUT, exportDocId: "exp-1", storagePath: "p", now: 250 });
    await store.advance(OUTPUT, "patching", 300);
    await store.complete(OUTPUT, 400);

    assert.equal(await store.stateOf(OUTPUT), "done");
    const local = ws.handle.raw
      .prepare("SELECT * FROM exports WHERE id = ?")
      .get(OUTPUT) as Record<string, unknown>;
    assert.equal(
      local.path,
      "C:/exports/demo.mp4",
      "uploading is an addition, not a migration — Reveal in folder still works"
    );
  });
});

test("outstanding uploads are listable for the Exports screen", async () => {
  await withExport(async ({ store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    assert.equal((await store.pending(UID_A)).length, 1);

    await store.claim(UID_A, 200);
    await store.recordPermit({ outputId: OUTPUT, exportDocId: "exp-1", storagePath: "p", now: 250 });
    await store.complete(OUTPUT, 300);
    assert.deepEqual(await store.pending(UID_A), [], "done is not outstanding");
  });
});

// ── account isolation ──────────────────────────────────────────────────────

test("one account never claims another account's export upload", async () => {
  await withExport(async ({ store, projectId }) => {
    await store.enqueue({ outputId: OUTPUT, projectId, ownerUid: UID_A, now: 100 });
    assert.equal((await store.claim("uid-bob", 200)).length, 0);
    assert.equal((await store.claim(UID_A, 200)).length, 1);
  });
});
