"use client";

import * as React from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { getFirebase, googleProvider, isFirebaseConfigured } from "./client";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  configured: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Latest cached ID token. Use getIdToken() when you need a fresh one. */
  getIdToken: () => Promise<string | null>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);
  const configured = isFirebaseConfigured();

  React.useEffect(() => {
    if (!configured) {
      setLoading(false);
      return;
    }
    const { auth } = getFirebase();
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
      if (u) {
        try {
          await ensureUserDoc(u);
        } catch (err) {
          console.error("[auth] failed to upsert user doc", err);
        }
      }
    });
    return () => unsub();
  }, [configured]);

  const signInWithGoogle = React.useCallback(async () => {
    const { auth } = getFirebase();
    await signInWithPopup(auth, googleProvider);
  }, []);

  const signOut = React.useCallback(async () => {
    const { auth } = getFirebase();
    await fbSignOut(auth);
  }, []);

  const getIdToken = React.useCallback(async () => {
    if (!user) return null;
    return user.getIdToken();
  }, [user]);

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
