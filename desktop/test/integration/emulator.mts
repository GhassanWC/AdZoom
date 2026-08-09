/**
 * Talking to the Firebase emulator suite.
 *
 * WHY THE SUITE STAYS GREEN WITHOUT IT
 * ------------------------------------
 * The emulators are JVM processes. A machine without a JRE — or a developer who
 * simply ran `npm test` rather than `npm run test:integration` — must not see a
 * wall of red for an environment they never opted into. `emulatorAvailable()`
 * probes the port and every spec here skips with an actionable message when it
 * answers no.
 *
 * That is a deliberate trade with a known cost: a skipped test proves nothing,
 * so a green run is NOT evidence that sync works against Firestore. Only
 * `npm run test:integration` is, and it is the gate for calling this done.
 *
 * WHY THE REAL CLIENT SDK RATHER THAN A RULES-TESTING LIBRARY
 * ----------------------------------------------------------
 * The point of these specs is to exercise `createFirestoreRemote` — real
 * transactions, real `onSnapshot`, real merge semantics — against the real
 * `firestore.rules` the emulator loads. Swapping in a different Firestore
 * client would test something adjacent to the code that ships.
 */
import { createConnection } from "node:net";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  getFirestore,
  terminate,
  type Firestore,
} from "firebase/firestore";
import {
  connectAuthEmulator,
  getAuth,
  signInAnonymously,
  signOut,
  type Auth,
} from "firebase/auth";

export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? "framevo-test";
const FIRESTORE_HOST = "127.0.0.1";
const FIRESTORE_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);
const AUTH_PORT = Number(process.env.FIREBASE_AUTH_EMULATOR_PORT ?? 9099);

/** Human-readable reason to put in a skip, so a red herring never wastes anyone's day. */
export const SKIP_REASON =
  `the Firebase emulator is not running on :${FIRESTORE_PORT} — ` +
  "start it with `npm run emu` (requires a JRE), or run `npm run test:integration`";

let probed: boolean | null = null;

/** Is the Firestore emulator accepting connections? Probed once per process. */
export async function emulatorAvailable(): Promise<boolean> {
  if (probed !== null) return probed;
  probed = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ port: FIRESTORE_PORT, host: FIRESTORE_HOST });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 2_000);
  });
  return probed;
}

export interface EmulatorClient {
  app: FirebaseApp;
  db: Firestore;
  auth: Auth;
  uid: string;
  close(): Promise<void>;
}

let appSeq = 0;

/**
 * A signed-in Firestore client against the emulator.
 *
 * Anonymous sign-in is enough: `firestore.rules` only ever asks whether
 * `request.auth.uid` matches the document owner, so a real Google identity would
 * add nothing but flakiness.
 *
 * Each client gets its OWN FirebaseApp so two "devices" in one test are genuinely
 * independent — same project, different auth state and different listeners,
 * which is what a desktop and a browser actually are.
 */
export async function connectEmulator(): Promise<EmulatorClient> {
  const app = initializeApp(
    { projectId: PROJECT_ID, apiKey: "emulator-key", appId: "1:0:web:0" },
    `integration-${++appSeq}`
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${FIRESTORE_HOST}:${AUTH_PORT}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, FIRESTORE_HOST, FIRESTORE_PORT);

  const credential = await signInAnonymously(auth);

  return {
    app,
    db,
    auth,
    uid: credential.user.uid,
    async close() {
      await signOut(auth).catch(() => undefined);
      await terminate(db).catch(() => undefined);
      await deleteApp(app).catch(() => undefined);
    },
  };
}

/**
 * Wipe every document, so one spec cannot leak state into the next.
 *
 * Uses the emulator's own admin endpoint rather than deleting documents through
 * the client, which the rules would (correctly) refuse.
 */
export async function clearFirestore(): Promise<void> {
  const url =
    `http://${FIRESTORE_HOST}:${FIRESTORE_PORT}/emulator/v1/projects/` +
    `${PROJECT_ID}/databases/(default)/documents`;
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`could not clear the emulator (${response.status})`);
  }
}

/** Poll until `predicate` holds, so a listener-driven assertion is not a race. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
