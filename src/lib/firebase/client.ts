"use client";

import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  initializeAuth,
  GoogleAuthProvider,
  type Auth,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";
import { isDesktopRuntime } from "@/lib/platform/desktop/bridge";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  // Optional — enables Firebase Analytics (GA4). When absent, analytics
  // cleanly no-ops (see src/lib/analytics/firebaseAnalytics.ts).
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

let app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _db: Firestore | null = null;
let _storage: FirebaseStorage | null = null;

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
}

export function getFirebase() {
  if (!isFirebaseConfigured()) {
    throw new Error(
      "Firebase is not configured. Set NEXT_PUBLIC_FIREBASE_* env vars in .env.local"
    );
  }
  if (!app) {
    app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  }
  if (!_auth) _auth = createAuth(app);
  if (!_db) _db = getFirestore(app);
  if (!_storage) _storage = getStorage(app);
  return { app, auth: _auth, db: _db, storage: _storage };
}

/**
 * Where the session is persisted, decided ONCE at initialization.
 *
 * Browser: Firebase's own default chain (IndexedDB, then localStorage), plus
 * the popup redirect resolver `signInWithPopup` needs. Unchanged.
 *
 * Desktop: localStorage on the app's own `framevo://app` origin, pinned here
 * rather than switched afterwards. `setPersistence()` cannot help: Firebase has
 * already read the stored user by the time it runs, so a session written to one
 * store and read from another is simply lost — which looks exactly like "the
 * app signs me out every launch". No popup resolver is passed because the
 * desktop never opens one; sign-in happens in the user's real browser.
 */
function createAuth(instance: FirebaseApp): Auth {
  if (typeof window === "undefined" || !isDesktopRuntime()) {
    return getAuth(instance);
  }
  return initializeAuth(instance, { persistence: browserLocalPersistence });
}

export const googleProvider = new GoogleAuthProvider();
