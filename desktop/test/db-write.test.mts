/**
 * The lazy-query trap.
 *
 * Drizzle statements only execute when something calls `then()`, so a write that
 * is merely `void`-ed is silently dropped. That is not a hypothetical: it is why
 * finished local exports stayed `pending` in the library and the Exports screen
 * showed a spinner beside files that had been on disk for days.
 *
 * These tests assert both halves — that the plain `void` form really does
 * nothing (so the helper is load-bearing, not decoration) and that the helper
 * runs the write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";

import { fireAndForget } from "../src/main/db/write.ts";
import { exports as exportsTable } from "../src/main/db/schema.ts";
import { seedProject, workspace } from "./sync-harness.mts";

const OUTPUT = "out-lazy";

async function seedPendingExport(ws: ReturnType<typeof workspace>) {
  const projectId = await seedProject(ws);
  await ws.handle.db.insert(exportsTable).values({
    id: OUTPUT,
    projectId,
    path: "C:/tmp/framevo/out-lazy.mp4",
    fileName: "out-lazy.mp4",
    sizeBytes: 0,
    encoder: "h264_qsv",
    status: "pending",
    createdAt: Date.now(),
  });
  return projectId;
}

async function statusOf(ws: ReturnType<typeof workspace>) {
  const rows = await ws.handle.db
    .select()
    .from(exportsTable)
    .where(eq(exportsTable.id, OUTPUT));
  return rows[0]?.status;
}

test("a `void`-ed drizzle write never runs — this is the bug, pinned", async () => {
  const ws = workspace();
  try {
    await seedPendingExport(ws);

    // Exactly what the export-completion handler used to do.
    void ws.handle.db
      .update(exportsTable)
      .set({ status: "ready" })
      .where(eq(exportsTable.id, OUTPUT));

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      await statusOf(ws),
      "pending",
      "if this ever reads 'ready', drizzle became eager and the helper can go"
    );
  } finally {
    ws.cleanup();
  }
});

test("fireAndForget actually executes the write", async () => {
  const ws = workspace();
  try {
    await seedPendingExport(ws);

    fireAndForget(
      ws.handle.db
        .update(exportsTable)
        .set({ status: "ready", sizeBytes: 4096 })
        .where(eq(exportsTable.id, OUTPUT)),
      "mark export ready",
      () => assert.fail("the write should not have failed")
    );

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await statusOf(ws), "ready");
  } finally {
    ws.cleanup();
  }
});

test("a failing write is reported, not thrown at the process", async () => {
  const reported: string[] = [];
  const rejected = {
    then: (_ok: unknown, bad: (reason: unknown) => unknown) =>
      Promise.resolve().then(() => bad(new Error("disk is gone"))),
  } as PromiseLike<unknown>;

  fireAndForget(rejected, "mark export ready", (message, meta) =>
    reported.push(`${message}:${String(meta.what)}:${String(meta.message)}`)
  );

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(reported, ["database write failed:mark export ready:disk is gone"]);
});

/**
 * The other half of the same failure: rows that were ALREADY stranded.
 *
 * Fixing the write only helps future exports — a library that already contains
 * `pending` rows for files finished days ago would keep spinning until the user
 * deleted them. Launch is the moment that can be settled, because a render
 * cannot outlive the process that started it.
 */
test("a launch settles rows left mid-render by a previous run", async () => {
  const { createExportsStore, resolveStaleStatus } = await import(
    "../src/main/exports-store.ts"
  );

  // The rule itself, stated once and asserted directly.
  assert.equal(resolveStaleStatus("pending", true), "ready");
  assert.equal(resolveStaleStatus("rendering", true), "ready");
  assert.equal(resolveStaleStatus("pending", false), "failed");
  assert.equal(resolveStaleStatus("ready", true), null, "a settled row is left alone");
  assert.equal(resolveStaleStatus("canceled", false), null);

  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    // This file exists on disk — the test's own source, so the check is real.
    const realFile = fileURLToPath(import.meta.url);
    await ws.handle.db.insert(exportsTable).values({
      id: "out-stranded",
      projectId,
      path: realFile,
      fileName: "out-stranded.mp4",
      sizeBytes: 0,
      encoder: "h264_qsv",
      status: "pending",
      createdAt: Date.now(),
    });

    const store = createExportsStore(ws.handle.db);
    assert.deepEqual(await store.reconcileOnLaunch(), { repaired: 1 });

    const [row] = await ws.handle.db
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, "out-stranded"));
    assert.equal(row.status, "ready");
    assert.ok(row.sizeBytes > 0, "the byte count comes from the file, not the stale row");

    // Idempotent: a second launch must not churn rows it already settled.
    assert.deepEqual(await store.reconcileOnLaunch(), { repaired: 0 });
  } finally {
    ws.cleanup();
  }
});
