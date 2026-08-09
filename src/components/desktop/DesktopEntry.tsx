"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { DesktopSplash } from "./DesktopAuthGate";

/**
 * The origin root, `/`.
 *
 * It shows the splash and then forwards — to the workspace when a session was
 * restored, to sign-in when there wasn't one. The redirect waits for
 * `loading` to settle, which is what stops a signed-in user from seeing the
 * sign-in screen flash by on a cold launch while Firebase reads its store.
 */
export function DesktopEntry() {
  const { user, loading, configured } = useAuth();
  const router = useRouter();

  React.useEffect(() => {
    if (loading) return;
    router.replace(user || !configured ? "/dashboard" : "/login");
  }, [user, loading, configured, router]);

  return <DesktopSplash label="Restoring your session…" />;
}
