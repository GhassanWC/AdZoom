/**
 * Media upload: checksums, the state machine, and the cleanup guard.
 *
 * The property everything here defends is narrow and absolute: a project is
 * repointed at the cloud copy of its video ONLY after that copy has been
 * verified, and "free up space" never removes the only copy of anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestFile, uploadMatches } from "../src/main/checksum.ts";
import {
  createMediaUploadsStore,
  mediaStoragePath,
} from "../src/main/media-uploads.ts";
import { createStorageService } from "../src/main/storage-usage.ts";
import { eq } from "drizzle-orm";
import { media } from "../src/main/db/schema.ts";
import { UID_A, projectRow, seedProject, workspace } from "./sync-harness.mts";

// ── checksums ──────────────────────────────────────────────────────────────

function tempFile(contents: string) {
  const dir = mkdtempSync(join(tmpdir(), "framevo-digest-"));
  const path = join(dir, "clip.mp4");
  writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a file is hashed without being loaded, and reports both digests", async () => {
  const file = tempFile("hello framevo");
  try {
    const digest = await digestFile(file.path);
    assert.equal(digest.sha256.length, 64, "sha256 is hex");
    assert.ok(/^[0-9a-f]+$/.test(digest.sha256));
    assert.ok(/^[A-Za-z0-9+/]+=*$/.test(digest.md5Base64), "md5 is base64, as Storage reports it");
    assert.equal(digest.sizeBytes, 13);
  } finally {
    file.cleanup();
  }
});

test("the same bytes always hash the same, different bytes never do", async () => {
  const a = tempFile("identical");
  const b = tempFile("identical");
  const c = tempFile("different");
  try {
    const [da, db, dc] = await Promise.all([
      digestFile(a.path),
      digestFile(b.path),
      digestFile(c.path),
    ]);
    assert.equal(da.sha256, db!.sha256);
    assert.equal(da.md5Base64, db!.md5Base64);
    assert.notEqual(da.sha256, dc!.sha256);
  } finally {
    a.cleanup();
    b.cleanup();
    c.cleanup();
  }
});

test("hashing a missing file reports the name, never the path", async () => {
  await assert.rejects(
    () => digestFile(join(tmpdir(), "framevo-does-not-exist", "secret-folder", "clip.mp4")),
    (err: Error) => {
      assert.ok(err.message.includes("clip.mp4"));
      assert.ok(!err.message.includes("secret-folder"), "a path must not reach a log line");
      return true;
    }
  );
});

test("verification accepts a matching upload", () => {
  const expected = { sha256: "x", md5Base64: "abc==", sizeBytes: 100 };
  assert.deepEqual(
    uploadMatches({ expected, remoteMd5Base64: "abc==", remoteSizeBytes: 100 }),
    { ok: true }
  );
});

test("verification rejects a truncated upload", () => {
  const expected = { sha256: "x", md5Base64: "abc==", sizeBytes: 100 };
  const result = uploadMatches({ expected, remoteMd5Base64: "abc==", remoteSizeBytes: 60 });
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.includes("60"));
});

test("verification rejects a corrupted upload", () => {
  const expected = { sha256: "x", md5Base64: "abc==", sizeBytes: 100 };
  const result = uploadMatches({ expected, remoteMd5Base64: "zzz==", remoteSizeBytes: 100 });
  assert.equal(result.ok, false);
});

test("verification refuses to claim success when nothing can be checked", () => {
  const expected = { sha256: "x", md5Base64: "abc==", sizeBytes: 100 };
  const result = uploadMatches({ expected, remoteMd5Base64: null, remoteSizeBytes: null });
  assert.equal(result.ok, false, "unverifiable is not the same as verified");
});

// ── storage path ───────────────────────────────────────────────────────────

test("the storage path lands under the owner prefix the rules enforce", () => {
  const path = mediaStoragePath("uid-123", "proj-9", "My Recording.mp4");
  assert.ok(path.startsWith("users/uid-123/projects/proj-9/"));
  assert.ok(!path.includes(" "), "unsafe characters are replaced");
});

test("a hostile file name cannot escape the prefix", () => {
  const path = mediaStoragePath("uid-123", "proj-9", "../../../etc/passwd");
  assert.ok(path.startsWith("users/uid-123/projects/proj-9/"));
  assert.ok(!path.includes(".."), "traversal is neutralised");
});

// ── the state machine ──────────────────────────────────────────────────────

const fakeDigest = async () => ({ sha256: "a".repeat(64), md5Base64: "abc==", sizeBytes: 1234 });

async function withUploads(fn: (ctx: {
  ws: ReturnType<typeof workspace>;
  store: ReturnType<typeof createMediaUploadsStore>;
  projectId: string;
  mediaId: string;
}) => Promise<void>) {
  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    const row = projectRow(ws, projectId);
    const store = createMediaUploadsStore(ws.handle.db, {
      // Production repoints through the library so the document change and its
      // sync operation land in ONE transaction. Tests use the same path.
      repoint: async (id, patch) => {
        await ws.library.write(id, patch);
      },
    });
    await fn({ ws, store, projectId, mediaId: String(row.media_id) });
  } finally {
    ws.cleanup();
  }
}

test("media starts local and is only queued when asked", async () => {
  await withUploads(async ({ store, projectId, mediaId }) => {
    assert.equal(await store.stateOf(mediaId), null, "nothing is queued by default");

    const result = await store.request({
      projectId,
      ownerUid: UID_A,
      now: 100,
      digest: fakeDigest,
    });
    assert.equal(result.queued, true);
    assert.equal(await store.stateOf(mediaId), "pending");
  });
});

test("asking twice does not queue twice", async () => {
  await withUploads(async ({ store, projectId, mediaId }) => {
    await store.request({ projectId, ownerUid: UID_A, now: 100, digest: fakeDigest });
    const second = await store.request({
      projectId,
      ownerUid: UID_A,
      now: 101,
      digest: fakeDigest,
    });
    assert.equal(second.queued, false);
    assert.equal((await store.claim(UID_A, 200, 10)).length, 1);
    void mediaId;
  });
});

test("the checksum is taken BEFORE anything is sent", async () => {
  await withUploads(async ({ ws, store, projectId }) => {
    let hashedAt = 0;
    let order = 0;
    await store.request({
      projectId,
      ownerUid: UID_A,
      now: 100,
      digest: async () => {
        hashedAt = ++order;
        return fakeDigest();
      },
    });
    const claimedAt = ++order;
    await store.claim(UID_A, 200);
    assert.ok(hashedAt < claimedAt, "hashing a file after uploading it proves nothing");

    const row = ws.handle.raw
      .prepare("SELECT * FROM media_uploads LIMIT 1")
      .get() as Record<string, unknown>;
    assert.equal(row.checksum_sha256, "a".repeat(64));
    assert.equal(row.checksum_md5, "abc==");
  });
});

test("a claimed upload is not handed out twice", async () => {
  await withUploads(async ({ store, projectId }) => {
    await store.request({ projectId, ownerUid: UID_A, now: 100, digest: fakeDigest });
    assert.equal((await store.claim(UID_A, 200)).length, 1);
    assert.equal((await store.claim(UID_A, 200)).length, 0);
  });
});

test("the project is repointed at the cloud ONLY on a verified completion", async () => {
  await withUploads(async ({ ws, store, projectId, mediaId }) => {
    const before = JSON.parse(String(projectRow(ws, projectId).doc)) as Record<string, unknown>;
    assert.ok(String(before.originalVideoUrl).startsWith("framevo://"));

    await store.request({ projectId, ownerUid: UID_A, now: 100, digest: fakeDigest });
    await store.claim(UID_A, 200);

    // Mid-flight: still pointing at the local file.
    await store.progress(mediaId, 600, 250);
    const during = JSON.parse(String(projectRow(ws, projectId).doc)) as Record<string, unknown>;
    assert.ok(
      String(during.originalVideoUrl).startsWith("framevo://"),
      "a half-uploaded object must never become the project source"
    );

    await store.complete({
      mediaId,
      downloadUrl: "https://storage.example/signed",
      now: 300,
    });
    const after = JSON.parse(String(projectRow(ws, projectId).doc)) as Record<string, unknown>;
    assert.equal(after.originalVideoUrl, "https://storage.example/signed");
    assert.ok(String(after.storagePath).startsWith(`users/${UID_A}/projects/${projectId}/`));
    assert.equal(await store.stateOf(mediaId), "uploaded");
  });
});

test("a failed upload keeps the reason, resets progress and leaves the source alone", async () => {
  await withUploads(async ({ ws, store, projectId, mediaId }) => {
    await store.request({ projectId, ownerUid: UID_A, now: 100, digest: fakeDigest });
    await store.claim(UID_A, 200);
    await store.progress(mediaId, 900, 250);

    await store.fail(mediaId, { message: "connection reset", code: "unavailable" }, 300);

    const row = ws.handle.raw
      .prepare("SELECT * FROM media_uploads WHERE media_id = ?")
      .get(mediaId) as Record<string, unknown>;
    assert.equal(row.state, "pending", "a retryable failure goes back in the queue");
    assert.equal(row.last_error, "connection reset");
    assert.equal(row.bytes_sent, 0, "stale progress would be a lie about a dead session");

    const doc = JSON.parse(String(projectRow(ws, projectId).doc)) as Record<string, unknown>;
    assert.ok(String(doc.originalVideoUrl).startsWith("framevo://"), "the local file still serves");
  });
});

test("a permanent failure parks the upload without discarding it", async () => {
  await withUploads(async ({ store, projectId, mediaId }) => {
    await store.request({ projectId, ownerUid: UID_A, now: 100, digest: fakeDigest });
    await store.claim(UID_A, 200);
    await store.fail(
      mediaId,
      { message: "Missing or insufficient permissions", code: "permission-denied" },
      300
    );
    assert.equal(await store.stateOf(mediaId), "failed");
    assert.equal((await store.claim(UID_A, 10_000_000)).length, 0, "parked, not spinning");

    await store.retry(mediaId, 400);
    assert.equal((await store.claim(UID_A, 400)).length, 1, "and retryable on demand");
  });
});

// ── the cleanup guard ──────────────────────────────────────────────────────

test("nothing is reclaimable until a verified copy exists in the cloud", async () => {
  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    const mediaId = String(projectRow(ws, projectId).media_id);
    // Framevo-owned (a recording), and the file exists — the two other
    // conditions for deletion.
    await ws.handle.db.update(media).set({ owned: true }).where(eq(media.id, mediaId));
    writeFileSync(
      String(
        (ws.handle.raw.prepare("SELECT path FROM media WHERE id = ?").get(mediaId) as {
          path: string;
        }).path
      ),
      "video bytes"
    );

    const storage = createStorageService({
      db: ws.handle.db,
      raw: ws.handle.raw,
      libraryDir: tmpdir(),
      databasePath: join(tmpdir(), "nope.db"),
    });

    assert.deepEqual(
      await storage.reclaimableMedia(),
      [],
      "the only copy of the user's video is never reclaimable"
    );

    // A queued-but-unfinished upload is still not good enough.
    const uploads = createMediaUploadsStore(ws.handle.db, {
      // Production repoints through the library so the document change and its
      // sync operation land in ONE transaction. Tests use the same path.
      repoint: async (id, patch) => {
        await ws.library.write(id, patch);
      },
    });
    await uploads.request({ projectId, ownerUid: UID_A, now: 100, digest: fakeDigest });
    assert.deepEqual(await storage.reclaimableMedia(), [], "pending is not uploaded");

    await uploads.claim(UID_A, 200);
    await uploads.complete({ mediaId, downloadUrl: "https://x/y", now: 300 });
    const reclaimable = await storage.reclaimableMedia();
    assert.equal(reclaimable.length, 1, "verified in the cloud ⇒ safe to free");
    assert.equal(reclaimable[0]!.mediaId, mediaId);
  } finally {
    ws.cleanup();
  }
});

test("a file the user merely pointed us at is never reclaimable, even when uploaded", async () => {
  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    const mediaId = String(projectRow(ws, projectId).media_id);
    writeFileSync(
      String(
        (ws.handle.raw.prepare("SELECT path FROM media WHERE id = ?").get(mediaId) as {
          path: string;
        }).path
      ),
      "video bytes"
    );
    const uploads = createMediaUploadsStore(ws.handle.db, {
      // Production repoints through the library so the document change and its
      // sync operation land in ONE transaction. Tests use the same path.
      repoint: async (id, patch) => {
        await ws.library.write(id, patch);
      },
    });
    await uploads.request({ projectId, ownerUid: UID_A, now: 100, digest: fakeDigest });
    await uploads.claim(UID_A, 200);
    await uploads.complete({ mediaId, downloadUrl: "https://x/y", now: 300 });

    const storage = createStorageService({
      db: ws.handle.db,
      raw: ws.handle.raw,
      libraryDir: tmpdir(),
      databasePath: join(tmpdir(), "nope.db"),
    });
    assert.deepEqual(
      await storage.reclaimableMedia(),
      [],
      "Framevo does not own it, so Framevo does not delete it"
    );
  } finally {
    ws.cleanup();
  }
});
