/**
 * Loading previous work from the cloud: the download queue, the streaming
 * runner, and the two-copy read rule that keeps the two halves from fighting.
 *
 * Three properties are defended here, and they are the ones that would ruin a
 * user's day if they broke:
 *
 *  1. A project is attached to a downloaded video ONLY after the whole file has
 *     arrived and probed. A truncated download must never become a source.
 *  2. Downloading NEVER changes the synced document. If it did, the local
 *     `framevo://` URL would be pushed to every other device and the web app
 *     would show a project whose video does not exist.
 *  3. Cancelling is not failing. It costs no attempt, keeps the partial file,
 *     and does not immediately restart itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import {
  createMediaDownloadsStore,
  downloadFileName,
  isDownloadableUrl,
} from "../src/main/media-downloads.ts";
import { createDownloadRunner } from "../src/main/download-runner.ts";
import { media, projects } from "../src/main/db/schema.ts";
import { UID_A, projectRow, seedProject, workspace } from "./sync-harness.mts";

/**
 * A stand-in for `mediaStore.adopt` that inserts a real media row.
 *
 * Not a shortcut — `projects.media_id` is a FOREIGN KEY and `PRAGMA
 * foreign_keys` is ON, so attaching a project to a media id that does not
 * exist fails. Production gets this for free (adopt probes and inserts before
 * the attach); a fake that skipped it would only prove the attach is
 * unreachable, which is how this test caught itself.
 */
function fakeAdopt(ws: ReturnType<typeof workspace>, seen: string[]) {
  return async (path: string) => {
    seen.push(path);
    const row = {
      id: "dlmedia01",
      path,
      fileName: "downloaded.mp4",
      sizeBytes: statSync(path).size,
      mtimeMs: 1,
      durationSec: 10,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac",
      createdAt: 1,
      owned: true,
    };
    await ws.handle.db.insert(media).values(row);
    return row as never;
  };
}

const CLOUD_URL = "https://firebasestorage.googleapis.com/v0/b/x/o/clip.mp4?alt=media&token=t";

/** Detach the project from its local media — the state a synced project arrives in. */
async function makeCloudOnly(ws: ReturnType<typeof workspace>, projectId: string) {
  const doc = JSON.parse(String(projectRow(ws, projectId).doc)) as Record<string, unknown>;
  await ws.handle.db
    .update(projects)
    .set({ mediaId: null, doc: { ...doc, originalVideoUrl: CLOUD_URL } })
    .where(eq(projects.id, projectId));
}

// ── URL handling ───────────────────────────────────────────────────────────

test("only https URLs are downloadable", () => {
  assert.equal(isDownloadableUrl(CLOUD_URL), true);
  assert.equal(isDownloadableUrl("http://insecure/clip.mp4"), false);
  assert.equal(isDownloadableUrl("file:///etc/passwd"), false);
  assert.equal(isDownloadableUrl("framevo://app/__media/abc123"), false);
  assert.equal(isDownloadableUrl(null), false);
});

test("the download is named after the project, not the storage path", () => {
  assert.equal(downloadFileName("Q3 launch demo", CLOUD_URL), "Q3 launch demo.mp4");
  // Separators and leading dots cannot survive into a file name.
  assert.equal(downloadFileName("../../etc/passwd", CLOUD_URL).includes("/"), false);
  assert.equal(downloadFileName("../../etc/passwd", CLOUD_URL).startsWith("."), false);
  assert.equal(downloadFileName("", CLOUD_URL), "Project.mp4");
  // The extension follows the object, when it is one we accept.
  assert.equal(downloadFileName("Take 1", "https://h/o/a.mov?alt=media"), "Take 1.mov");
  assert.equal(downloadFileName("Take 1", "https://h/o/a.exe?alt=media"), "Take 1.mp4");
});

// ── the queue ──────────────────────────────────────────────────────────────

test("a project whose video is already here has nothing to download", async () => {
  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    const store = createMediaDownloadsStore(ws.handle.db);
    const result = await store.request({ projectId, ownerUid: UID_A, now: 100 });
    assert.equal(result.queued, false);
    assert.match(String(result.reason), /already on this computer/i);
  } finally {
    ws.cleanup();
  }
});

test("a project whose video was never uploaded says so instead of failing", async () => {
  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    // No local media AND no cloud URL: the state of a project synced from a
    // machine that never uploaded its recording.
    await ws.handle.db
      .update(projects)
      .set({ mediaId: null, doc: { originalVideoUrl: "framevo://app/__media/gone12" } })
      .where(eq(projects.id, projectId));

    const store = createMediaDownloadsStore(ws.handle.db);
    const result = await store.request({ projectId, ownerUid: UID_A, now: 100 });
    assert.equal(result.queued, false);
    assert.match(String(result.reason), /hasn't been uploaded/i);
    assert.equal(await store.stateFor(projectId), null, "and nothing is queued");
  } finally {
    ws.cleanup();
  }
});

