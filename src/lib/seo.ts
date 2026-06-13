/**
 * Single source of truth for SEO — canonical site facts, a `buildMetadata`
 * helper that every public page uses for a consistent title / description /
 * canonical / Open Graph / Twitter card, and JSON-LD structured-data builders.
 *
 * Framework-light: only imports `Metadata` (type) + the brand constants.
 */
import type { Metadata } from "next";
import { BRAND } from "./branding";

export const SITE = {
  url: BRAND.url, // https://framevo.app
  name: BRAND.name, // Framevo
  title: "Framevo — AI Video Editor for Demos, Tutorials, and Social Clips",
  description:
    "Framevo helps you turn uploaded videos, screen recordings, demos, tutorials, and social clips into polished edits with AI. Add cuts, zooms, click highlights, speed-ups, and export for YouTube, TikTok, Reels, and Shorts.",
  ogImageAlt: "Framevo — AI video editor for demos, tutorials, and social clips",
  twitter: "@framevo",
  /** Natural keyword set — woven into copy, not stuffed. Primary first. */
  keywords: [
    "AI video editor",
    "AI video editor for tutorials",
    "AI product demo editor",
    "AI screen recording editor",
    "automatic video cuts",
    "video editor with auto zoom",
    "screen recording editor",
    "edit videos for TikTok and Reels",
    "AI editor for social clips",
    "YouTube tutorial editor",
  ],
} as const;

/**
 * Per-page metadata with a consistent canonical + share card. Relative
 * `path` is resolved against `metadataBase` (set in the root layout). Pass
 * `noindex` for private/auth pages.
 */
export function buildMetadata({
  title,
  description,
  path = "/",
  noindex = false,
}: {
  title: string;
  description: string;
  path?: string;
  noindex?: boolean;
}): Metadata {
  const url = path === "/" ? SITE.url : `${SITE.url}${path}`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url,
      siteName: SITE.name,
      type: "website",
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      site: SITE.twitter,
      creator: SITE.twitter,
    },
    robots: noindex
      ? { index: false, follow: false }
      : { index: true, follow: true },
  };
}

// ── JSON-LD structured data ────────────────────────────────────────────────

export function organizationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE.name,
    url: SITE.url,
    logo: `${SITE.url}/icon.svg`,
  };
}

export function websiteLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE.name,
    url: SITE.url,
  };
}

/** Free/Pro/Creator from the pricing page → schema.org Offers. */
export function softwareApplicationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE.name,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Web",
    description: SITE.description,
    url: SITE.url,
    offers: [
      { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
      { "@type": "Offer", name: "Pro", price: "19", priceCurrency: "USD" },
      { "@type": "Offer", name: "Creator", price: "49", priceCurrency: "USD" },
    ],
  };
}

export interface FaqItem {
  q: string;
  a: string;
}

export function faqLd(items: FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.q,
      acceptedAnswer: { "@type": "Answer", text: it.a },
    })),
  };
}
