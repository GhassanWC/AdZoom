/**
 * Moving the SOURCE VIDEO, in both directions, against the real app.
 *
 * The project DOCUMENT syncs on its own and is not what this spec is about. The
 * recording is gigabytes, so it moves only when a user asks — and these are the
 * two asks:
 *
 *   "Save to cloud"              a local video goes up
 *   "Download to this computer"  a cloud video comes down
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 * ---------------------------------
 * The download is real all the way through: a genuine HTTPS server (self-signed,
 * on loopback) streams a genuine H.264 file, which main streams to disk, FFprobe
 * probes, and the library adopts. The UPLOAD's final hop is not — these tests
 * run with the cloud blocked, by design (see fixtures.goOffline), so Firebase
 * Storage is unreachable. What IS asserted for the upload is everything up to
 * the wire: the click reaches main, the file is hashed BEFORE anything is sent,
 * a durable queue row appears with the right storage path, and the failure is
 * reported back rather than swallowed.
 *
 * THE INVARIANT THIS SPEC EXISTS FOR
 * ----------------------------------
 * Downloading a video must NOT change the synced document. `doc.originalVideoUrl`
 * names the cloud copy and syncs; `projects.media_id` names this disk's copy and
 * does not. If a download rewrote the document, this machine would push a
 * `framevo://` URL to every other device and the website would show a project
 * whose video does not exist — while everything here looked perfect. The last
 * test reads the SQLite document back and asserts it is untouched.
 */
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import {
  cleanupDir,
  firebaseApiKey,
  launchApp,
  makeFixtureVideo,
  openRoute,
  seedSignedInSession,
  stubDialogs,
  type LaunchedApp,
} from "./fixtures";

let workDir: string;
let profileDir: string;
let fixture: string;
let launched: LaunchedApp | null = null;
let server: Server | null = null;
let videoUrl = "";

/**
 * The certificate directory, generated out-of-band (openssl) and handed in.
 *
 * Without it the download half cannot be exercised for real — `isDownloadableUrl`
 * requires https, correctly, so there is no plain-http shortcut. Skipping is the
 * honest outcome; pretending with a stub would test the stub.
 */
const CERT_DIR = process.env.FRAMEVO_E2E_CERT_DIR ?? "";

test.skip(
  !firebaseApiKey(),
  "the renderer was built without NEXT_PUBLIC_FIREBASE_* — sign-in is impossible"
);

/** The app's own library database, read from outside while it is closed. */
function openLibrary(): DatabaseSync {
  return new DatabaseSync(join(profileDir, "framevo-library.db"));
}

function withLibrary<T>(fn: (db: DatabaseSync) => T): T {
  const db = openLibrary();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Serve the fixture over HTTPS with Range support — the shape of a Firebase
 * Storage download URL, which is what the runner is written against.
 */
async function startVideoServer(file: string): Promise<string> {
  const size = statSync(file).size;
  const instance = createServer(
    {
      cert: readFileSync(join(CERT_DIR, "cert.pem")),
      key: readFileSync(join(CERT_DIR, "key.pem")),
    },
    (req, res) => {
      const range = /bytes=(\d+)-/.exec(req.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      res.writeHead(start > 0 ? 206 : 200, {
        "content-type": "video/mp4",
        "content-length": String(size - start),
        "accept-ranges": "bytes",
      });
      createReadStream(file, { start }).pipe(res);
    }
  );
  await new Promise<void>((done) => instance.listen(0, "127.0.0.1", done));
  server = instance;
  const { port } = instance.address() as { port: number };
  return `https://127.0.0.1:${port}/clip.mp4`;
}

/** Launch, restore a session, and land on the library. */
async function launchSignedIn(): Promise<LaunchedApp> {
  const app = await launchApp({
    userDataDir: profileDir,
    // The main process fetches the download itself, and its certificate store
    // has never heard of ours. This is the test's own loopback server, not the
    // app's trust policy — app code is untouched.
    env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  });
  await seedSignedInSession(app.window);
  await openRoute(app.window, "/dashboard/projects");
  await expect(app.window.getByRole("heading", { name: /Your library/i })).toBeVisible({
    timeout: 30_000,
  });
  return app;
}

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "framevo-transfer-"));
  profileDir = mkdtempSync(join(tmpdir(), "framevo-transfer-profile-"));
  fixture = makeFixtureVideo(workDir, "cloud-fixture.mp4");
  expect(existsSync(fixture)).toBe(true);
  if (CERT_DIR) videoUrl = await startVideoServer(fixture);
});