test("asking twice while it runs does not queue twice", async () => {
  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    await makeCloudOnly(ws, projectId);
    const store = createMediaDownloadsStore(ws.handle.db);

    assert.equal((await store.request({ projectId, ownerUid: UID_A, now: 100 })).queued, true);
    await store.claim(UID_A, 200);
    const second = await store.request({ projectId, ownerUid: UID_A, now: 201 });
    assert.equal(second.queued, false);
    assert.match(String(second.reason), /in progress/i);
  } finally {
    ws.cleanup();
  }
});

test("the URL is read from the document at claim time, never from the caller", async () => {
  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    await makeCloudOnly(ws, projectId);
    const store = createMediaDownloadsStore(ws.handle.db);
    await store.request({ projectId, ownerUid: UID_A, now: 100 });

    // The project is re-uploaded elsewhere between queueing and claiming.
    const doc = JSON.parse(String(projectRow(ws, projectId).doc)) as Record<string, unknown>;
    const moved = `${CLOUD_URL}&v=2`;
    await ws.handle.db
      .update(projects)
      .set({ doc: { ...doc, originalVideoUrl: moved } })
      .where(eq(projects.id, projectId));

    const [job] = await store.claim(UID_A, 200);
    assert.equal(job?.sourceUrl, moved, "a stale URL would 404 for no reason a user could act on");
  } finally {
    ws.cleanup();
  }
});

test("a project that lost its cloud video is failed at claim, not left inflight", async () => {
  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    await makeCloudOnly(ws, projectId);
    const store = createMediaDownloadsStore(ws.handle.db);
    await store.request({ projectId, ownerUid: UID_A, now: 100 });

    const doc = JSON.parse(String(projectRow(ws, projectId).doc)) as Record<string, unknown>;
    await ws.handle.db
      .update(projects)
      .set({ doc: { ...doc, originalVideoUrl: "" } })
      .where(eq(projects.id, projectId));

    assert.deepEqual(await store.claim(UID_A, 200), []);
    const state = await store.stateFor(projectId);
    assert.equal(state?.state, "pending", "retryable, with a reason");
    assert.match(String(state?.lastError), /no longer has a video/i);
  } finally {
    ws.cleanup();
  }
});

test("pausing costs no attempt; failing does", async () => {
  const ws = workspace();
  try {
    const projectId = await seedProject(ws);
    await makeCloudOnly(ws, projectId);
    const store = createMediaDownloadsStore(ws.handle.db);
    await store.request({ projectId, ownerUid: UID_A, now: 100 });
    await store.claim(UID_A, 200);

    await store.pause(projectId, 300);
    let row = ws.handle.raw
      .prepare("SELECT * FROM media_downloads WHERE project_id = ?")
      .get(projectId) as Record<string, unknown>;
    assert.equal(row.state, "pending");
    assert.equal(row.attempts, 0, "a user who paused eight times has not broken anything");
    assert.equal(row.last_error, null);

    await store.fail(projectId, { message: "connection reset" }, 400);
    row = ws.handle.raw
      .prepare("SELECT * FROM media_downloads WHERE project_id = ?")
      .get(projectId) as Record<string, unknown>;
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, "connection reset");
  } finally {
    ws.cleanup();
  }
});

// ── the runner ─────────────────────────────────────────────────────────────

