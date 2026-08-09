"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { Logo } from "@/components/landing/Logo";
import { GoogleMark } from "@/components/auth/GoogleMark";
import { BRAND_STRINGS } from "@/lib/branding";

export function LoginCard() {
  const { user, loading, configured, signInWithGoogle } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const next = search.get("next") || "/dashboard";

  React.useEffect(() => {
    if (!loading && user) {
      router.replace(next);
    }
  }, [user, loading, router, next]);

  const onGoogle = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not sign in.";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative w-full max-w-md">
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1.5 text-xs text-fog transition-colors duration-200 hover:text-white"
      >
        <ArrowLeft size={12} />
        Back to home
      </Link>

      <div className="glass relative overflow-hidden rounded-2xl p-8">
        <div className="mb-7 text-center">
          <Logo className="mx-auto" />
          <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-white">
            {BRAND_STRINGS.signInTo}
          </h1>
          <p className="mt-1.5 text-sm text-fog">
            One click to start enhancing recordings.
          </p>
        </div>

        {!configured && (
          <div className="mb-5 rounded-xl border border-amber-400/30 bg-amber-500/[0.06] p-4 text-xs text-amber-200">
            <p className="font-semibold">Firebase isn't configured yet.</p>
            <p className="mt-1 leading-relaxed text-amber-100/80">
              Add Firebase credentials to <code className="font-mono">.env.local</code> (see{" "}
              <code className="font-mono">.env.local.example</code>) and restart the dev server.
            </p>
          </div>
        )}

        <button
          onClick={onGoogle}
          disabled={!configured || submitting || loading}
          className="group relative flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] text-sm font-medium text-white transition-all duration-200 hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <GoogleMark />
          <span>{submitting ? "Signing in…" : "Continue with Google"}</span>
        </button>

        {error && (
          <p className="mt-4 rounded-lg border border-rose-400/30 bg-rose-500/[0.06] px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        )}

        <p className="mt-6 text-center text-[11px] text-fog">
          By continuing you agree to our{" "}
          <a href="#" className="text-white/85 underline-offset-4 hover:underline">
            Terms
          </a>{" "}
          and{" "}
          <a href="#" className="text-white/85 underline-offset-4 hover:underline">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}
