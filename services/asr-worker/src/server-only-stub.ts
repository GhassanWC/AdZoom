/**
 * Empty stand-in for the `server-only` package. The shared firebase admin
 * module (`@/lib/firebase/admin`) imports `server-only` as a Next.js
 * client-bundle guard; outside a Next server context the real package throws
 * on import. This worker IS server-only by construction, so the guard is
 * satisfied vacuously. Wired via the esbuild + tsconfig `server-only` alias.
 */
export {};