/** A fetch that serves `body`, honouring Range so resume can be exercised. */
function serveBytes(body: Buffer, options: { ignoreRange?: boolean } = {}) {
  const calls: (string | undefined)[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    calls.push(range);
    const from = !options.ignoreRange && range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    const slice = body.subarray(from);
    return new Response(new Blob([slice]).stream(), {
      status: from > 0 && !options.ignoreRange ? 206 : 200,
      headers: { "content-length": String(slice.byteLength) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function withRunner(
  fn: (ctx: {
    ws: ReturnType<typeof workspace>;
    projectId: string;
    dir: string;
    store: ReturnType<typeof createMediaDownloadsStore>;
    adopted: string[];
  }) => Promise<void>,
  fetchImpl: typeof fetch,
  mediaStoreOverrides: Partial<{ adopt: (path: string) => Promise<unknown> }> = {}
) {
  const ws = workspace();
  const dir = mkdtempSync(join(tmpdir(), "framevo-dl-"));
  try {
    const projectId = await seedProject(ws);
    await makeCloudOnly(ws, projectId);
    const store = createMediaDownloadsStore(ws.handle.db);
    const adopted: string[] = [];
    const runner = createDownloadRunner({
      store,
      mediaStore: {
        adopt: mediaStoreOverrides.adopt ?? fakeAdopt(ws, adopted),
      } as never,
      downloadsDir: dir,
      fetchImpl,
      now: () => Date.now(),
    });
    await store.request({ projectId, ownerUid: UID_A, now: 100 });
    await runner.drain(UID_A);
    await fn({ ws, projectId, dir, store, adopted });
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a finished download is probed, attached, and leaves the DOCUMENT alone", async () => {
  const body = Buffer.from("a complete little video");
  await withRunner(
    async ({ ws, projectId, adopted, store }) => {
      assert.equal(adopted.length, 1, "the file is probed before it is attached");
      assert.equal(readFileSync(adopted[0]!).toString(), body.toString());

      const row = projectRow(ws, projectId);
      assert.equal(row.media_id, "dlmedia01", "the COLUMN records this disk's copy");

      // THE property. If the document changed, this machine would push a
      // `framevo://` URL to every other device and the web app would break.
      const doc = JSON.parse(String(row.doc)) as Record<string, unknown>;
      assert.equal(
        doc.originalVideoUrl,
        CLOUD_URL,
        "the synced document must keep naming the cloud copy"
      );

      assert.equal((await store.stateFor(projectId))?.state, "done");
    },
    serveBytes(body).impl
  );
});

test("a download that fails mid-flight attaches nothing", async () => {
  const failing = (async () =>
    new Response(null, { status: 500 })) as unknown as typeof fetch;
  await withRunner(
    async ({ ws, projectId, adopted, store }) => {
      assert.equal(adopted.length, 0);
      assert.equal(projectRow(ws, projectId).media_id, null, "a failed download attaches nothing");
      const state = await store.stateFor(projectId);
      assert.equal(state?.state, "pending", "a 500 is worth retrying");
      assert.match(String(state?.lastError), /trouble|try again/i);
    },
    failing
  );
});

test("a file that will not probe is discarded rather than attached", async () => {
  await withRunner(
    async ({ ws, projectId, dir, store }) => {
      assert.equal(projectRow(ws, projectId).media_id, null);
      assert.equal(
        readdirSafe(dir).length,
        0,
        "an unusable file is not left behind in the library folder"
      );
      assert.equal((await store.stateFor(projectId))?.state, "pending");
    },
    serveBytes(Buffer.from("not a video")).impl,
    {
      adopt: async () => {
        throw new Error("That file isn't a video Framevo can read.");
      },
    }
  );
});

test("a partial download resumes instead of starting over", async () => {
  const ws = workspace();
  const dir = mkdtempSync(join(tmpdir(), "framevo-dl-resume-"));
  try {
    const projectId = await seedProject(ws);
    await makeCloudOnly(ws, projectId);
    const store = createMediaDownloadsStore(ws.handle.db);
    const body = Buffer.from("0123456789abcdef");

    // The remains of a transfer that was cut off after 6 bytes.
    writeFileSync(join(dir, `${projectId}.part`), body.subarray(0, 6));

    const served = serveBytes(body);
    const adopted: string[] = [];
    const runner = createDownloadRunner({
      store,
      mediaStore: { adopt: fakeAdopt(ws, adopted) } as never,
      downloadsDir: dir,
      fetchImpl: served.impl,
    });

    await store.request({ projectId, ownerUid: UID_A, now: 100 });
    await runner.drain(UID_A);

    assert.equal(served.calls[0], "bytes=6-", "it asks to continue, not to start again");
    assert.equal(readFileSync(adopted[0]!).toString(), body.toString(), "and the file is whole");
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server that ignores Range restarts cleanly rather than doubling the file", async () => {
  const ws = workspace();
  const dir = mkdtempSync(join(tmpdir(), "framevo-dl-norange-"));
  try {
    const projectId = await seedProject(ws);
    await makeCloudOnly(ws, projectId);
    const store = createMediaDownloadsStore(ws.handle.db);
    const body = Buffer.from("0123456789abcdef");
    writeFileSync(join(dir, `${projectId}.part`), body.subarray(0, 6));

    const adopted: string[] = [];
    const runner = createDownloadRunner({
      store,
      mediaStore: { adopt: fakeAdopt(ws, adopted) } as never,
      downloadsDir: dir,
      // 200 + the whole body, even though a Range was asked for.
      fetchImpl: serveBytes(body, { ignoreRange: true }).impl,
    });

    await store.request({ projectId, ownerUid: UID_A, now: 100 });
    await runner.drain(UID_A);

    // Appending would have produced 22 bytes and a video that still probes —
    // the worst possible outcome, so it must truncate instead.
    assert.equal(readFileSync(adopted[0]!).toString(), body.toString());
  } finally {
    ws.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

function readdirSafe(dir: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:fs").readdirSync(dir) as string[];
  } catch {
    return [];
  }
}
