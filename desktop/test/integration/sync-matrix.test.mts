/**
 * The sync matrix, end to end: REAL SQLite ⇄ REAL Firestore (emulator, enforcing
 * the real `firestore.rules`).
 *
 * Everything below has a unit-level counterpart —
 * `tests/sync-engine.test.ts` proves the control flow against fakes, and
 * `desktop/test/sync-reconcile.test.mts` proves the SQLite half. What only THIS
 * file can prove is that the two halves agree once a real transaction, a real
 * `onSnapshot` and a real security rule are in the middle:
 *
 *   • that `runTransaction` really is a compare-and-set under contention
 *   • that a document written from here is the shape the website reads
 *   • that the rules do not reject what the engine sends
 *
 * SKIPPED without the emulator (see ./emulator.mts). A skipped run proves
 * nothing — `npm run test:integration` is the gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSyncEngine } from "../../../src/lib/sync/engine.ts";
import { createFirestoreRemote } from "../../../src/lib/sync/firestore-remote.ts";
import type { LocalSyncPort } from "../../../src/lib/sync/ports.ts";
import { createSyncStore } from "../../src/main/sync-store.ts";
import { projectRow, seedProject, workspace, type Workspace } from "../sync-harness.mts";
import {
  SKIP_REASON,
  clearFirestore,
  connectEmulator,
  emulatorAvailable,
  waitFor,
  type EmulatorClient,
} from "./emulator.mts";

const available = await emulatorAvailable();

/**
 * A desktop: a real SQLite library, wired to a real Firestore client, driven by
 * the real engine.
 *
 * `ownerUid` comes from the emulator's anonymous sign-in rather than a constant,
 * because the rules compare it against `request.auth.uid` — a hard-coded uid
 * would be rejected, which is exactly the check worth having.
 */
async function device(client: EmulatorClient) {
  const ws = workspace();
  ws.signInAs(client.uid);
  const store = createSyncStore(ws.handle.db);
  const engine = createSyncEngine({
    local: store as unknown as LocalSyncPort,
    remote: createFirestoreRemote(client.uid, client.db),
    ownerUid: client.uid,
    onError: (err) => errors.push(err.message),
  });
  return { ws, store, engine, uid: client.uid };
}

const errors: string[] = [];

type Device = Awaited<ReturnType<typeof device>>;

const docOf = (ws: Workspace, id: string) =>
  JSON.parse(String(projectRow(ws, id).doc)) as Record<string, unknown>;

/** Read a project straight out of Firestore, as the website would. */
async function readCloud(client: EmulatorClient, projectId: string) {
  const { doc, getDoc } = await import("firebase/firestore");
  const snap = await getDoc(doc(client.db, "users", client.uid, "projects", projectId));
  return snap.exists() ? (snap.data() as Record<string, unknown>) : null;
}

async function withDevice(fn: (d: Device, client: EmulatorClient) => Promise<void>) {
  await clearFirestore();
  const client = await connectEmulator();
  const d = await device(client);
  try {
    await fn(d, client);
  } finally {
    d.engine.stop();
    d.ws.cleanup();
    await client.close();
  }
}

// ── desktop → web ──────────────────────────────────────────────────────────

test("an edit made on the desktop lands in Firestore", { skip: !available && SKIP_REASON }, async () => {
  await withDevice(async (d, client) => {
    const id = await seedProject(d.ws);
    await d.ws.library.write(id, { title: "Renamed on desktop" }, Date.now());

    await d.engine.drain();

    const cloud = await readCloud(client, id);
    assert.ok(cloud, "the project reached Firestore");
    assert.equal(cloud.title, "Renamed on desktop");
    assert.equal(cloud.rev, 1, "the first accepted write stamps revision 1");
    assert.ok(cloud.lastOpId, "and carries its idempotency marker");
    assert.equal(projectRow(d.ws, id).sync_state, "synced");
  });
});

test("the rules accept what the engine sends", { skip: !available && SKIP_REASON }, async () => {
  await withDevice(async (d) => {
    const id = await seedProject(d.ws);
    await d.ws.library.write(id, { title: "Rules check" }, Date.now());
    await d.engine.drain();

    assert.deepEqual(
      errors.filter((e) => /permission|insufficient/i.test(e)),
      [],
      "a permission-denied here means the shipped rules reject the shipped writes"
    );
  });
});

// ── web → desktop ──────────────────────────────────────────────────────────

