import { ImageResponse } from "next/og";
import { BRAND } from "@/lib/branding";
import { SITE } from "@/lib/seo";

// Branded share card, generated at build/request time — no binary design asset.
// Applies to `/` and every route that doesn't define its own OG image.
export const alt = SITE.ogImageAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "80px",
          background: `radial-gradient(ellipse at 20% 0%, ${BRAND.colors.primaryFrom}40, transparent 55%), ${BRAND.colors.backgroundDark}`,
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: `linear-gradient(135deg, ${BRAND.colors.primaryFrom}, ${BRAND.colors.primaryTo})`,
            }}
          />
          <span style={{ fontSize: 38, fontWeight: 700, letterSpacing: -1 }}>
            {BRAND.name}
          </span>
        </div>

        {/* Headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              fontSize: 72,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -2,
              maxWidth: 1000,
            }}
          >
            Turn your videos into polished edits with AI
          </div>
          <div style={{ fontSize: 29, color: "rgba(255,255,255,0.72)", maxWidth: 960 }}>
            Cuts, zooms, speed-ups, and format-ready exports for demos,
            tutorials, walkthroughs, and social clips.
          </div>
        </div>

        {/* Footer URL */}
        <div style={{ fontSize: 26, color: "rgba(255,255,255,0.55)" }}>
          {BRAND.domain}
        </div>
      </div>
    ),
    { ...size }
  );
}
