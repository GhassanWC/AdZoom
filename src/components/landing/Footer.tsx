import Link from "next/link";
import { Container } from "@/components/ui/Container";
import { Logo } from "./Logo";

/**
 * Minimal Shipper-style footer. The dramatic CTA panel above carries
 * the closing energy; this footer is a quiet utility row — logo +
 * tagline on the left, inline nav links across the middle, socials
 * and copyright on the right. No tall column grid.
 *
 * All previously-distinct columns (Resources / Company / Legal) are
 * flattened into a single horizontal link row so the page ends on
 * whitespace rather than a wall of headings.
 */

const INLINE_LINKS: { label: string; href: string }[] = [
  { label: "Features", href: "/features" },
  { label: "Use cases", href: "/use-cases" },
  { label: "Screen recording editor", href: "/screen-recording-editor" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
  { label: "Tutorials", href: "/tutorials" },
  { label: "Templates", href: "/templates" },
  { label: "API", href: "/api-reference" },
  { label: "About", href: "/about" },
  { label: "Blog", href: "/blog" },
  { label: "Careers", href: "/careers" },
  { label: "Changelog", href: "/changelog" },
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Security", href: "/security" },
];

export function Footer() {
  return (
    <footer className="relative border-t border-white/[0.06] py-12">
      <Container>
        {/* Brand + tagline. The contact surface lives in the floating
            chat widget (see src/components/chat/ChatWidget.tsx) so the
            footer stays a quiet utility row. */}
        <div>
          <Logo />
          <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-fog">
            The AI video editor for demos, tutorials, walkthroughs, and social
            clips. Auto cuts, zooms, speed-ups, and format-ready exports.
          </p>
        </div>

        {/* Inline link row + copyright */}
        <div className="mt-10 flex flex-col-reverse items-start gap-5 border-t border-white/[0.06] pt-6 text-[12.5px] text-fog md:flex-row md:items-center md:justify-between">
          <span>© {new Date().getFullYear()} Framevo Labs, Inc.</span>
          <nav
            aria-label="Footer"
            className="flex flex-wrap items-center gap-x-5 gap-y-2"
          >
            {INLINE_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-fog transition-colors duration-200 hover:text-white"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </Container>
    </footer>
  );
}
