"use client";

import * as React from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { getFirebase, googleProvider, isFirebaseConfigured } from "./client";
import { getDesktopApi } from "@/lib/platform/desktop/bridge";
import { trackEvent } from "@/lib/analytics/trackEvent";
import { EVENTS } from "@/lib/analytics/events";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  configured: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Current ID token. Firebase refreshes it automatically when it is expired or
   * near expiry; pass `forceRefresh` to re-mint it unconditionally — used to
   * retry once after a server returns 401 on a token that went stale while the
   * tab sat open.
   */
  getIdToken: (forceRefresh?: boolean) => Promise<string | null>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<User | null>(null);
  const configured = isFirebaseConfigured();
  // Only "loading" when there is something to load. With no Firebase config
  // there is no session to restore, so the app must not sit on a splash waiting
  // for a state change that will never come.
  const [loading, setLoading] = React.useState(configured);

  React.useEffect(() => {
    if (!configured) return;
    // Persistence is pinned when the Auth instance is created (see
    // firebase/client.ts) — it CANNOT be changed here, because Firebase has
    // already read the stored session by the time this effect runs.
    const { auth } = getFirebase();
    const desktop = Boolean(getDesktopApi());
    let revalidated = false;

    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
      if (!u) return;

      // Desktop only, once per launch: a session restored from disk may be
      // months old, and a revoked or disabled account still yields a cached
      // user object until something asks for a fresh token. Ask — so a dead
      // account lands on sign-in instead of on a dashboard that 401s.
      //
      // The web is deliberately left alone: the browser gets a fresh session
      // per visit, and forcing a refresh there would sign out anyone offline.
      if (desktop && !revalidated) {
        revalidated = true;
        try {
          await u.getIdToken(true);
        } catch (err) {
          // Distinguish "your account is gone" from "you're on a plane".
          const code = (err as { code?: string })?.code ?? "";
          if (code === "auth/network-request-failed") {
            console.warn("[auth] offline — keeping the stored session");
          } else {
            console.warn("[auth] stored session is no longer valid", code || err);
            await fbSignOut(auth).catch(() => undefined);
            return;
          }
        }
      }

      try {
        await ensureUserDoc(u);
      } catch (err) {
        console.error("[auth] failed to upsert user doc", err);
      }
    });

    return () => unsub();
  }, [configured]);

  /**
   * Google sign-in, by the only route each shell can safely take.
   *
   * Browser: the popup flow, unchanged.
   * Desktop: the system browser (PKCE + loopback, brokered by the Electron main
   *   process — see desktop/src/main/auth). Google refuses to render its login
   *   page in an embedded view, and an in-app Google form would be
   *   indistinguishable from a phishing one. The flow returns a Google ID
   *   token, which `signInWithCredential` resolves to the SAME Firebase user
   *   the website's popup produces — same uid, same subscription, same data.
   */
  const signInWithGoogle = React.useCallback(async () => {
    const { auth } = getFirebase();
    const desktop = getDesktopApi();
    if (desktop) {
      const { idToken } = await desktop.auth.googleSignIn();
      await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
      void trackEvent(EVENTS.LOGIN, { method: "google-desktop" });
      return;
    }
    await signInWithPopup(auth, googleProvider);
    void trackEvent(EVENTS.LOGIN, { method: "google" });
  }, []);

  const signOut = React.useCallback(async () => {
    const { auth } = getFirebase();
    // Track before sign-out so currentUser is still set for attribution.
    void trackEvent(EVENTS.SIGN_OUT);
    // Abandon any sign-in the user left half-finished in their browser, so a
    // stale callback can't sign them back in a moment after they left.
    await getDesktopApi()?.auth.cancel().catch(() => undefined);
    await fbSignOut(auth);
  }, []);

  const getIdToken = React.useCallback(
    async (forceRefresh = false) => {
      if (!user) return null;
      return user.getIdToken(forceRefresh);
    },
    [user]
  );

  const value: AuthContextValue = {
    user,
    loading,
    configured,
    signInWithGoogle,
    signOut,
    getIdToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

async function ensureUserDoc(user: User) {
  const { db } = getFirebase();
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      displayName: user.displayName,
      email: user.email,
      photoURL: user.photoURL,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    // First time we've seen this user → a sign-up.
    void trackEvent(EVENTS.SIGN_UP, { method: "google" });
  } else {
    await setDoc(
      ref,
      {
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }
}
