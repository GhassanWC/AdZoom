/**
 * Firebase Admin init for the Remotion renderer Job. On Cloud Run this uses
 * Application Default Credentials (the Job's attached service account). Locally it
 * falls back to a base64 service-account key (`FIREBASE_SERVICE_ACCOUNT_B64`).
 * Mirrors services/export-worker/src/firebase.ts.
 */
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { loadConfig } from "./config.js";

let app: App | undefined;

export function getAdmin(): { app: App; db: Firestore; bucketName: string | undefined } {
  const cfg = loadConfig();
  if (!app) {
    if (getApps().length) {
      app = getApps()[0]!;
    } else {
      const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
      const credential = b64
        ? cert(JSON.parse(Buffer.from(b64, "base64").toString("utf8")))
        : applicationDefault();
      app = initializeApp({
        credential,
        projectId: cfg.projectId,
        storageBucket: cfg.storageBucket,
      });
    }
  }
  return { app, db: getFirestore(app), bucketName: cfg.storageBucket };
}

export function bucket() {
  const { app: a, bucketName } = getAdmin();
  return getStorage(a).bucket(bucketName);
}
