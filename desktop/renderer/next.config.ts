import type { NextConfig } from "next";
import path from "node:path";

/**
 * The DESKTOP renderer build.
 *
 * This is not a second Framevo app — it is a thin shell whose only job is to
 * emit a fully static bundle of the SAME components the website uses (the `@/`
 * alias below points straight at ../../src). It exists because the production
 * app cannot be statically exported: it ships 33 API route handlers, both of
 * which `output: "export"` rejects. Those API routes are exactly the parts that
 * must STAY on the server (Gemini, Firebase Admin, Lemon Squeezy), so the
 * desktop calls them over HTTPS via NEXT_PUBLIC_CLOUD_API_BASE instead of
 * shipping them.
 *
 * ROUTING. The route tree under src/app mirrors the website's — /login,
 * /dashboard, /dashboard/projects/[id] and the rest are REAL routes with real
 * pre-rendered artifacts, so `next/link`, `usePathname`, `router.push`, browser
 * back/forward and a hard reload all behave exactly as they do on the web. Two
 * things make that work without a server:
 *
 *   • NO `assetPrefix`. Assets resolve absolutely from the origin root
 *     (`/_next/…`), which the Electron protocol handler serves out of the
 *     bundle. A document-relative prefix would break the moment a route was
 *     nested — `/dashboard/projects/_next/…` does not exist.
 *   • The one dynamic segment is pre-rendered under a placeholder id, and the
 *     protocol handler folds every real project id onto it (see
 *     desktop/src/main/protocol-rules.ts `rewriteAppPath`). The URL is left
 *     untouched, so the page still reads its real id from `location.pathname`.
 *
 * Nothing here affects the website's own `next.config.ts`.
 */
const repoRoot = path.resolve(__dirname, "../..");

const nextConfig: NextConfig = {
  output: "export",
  distDir: ".next",
  images: { unoptimized: true },
  // Two lockfiles exist in this repo (root + services); pin both roots at THIS
  // app so tracing and Turbopack resolve from the repo, not a parent folder.
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
