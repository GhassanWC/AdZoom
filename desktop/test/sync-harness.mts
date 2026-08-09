/**
 * A real SQLite library that can be closed and RE-OPENED, so a test can model
 * the app being quit and relaunched.
 *
 * Shared by the outbox tests and the reconcile tests. Not named `*.test.mts`, so
 * the runner does not try to execute it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../src/main/db/client.ts";
import { fileResolver, runMigrations } from "../src/main/db/migrate.ts";
import { createLibrary, type SyncHook } from "../src/main/library.ts";
import { createSyncStore } from "../src/main/sync-store.ts";
import { media } from "../src/main/db/schema.ts";

const MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), "../../src/main/db/migrations");

export const UID_A = "uid-alice";
export const UID_B = "uid-bob";

export function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "framevo-sync-test-"));
  const file = join(dir, "library.db");
  let opId = 0;
  let uid: string | null = UID_A;

  const open = () => {
    const handle = openDatabase(file);
    runMigrations(handle.raw, fileResolver(MIGRATIONS_DIR));
    const hook: SyncHook = {
      ownerUid: () => uid,
      deviceId: () => "dev_test",
      newOpId: () => `op_${++opId}`,
      enqueue: () => {},
    };
    return {
      handle,
      library: createLibrary(handle.db, handle.raw, hook),
      store: createSyncStore(handle.db),
    };
  };

  let current = open();
  return {
    get library() {
      return current.library;
    },
    get store() {
      return current.store;
    },
    get handle() {
      return current.handle;
    },
    signInAs(next: string | null) {
      uid = next;
    },
    /** Close and re-open — the app being quit and relaunched. */
    restart() {
      current.handle.close();
      current = open();
    },
    async addMedia(id = "media12345") {
      await current.handle.db.insert(media).values({
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
        owned: false,
      });
      return id;
    },
    cleanup() {
      // The handle MUST close before the directory goes: Windows holds an
      // exclusive lock on an open SQLite file (EPERM otherwise).
      current.handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Workspace = ReturnType<typeof workspace>;

export async function seedProject(ws: Workspace, id = "p1") {
  const mediaId = await ws.addMedia();
  await ws.library.create({
    mediaId,
    title: "Demo",
    id,
    mediaUrl: "framevo://app/__media/x",
    now: 1,
  });
  return id;
}

export function projectRow(ws: Workspace, id: string) {
  return ws.handle.raw.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

/** A remote snapshot, shaped as the Firestore adapter delivers it. */
export function remoteDoc(
  projectId: string,
  doc: Record<string, unknown> | null,
  rev: number
) {
  return { projectId, doc, rev, updatedAt: 500 };
}