test("a project created on the web appears locally", { skip: !available && SKIP_REASON }, async () => {
  await withDevice(async (d, client) => {
    const { doc, setDoc } = await import("firebase/firestore");
    await setDoc(doc(client.db, "users", client.uid, "projects", "from-web"), {
      id: "from-web",
      userId: client.uid,
      title: "Made on the website",
      rev: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    d.engine.start();
    await waitFor(
      () => !!projectRow(d.ws, "from-web"),
      "the web project to be mirrored into SQLite"
    );
    assert.equal(projectRow(d.ws, "from-web").title, "Made on the website");
    assert.equal(projectRow(d.ws, "from-web").sync_state, "synced");
  });
});

// ── simultaneous edits ─────────────────────────────────────────────────────

test(
  "independent edits on both sides merge with no conflict",
  { skip: !available && SKIP_REASON },
  async () => {
    await withDevice(async (d, client) => {
      const id = await seedProject(d.ws);
      const moments = [
        { id: "a", startTime: 1, endTime: 2, effectType: "zoom" },
        { id: "b", startTime: 3, endTime: 4, effectType: "zoom" },
      ];
      await d.ws.library.write(
        id,
        { analysis: { status: "complete", detectedMoments: moments, boringSections: [] } },
        Date.now()
      );
      await d.engine.drain();

      // The website trims moment b while the desktop moves moment a.
      const { doc, updateDoc } = await import("firebase/firestore");
      await updateDoc(doc(client.db, "users", client.uid, "projects", id), {
        "analysis.detectedMoments": [
          { id: "a", startTime: 1, endTime: 2, effectType: "zoom" },
          { id: "b", startTime: 3, endTime: 9, effectType: "zoom" },
        ],
        rev: 2,
      });
      await d.ws.library.write(
        id,
        {
          analysis: {
            detectedMoments: [
              { id: "a", startTime: 5, endTime: 6, effectType: "zoom" },
              { id: "b", startTime: 3, endTime: 4, effectType: "zoom" },
            ],
          },
        },
        Date.now()
      );

      await d.engine.drain();
      await d.engine.drain();

      const local = docOf(d.ws, id);
      const merged = (local.analysis as Record<string, unknown>).detectedMoments as Record<
        string,
        unknown
      >[];
      const byId = new Map(merged.map((m) => [m.id, m]));
      assert.equal(byId.get("a")!.startTime, 5, "the desktop edit survived");
      assert.equal(
        byId.get("b")!.endTime,
        9,
        "the web edit survived — this is the case a naive patch replay destroys"
      );
      assert.notEqual(projectRow(d.ws, id).sync_state, "conflict");
    });
  }
);

test(
  "the same field edited on both sides stops the push and asks",
  { skip: !available && SKIP_REASON },
  async () => {
    await withDevice(async (d, client) => {
      const id = await seedProject(d.ws);
      await d.ws.library.write(id, { title: "Shared" }, Date.now());
      await d.engine.drain();

      const { doc, updateDoc } = await import("firebase/firestore");
      await updateDoc(doc(client.db, "users", client.uid, "projects", id), {
        title: "Web title",
        rev: 2,
      });
      await d.ws.library.write(id, { title: "Desktop title" }, Date.now());

      await d.engine.drain();

      assert.equal(projectRow(d.ws, id).sync_state, "conflict");
      const cloud = await readCloud(client, id);
      assert.equal(
        cloud!.title,
        "Web title",
        "the cloud was NOT overwritten while the disagreement is unresolved"
      );
    });
  }
);

// ── offline / restart ──────────────────────────────────────────────────────

test(
  "edits made offline flush after a restart",
  { skip: !available && SKIP_REASON },
  async () => {
    await withDevice(async (d, client) => {
      const id = await seedProject(d.ws);
      d.engine.setOnline(false);
      await d.ws.library.write(id, { title: "Written on a plane" }, Date.now());
      await d.engine.drain();
      assert.equal(await readCloud(client, id), null, "nothing was sent while offline");

      // The app is quit and relaunched with the write still queued.
      d.ws.restart();
      const store = createSyncStore(d.ws.handle.db);
      const engine = createSyncEngine({
        local: store as unknown as LocalSyncPort,
        remote: createFirestoreRemote(client.uid, client.db),
        ownerUid: client.uid,
      });
      await engine.drain();
      engine.stop();

      const cloud = await readCloud(client, id);
      assert.equal(cloud!.title, "Written on a plane", "the queue survived the restart");
    });
  }
);

// ── idempotency ────────────────────────────────────────────────────────────

test(
  "replaying an operation does not apply it twice",
  { skip: !available && SKIP_REASON },
  async () => {
    await withDevice(async (d, client) => {
      const id = await seedProject(d.ws);
      await d.ws.library.write(id, { title: "Once" }, Date.now());
      const [op] = await d.store.claim(d.uid, Date.now());
      const remote = createFirestoreRemote(client.uid, client.db);

      const first = await remote.commit({
        projectId: id,
        opId: op!.opId,
        baseRev: op!.baseRev,
        patch: op!.payload,
        deviceId: op!.deviceId,
      });
      assert.equal(first.status, "applied");

      // The ack was lost; the same operation is sent again.
      const second = await remote.commit({
        projectId: id,
        opId: op!.opId,
        baseRev: op!.baseRev,
        patch: op!.payload,
        deviceId: op!.deviceId,
      });
      assert.equal(second.status, "skipped", "recognised as already applied");
      assert.equal((await readCloud(client, id))!.rev, 1, "still one revision");
    });
  }
);

test(
  "a write composed against a stale revision is refused, not applied",
  { skip: !available && SKIP_REASON },
  async () => {
    await withDevice(async (d, client) => {
      const id = await seedProject(d.ws);
      await d.ws.library.write(id, { title: "First" }, Date.now());
      await d.engine.drain();

      const remote = createFirestoreRemote(client.uid, client.db);
      const result = await remote.commit({
        projectId: id,
        opId: "op_stale",
        baseRev: 0, // the document is at rev 1
        patch: { title: "Should not land" },
        deviceId: "dev_other",
      });

      assert.equal(result.status, "stale");
      assert.equal(
        (await readCloud(client, id))!.title,
        "First",
        "compare-and-set refused the overwrite"
      );
    });
  }
);

// ── deletion ───────────────────────────────────────────────────────────────

test(
  "deleting locally removes the cloud copy and it stays gone",
  { skip: !available && SKIP_REASON },
  async () => {
    await withDevice(async (d, client) => {
      const id = await seedProject(d.ws);
      await d.ws.library.write(id, { title: "Doomed" }, Date.now());
      await d.engine.drain();
      assert.ok(await readCloud(client, id));

      await d.store.addTombstone({
        entity: "project",
        entityId: id,
        ownerUid: d.uid,
        deviceId: "dev_test",
        now: Date.now(),
      });
      await d.ws.library.remove(id);
      await d.engine.drain();

      assert.equal(await readCloud(client, id), null, "the cloud document is gone");

      // And a late snapshot must not bring it back.
      d.engine.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(projectRow(d.ws, id), undefined, "the tombstone held");
    });
  }
);
