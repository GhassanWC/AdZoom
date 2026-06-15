import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/branding";

/**
 * PWA manifest. Auto-served by Next.js at `/manifest.webmanifest`.
 *
 * Icons are the Framevo mark generated into /public by scripts/gen-icons.mjs:
 * maskable 192/512 PNGs for Android install + home-screen, the scalable SVG
 * for any size, and apple-icon for iOS "Add to Home Screen".
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
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
