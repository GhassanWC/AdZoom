import Link from "next/link";
import { Container } from "@/components/ui/Container";
import { Logo } from "./Logo";

const columns: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "Presets", href: "#" },
      { label: "Pricing", href: "#pricing" },
      { label: "Changelog", href: "#" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Docs", href: "#" },
      { label: "Tutorials", href: "#" },
      { label: "Templates", href: "#" },
      { label: "API", href: "#" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "#" },
      { label: "Blog", href: "#" },
      { label: "Careers", href: "#" },
      { label: "Contact", href: "#" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "#" },
      { label: "Terms", href: "#" },
      { label: "Security", href: "#" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative border-t border-white/[0.06] py-16">
      <Container>
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-4 lg:grid-cols-6">
          <div className="col-span-2">
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-fog">
              Cinematic screen recordings, automatically. Built for creators
              who ship.
            </p>
          </div>

          {columns.map((c) => (
            <div key={c.title}>
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fog">
                {c.title}
              </h4>
              <ul className="mt-4 space-y-2.5">
                {c.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-white/75 transition-colors duration-200 hover:text-white"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-4 border-t border-white/[0.06] pt-8 text-sm text-fog sm:flex-row sm:items-center">
          <span>© {new Date().getFullYear()} AdZoom Labs, Inc.</span>
          <div className="flex items-center gap-1">
            <SocialLink href="#" label="X / Twitter">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </SocialLink>
            <SocialLink href="#" label="GitHub">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 .5a11.5 11.5 0 0 0-3.635 22.41c.575.107.785-.25.785-.554v-1.93c-3.2.695-3.875-1.54-3.875-1.54-.523-1.33-1.278-1.685-1.278-1.685-1.045-.715.08-.7.08-.7 1.155.082 1.762 1.187 1.762 1.187 1.027 1.76 2.695 1.252 3.353.958.104-.745.402-1.252.732-1.54-2.555-.29-5.243-1.278-5.243-5.69 0-1.258.45-2.286 1.187-3.092-.12-.292-.515-1.467.112-3.057 0 0 .967-.31 3.17 1.18a11 11 0 0 1 5.768 0c2.2-1.49 3.167-1.18 3.167-1.18.63 1.59.234 2.765.115 3.057.74.806 1.184 1.834 1.184 3.092 0 4.42-2.693 5.397-5.258 5.682.413.357.78 1.06.78 2.137v3.168c0 .308.207.667.79.553A11.5 11.5 0 0 0 12 .5z" />
              </svg>
            </SocialLink>
            <SocialLink href="#" label="YouTube">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
              </svg>
            </SocialLink>
          </div>
        </div>
      </Container>
    </footer>
  );
}

function SocialLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      className="inline-flex size-9 items-center justify-center rounded-full border border-transparent text-fog transition-all duration-200 hover:border-white/10 hover:bg-white/[0.04] hover:text-white"
    >
      {children}
    </a>
  );
}
