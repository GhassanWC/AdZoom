import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/branding";

/**
 * PWA manifest. Auto-served by Next.js at `/manifest.webmanifest`.
 *
 * The single SVG icon at `/icon.svg` (handled by Next.js's automatic
 * `app/icon.svg` convention) covers every modern browser at any size —
 * we declare it with `sizes: "any"` and the SVG type so Chrome / Edge
 * / Safari pick it for install prompts and home-screen pins.
 *
 * No apple-touch-icon yet (iOS expects a PNG). When you have a Framevo
 * PNG render of the mark, add `app/apple-icon.png` (Next.js auto-wires
 * it) and iOS will use it for "Add to Home Screen".
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.shortName,
    description: BRAND.tagline,
    start_url: "/",
    display: "standalone",
    background_color: BRAND.colors.backgroundDark,
    theme_color: BRAND.colors.themeColor,
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