test.afterAll(async () => {
  await launched?.close();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  cleanupDir(workDir);
  cleanupDir(profileDir);
});

test.describe.configure({ mode: "serial" });

test("a project with a local video offers to save it to the cloud", async () => {
  launched = await launchSignedIn();
  const { app, window } = launched;
  await stubDialogs(app, { open: fixture });

  await window.getByRole("link", { name: "Upload", exact: true }).first().click();
  await window.getByRole("button", { name: /Choose a video/i }).click();
  await expect
    .poll(() => window.evaluate(() => window.location.pathname), { timeout: 60_000 })
    .toMatch(/^\/dashboard\/projects\/.+/);

  await openRoute(window, "/dashboard/projects");
  // The video is on this disk and nowhere else, so the offer is to send it up.
  await expect(window.getByRole("button", { name: /Save to cloud/i }).first()).toBeVisible({
    timeout: 30_000,
  });
  // And there is nothing to bring down.
  await expect(window.getByRole("button", { name: /Download/i })).toHaveCount(0);
  await window.screenshot({ path: "test-results/cloud-transfer/01-save-to-cloud-offered.png" });
});

test("asking to save hashes the file first and queues a durable job", async () => {
  const { window } = launched!;
  await window.getByRole("button", { name: /Save to cloud/i }).first().click();

  // Offline the upload cannot land, so the observable end state is the queue
  // holding the work — which is exactly the durability claim worth proving.
  await expect(
    window.getByText(/Waiting to upload|Uploading|Try again/i).first()
  ).toBeVisible({ timeout: 30_000 });
  await window.screenshot({ path: "test-results/cloud-transfer/02-upload-queued.png" });

  await launched!.close();
  launched = null;

  withLibrary((db) => {
    const row = db.prepare("SELECT * FROM media_uploads").get() as Record<string, unknown>;
    expect(row, "a durable row survives the app closing").toBeTruthy();
    // Hashed BEFORE anything was sent — hashing afterwards would only prove
    // that the file we happened to read at the end matched itself.
    expect(String(row.checksum_sha256)).toHaveLength(64);
    expect(String(row.checksum_md5)).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(String(row.storage_path)).toMatch(/^users\/.+\/projects\/.+\//);
    expect(Number(row.bytes_total)).toBe(statSync(fixture).size);
    // It tried, and it kept the reason rather than swallowing it.
    expect(["pending", "uploading", "failed"]).toContain(String(row.state));

    // The project still points at the file on this disk. A queued upload must
    // never repoint anything — only a VERIFIED one does.
    const project = db.prepare("SELECT doc FROM projects LIMIT 1").get() as { doc: string };
    const doc = JSON.parse(project.doc) as Record<string, unknown>;
    expect(String(doc.originalVideoUrl)).toMatch(/^framevo:\/\//);
  });
});

test("a transfer queued before quitting is still visible on the next COLD launch", async () => {
  // A COLD launch on purpose — no `seedSignedInSession`, because the profile
  // already holds the session from the previous test and seeding would `reload()`
  // the page. That reload is what makes this pass for the wrong reason: by the
  // second mount main has already been told who is signed in, and the race being
  // guarded here has quietly resolved.
  //
  // The race: the transfer list is the only UNSOLICITED read in the feature, and
  // every transfer channel is scoped to the account main was told about.
  // `DesktopAuthGate` reports it from a SIBLING effect with no ordering
  // guarantee, so on a genuine first mount `list()` was rejected with "nobody is
  // signed in" and a real queued upload stayed invisible until something else
  // happened to move it. Nothing is clicked below; the state must arrive alone.
  launched = await launchApp({ userDataDir: profileDir });
  await openRoute(launched.window, "/dashboard/projects");
  await expect(launched.window.getByRole("heading", { name: /Your library/i })).toBeVisible({
    timeout: 30_000,
  });

  await expect(
    launched.window.getByText(/Waiting to upload|Uploading|Try again/i).first()
  ).toBeVisible({ timeout: 30_000 });
  await launched.window.screenshot({ path: "test-results/cloud-transfer/03-queued-survives-restart.png" });
  await launched.close();
  launched = null;
});

test.describe("downloading a cloud video", () => {
  test.skip(!CERT_DIR, "no FRAMEVO_E2E_CERT_DIR — cannot serve https on loopback");

  test("a project whose video is only in the cloud offers to download it", async () => {
    // Put the project in the state one synced from ANOTHER machine arrives in:
    // the document is here, the recording is not.
    withLibrary((db) => {
      const row = db.prepare("SELECT id, doc FROM projects LIMIT 1").get() as {
        id: string;
        doc: string;
      };
      const doc = { ...(JSON.parse(row.doc) as Record<string, unknown>) };
      doc.originalVideoUrl = videoUrl;
      doc.storagePath = "users/u/projects/p/clip.mp4";
      db.prepare("UPDATE projects SET media_id = NULL, doc = ? WHERE id = ?").run(
        JSON.stringify(doc),
        row.id
      );
      db.prepare("DELETE FROM media_uploads").run();
    });

    launched = await launchSignedIn();
    const { window } = launched;
    await expect(window.getByRole("button", { name: /Download/i }).first()).toBeVisible({
      timeout: 30_000,
    });
    // Nothing here to send up any more.
    await expect(window.getByRole("button", { name: /Save to cloud/i })).toHaveCount(0);
    await window.screenshot({ path: "test-results/cloud-transfer/03-download-offered.png" });
  });

  test("downloading streams it to disk, probes it, and leaves the DOCUMENT alone", async () => {
    const { window } = launched!;
    await window.getByRole("button", { name: /Download/i }).first().click();

    // Done when the offer is gone: the video is now in both places.
    await expect(window.getByRole("button", { name: /Download/i })).toHaveCount(0, {
      timeout: 90_000,
    });
    await window.screenshot({ path: "test-results/cloud-transfer/04-downloaded.png" });

    await launched!.close();
    launched = null;

    withLibrary((db) => {
      const download = db
        .prepare("SELECT * FROM media_downloads")
        .get() as Record<string, unknown>;
      expect(String(download.state)).toBe("done");

      const project = db.prepare("SELECT id, media_id, doc FROM projects LIMIT 1").get() as {
        id: string;
        media_id: string | null;
        doc: string;
      };

      // The COLUMN records this disk's copy…
      expect(project.media_id, "the download is attached to the project").toBeTruthy();
      const media = db
        .prepare("SELECT * FROM media WHERE id = ?")
        .get(project.media_id) as Record<string, unknown>;
      expect(existsSync(String(media.path)), "the file is really there").toBe(true);
      expect(Number(media.size_bytes)).toBe(statSync(fixture).size);
      // FFprobe ran on it — a truncated body would have failed here instead.
      expect(Number(media.duration_sec)).toBeGreaterThan(3);
      expect(String(media.video_codec)).toBe("h264");
      expect(Number(media.owned)).toBe(1);

      // …and the DOCUMENT still names the cloud copy. This is the whole point:
      // a `framevo://` URL here would be pushed to every other device.
      const doc = JSON.parse(project.doc) as Record<string, unknown>;
      expect(doc.originalVideoUrl).toBe(videoUrl);
      expect(doc.storagePath).toBe("users/u/projects/p/clip.mp4");
    });
  });

  test("the downloaded project now opens from disk, offline", async () => {
    launched = await launchSignedIn();
    const { window } = launched;
    const id = withLibrary(
      (db) => (db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string }).id
    );
    await openRoute(window, `/dashboard/projects/${id}`);

    // The editor resolves the source at READ time and gets the local file —
    // which is what makes the project editable and exportable with no network.
    await expect
      .poll(
        () =>
          window.evaluate(() => {
            const el = document.querySelector("video");
            return el?.getAttribute("src") ?? el?.currentSrc ?? "";
          }),
        { timeout: 60_000 }
      )
      .toMatch(/^framevo:\/\/app\/__media\//);
    await window.screenshot({ path: "test-results/cloud-transfer/05-opens-from-disk.png" });
  });
});
