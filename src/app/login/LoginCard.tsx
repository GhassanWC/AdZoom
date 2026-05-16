"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { Logo } from "@/components/landing/Logo";

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
            Sign in to AdZoom
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
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <path
              fill="#4285F4"
              d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
            />
            <path
              fill="#34A853"
              d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.836.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
            />
            <path
              fill="#FBBC05"
              d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
            />
            <path
              fill="#EA4335"
              d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
            />
          </svg>
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
