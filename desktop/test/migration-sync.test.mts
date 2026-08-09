/**
 * The 0002_sync migration, applied to a database that already has real data in
 * it — which is the only version of this that matters. A migration that works on
 * an empty database and destroys an existing library is not a working migration.
 *
 * This is also the regression test for a specific trap that was hit while
 * writing it: drizzle-kit's generated SQL re-added `cloud_project_id`, `owned`
 * and `project_title`, because `0001_cloud_link.sql` was hand-written and never
 * entered meta/_journal.json. Applied to any existing install that would have
 * failed with "duplicate column name" and rolled the whole thing back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../src/main/db/client.ts";
import { fileResolver, runMigrations } from "../src/main/db/migrate.ts";
import { MIGRATIONS } from "../src/main/db/migrations/index.ts";

const MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), "../../src/main/db/migrations");

/**
 * Everything up to (but not including) the sync migration — a v1 install.
 *
 * Sliced by POSITION, not filtered by name: later migrations build on 0002
 * (0003 alters a table it creates), so removing one name from the middle of the
 * list produces a sequence that never existed and cannot apply.
 */
const PRE_SYNC = MIGRATIONS.slice(0, MIGRATIONS.indexOf("0002_sync.sql"));
/** Everything from the sync migration onwards — what the upgrade must apply. */
const SYNC_ONWARDS = MIGRATIONS.slice(MIGRATIONS.indexOf("0002_sync.sql"));

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "framevo-migrate-test-"));
  const handle = openDatabase(join(dir, "library.db"));
  return {
    handle,
    dir,
    // The handle MUST close before the directory goes: Windows holds an
    // exclusive lock on an open SQLite file, so removing it first fails EPERM.
    cleanup: () => {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Apply an explicit subset, so "the previous version" can be reconstructed. */
function applySubset(raw: Parameters<typeof runMigrations>[0], names: readonly string[]) {
  const resolver = fileResolver(MIGRATIONS_DIR);
  raw.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
  );
  for (const name of names) {
    raw.exec("BEGIN");
    raw.exec(resolver(name));
    raw.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, 1);
    raw.exec("COMMIT");
  }
}

test("a v1 library upgrades to sync with every row intact", () => {
  const { handle, cleanup } = freshDb();
  try {
    applySubset(handle.raw, PRE_SYNC);

    // A realistic v1 row, including the cloud link added by 0001.
    handle.raw
      .prepare(
        `INSERT INTO projects (id, title, doc, created_at, updated_at, session_open, revision, cloud_project_id)
         VALUES (?, ?, ?, ?, ?, 0, 3, ?)`
      )
      .run("p1", "My recording", JSON.stringify({ id: "p1", title: "My recording" }), 100, 200, "cloud-1");

    const result = runMigrations(handle.raw, fileResolver(MIGRATIONS_DIR));
    assert.deepEqual(result.applied, [...SYNC_ONWARDS], "only the new ones run");

    const row = handle.raw.prepare("SELECT * FROM projects WHERE id = ?").get("p1") as Record<
      string,
      unknown
    >;
    assert.equal(row.title, "My recording", "existing data survived");
    assert.equal(row.revision, 3);
    assert.equal(row.cloud_project_id, "cloud-1", "the 0001 column was NOT clobbered");

    // New columns exist and take safe defaults for a row that predates sync.
    assert.equal(row.owner_uid, null, "unclaimed until the user signs in");
    assert.equal(
      row.sync_state,
      "pending",
      "an existing local project is not silently claimed as 'synced'"
    );
    assert.equal(row.base_doc, null, "no common ancestor yet");
    assert.equal(row.base_rev, 0);
  } finally {
    cleanup();
  }
});

test("the migration is idempotent — a second run is a no-op", () => {
  const { handle, cleanup } = freshDb();
  try {
    runMigrations(handle.raw, fileResolver(MIGRATIONS_DIR));
    const second = runMigrations(handle.raw, fileResolver(MIGRATIONS_DIR));
    assert.deepEqual(second.applied, [], "already-applied migrations do not re-run");
  } finally {
    cleanup();
  }
});

test("every sync table exists with its claim index after migrating", () => {
  const { handle, cleanup } = freshDb();
  try {
    runMigrations(handle.raw, fileResolver(MIGRATIONS_DIR));
    const names = (
      handle.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const table of ["sync_outbox", "tombstones", "media_uploads", "export_uploads"]) {
      assert.ok(names.includes(table), `${table} is missing`);
    }

    const indexes = (
      handle.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    // The drain query runs on every tick; without this it is a full scan.
    assert.ok(indexes.includes("outbox_claim_idx"));
    assert.ok(indexes.includes("projects_sync_idx"));
  } finally {
    cleanup();
  }
});

test("the migration list matches the files on disk", () => {
  // A generated .sql that never reaches MIGRATIONS is silently skipped forever —
  // the failure mode the explicit list exists to make impossible.
  const resolver = fileResolver(MIGRATIONS_DIR);
  for (const name of MIGRATIONS) {
    assert.ok(resolver(name).length > 0, `${name} is listed but unreadable`);
  }
});
