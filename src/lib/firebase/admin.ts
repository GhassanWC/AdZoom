import "server-only";

import { initializeApp, getApps, cert, applicationDefault, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage, type Storage } from "firebase-admin/storage";

let app: App | null = null;

function resolveServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    try {
      const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
      return cert(json);
    } catch (err) {
      console.error("[firebase-admin] Failed to parse FIREBASE_SERVICE_ACCOUNT_B64", err);
      throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_B64 — must be base64 JSON");
    }
  }
  // Fall back to Application Default Credentials (works on App Hosting / Cloud Run / GCE)
  return applicationDefault();
}

export function getAdmin() {
  if (!app) {
    if (getApps().length) {
      app = getApps()[0];
    } else {
      const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
      const storageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
      app = initializeApp({
        credential: resolveServiceAccount(),
        projectId,
        storageBucket,
      });
    }
  }
  const auth: Auth = getAuth(app);
  const db: Firestore = getFirestore(app);
  const storage: Storage = getStorage(app);
  return { app, auth, db, storage };
}
