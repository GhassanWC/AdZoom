"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { usePlatform } from "@/lib/platform";
import { useOnline } from "@/lib/useOnline";
import { Logo } from "@/components/landing/Logo";
import { GoogleMark } from "@/components/auth/GoogleMark";
import { BRAND_STRINGS } from "@/lib/branding";

/**
 * Framevo Desktop's sign-in screen.
 *
 * Same card, same copy, same Google button as the website — and the SAME
 * Firebase account behind it. What differs is only where the password is typed:
 * pressing the button hands the flow to the user's real browser (PKCE + a
 * loopback redirect, brokered by the Electron main process). Framevo never
 * renders a Google login page; Google refuses embedded ones, and an app that
 * drew its own would be indistinguishable from one harvesting passwords.
 *
 * Any provider Firebase supports without a browser hop (email/password, custom
 * tokens) works unchanged through the same `AuthProvider` — this screen offers
 * exactly the providers Framevo has enabled today, which is Google.
 */
export function DesktopLoginScreen() {
  const { user, loading, configured, signInWithGoogle } = useAuth();
  const platform = usePlatform();
  const router = useRouter();
  const search = useSearchParams();
  const online = useOnline();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const next = search.get("next") || "/dashboard";
  const signInConfigured = platform.app?.googleSignInConfigured ?? true;
  // Two halves of the build pointing at different projects. Sign-in cannot
  // succeed, and Firebase's own message names neither artifact.
  const buildMismatch = platform.app?.buildMismatch ?? null;

  React.useEffect(() => {
    if (!loading && user) router.replace(next);
  }, [user, loading, router, next]);

  // Leaving this screen with a browser tab still waiting would let a late
  // callback sign someone in behind their back.
  React.useEffect(() => {
    const auth = platform.auth;
    return () => {
      void auth?.cancel().catch(() => undefined);
    };
  }, [platform.auth]);

  const onGoogle = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setSubmitting(false);
    }
  };

  const blocked = !configured || !signInConfigured || !online || Boolean(buildMismatch);

  return (
    <div className="grid h-dvh place-items-center bg-ink px-4">
      <div className="relative w-full max-w-md">
        <div className="glass relative overflow-hidden rounded-2xl p-8">
          <div className="mb-7 text-center">
            <Logo className="mx-auto" />
            <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-white">
              {BRAND_STRINGS.signInTo}
            </h1>
            <p className="mt-1.5 text-sm text-fog">
              Your projects, plan and exports follow you from the web.
            </p>
          </div>

          {!configured && (
            <Notice tone="amber" title="This build has no Firebase credentials.">
              Rebuild the desktop app with the{" "}
              <code className="font-mono">NEXT_PUBLIC_FIREBASE_*</code> variables set.
            </Notice>
          )}

          {configured && !signInConfigured && (
            <Notice tone="amber" title="Google sign-in isn't configured in this build.">
              It needs <code className="font-mono">FRAMEVO_GOOGLE_DESKTOP_CLIENT_ID</code> and{" "}
              <code className="font-mono">NEXT_PUBLIC_CLOUD_API_BASE</code>. See{" "}
              <span className="font-mono">docs/desktop/auth.md</span>.
            </Notice>
          )}

          {configured && signInConfigured && buildMismatch && (
            <Notice tone="amber" title="This build mixes two environments.">
              {buildMismatch}
            </Notice>
          )}

          {configured && signInConfigured && !buildMismatch && !online && (
            <Notice tone="amber" title="You're offline.">
              Signing in needs a connection. Reconnect and try again — projects you already have on
              this computer stay available either way.
            </Notice>
          )}

          <button
            onClick={() => void onGoogle()}
            disabled={blocked || submitting || loading}
            className="group relative flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] text-sm font-medium text-white transition-all duration-200 hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GoogleMark />
            <span>{submitting ? "Waiting for your browser…" : "Continue with Google"}</span>
          </button>

          {submitting && (
            <p className="mt-4 flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-[11.5px] leading-relaxed text-fog">
              <ExternalLink size={13} className="mt-0.5 shrink-0 text-violet-300" />
              <span>
                Framevo opened your browser to finish signing in. Come back here when it says
                you&apos;re done.
              </span>
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-rose-400/30 bg-rose-500/[0.06] px-3 py-2 text-xs text-rose-200"
            >
              {error}
            </p>
          )}

          <p className="mt-6 flex items-start gap-2 text-[11px] leading-relaxed text-fog">
            <ShieldCheck size={13} className="mt-0.5 shrink-0" />
            <span>
              You&apos;ll sign in with Google in your own browser — Framevo never sees your
              password, and never shows you a Google login page of its own.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "amber";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        tone === "amber"
          ? "mb-5 rounded-xl border border-amber-400/30 bg-amber-500/[0.06] p-4 text-xs text-amber-200"
          : ""
      }
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1 leading-relaxed text-amber-100/80">{children}</p>
    </div>
  );
}
