import type { Metadata, Viewport } from "next";
import { Inter, Sora } from "next/font/google";
import { MotionConfig } from "framer-motion";
import "./globals.css";
import { NoiseOverlay } from "@/components/ui/NoiseOverlay";
import { AuthProvider } from "@/lib/firebase/AuthProvider";
import { ToastProvider } from "@/components/ui/Toast";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { ThemeProvider, themeInitScript } from "@/lib/theme";
import { AnalyticsProvider } from "@/components/analytics/AnalyticsProvider";
import { ChatWidget } from "@/components/chat/ChatWidget";
import { BRAND } from "@/lib/branding";
import { SITE } from "@/lib/seo";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  // Plain default title (no `template`): every public page already sets a full
  // "<Page> — Framevo" title, so a template would double the suffix. Per-page
  // canonical is set by each page via `buildMetadata` (not inherited here, which
  // would point every page at "/").
  title: SITE.title,
  description: SITE.description,
  applicationName: BRAND.name,
  keywords: [...SITE.keywords],
  robots: { index: true, follow: true },
  // Framevo icons served from /public (see scripts/gen-icons.mjs). Listed
  // explicitly so the rendered <head> points crawlers at the Framevo mark —
  // .ico for legacy/Google search, .svg for modern browsers, .png fallback,
  // apple-icon for iOS. (The old create-next-app default favicon.ico was
  // removed from src/app to stop Google showing the wrong logo.)
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/favicon.ico"],
  },
  openGraph: {
    title: SITE.title,
    description: SITE.description,
    url: SITE.url,
    siteName: BRAND.name,
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE.title,
    description: SITE.description,
    site: SITE.twitter,
    creator: SITE.twitter,
  },
};

export const viewport: Viewport = {
  themeColor: BRAND.colors.themeColor,
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${sora.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="relative min-h-full bg-ink text-white/90 selection:bg-violet-500/35">
        <NoiseOverlay />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:rounded-md focus:bg-violet-500 focus:px-4 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to content
        </a>
        <ThemeProvider>
          <AuthProvider>
            <AnalyticsProvider>
              <ToastProvider>
                <ConfirmProvider>
                  {/* Respect prefers-reduced-motion across all framer-motion
                      animations (landing loops, overlays, transitions). */}
                  <MotionConfig reducedMotion="user">
                    {children}
                    <ChatWidget />
                  </MotionConfig>
                </ConfirmProvider>
              </ToastProvider>
            </AnalyticsProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
