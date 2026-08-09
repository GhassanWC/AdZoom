import type { Metadata, Viewport } from "next";
import { Inter, Sora } from "next/font/google";
import { MotionConfig } from "framer-motion";
import "./globals.css";
import { AuthProvider } from "@/lib/firebase/AuthProvider";
import { PlatformProvider } from "@/lib/platform";
import { ToastProvider } from "@/components/ui/Toast";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { ThemeProvider, themeInitScript } from "@/lib/theme";
import { BRAND } from "@/lib/branding";

/**
 * The desktop shell's root layout.
 *
 * It mirrors the website's layout (same fonts, same theme bootstrap, same
 * providers, same body classes) with two deliberate omissions:
 *
 *   • ChatWidget      — support chat is a hosted feature; in a local-first app
 *                       it would render a control that cannot work offline.
 *   • AnalyticsProvider — no page-view telemetry from the desktop app.
 *
 * Everything else is the shared component tree, imported through `@/`.
 */
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Framevo",
  description: `${BRAND.name} desktop`,
};

export const viewport: Viewport = {
  themeColor: BRAND.colors.themeColor,
  colorScheme: "dark",
};

export default function DesktopRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${sora.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      {/*
        NO `overflow-hidden` here — that is not a styling choice, it decides
        whether the app scrolls at all. `<html>` is `visible`, so the viewport
        takes its overflow from `<body>`; hidden there meant Projects (3835px of
        content in an 800px window) could not be reached by the wheel, the
        keyboard, or a scrollbar, because there was none. The website's body has
        never carried it, which is why the same pages scroll fine in a browser.
        The editor keeps its own no-page-scroll contract through its fixed-height
        layout, not through a rule that freezes every other screen.
      */}
      <body className="relative min-h-full bg-ink text-white/90 selection:bg-violet-500/35">
        <ThemeProvider>
          <AuthProvider>
            <PlatformProvider>
              <ToastProvider>
                <ConfirmProvider>
                  <MotionConfig reducedMotion="user">{children}</MotionConfig>
                </ConfirmProvider>
              </ToastProvider>
            </PlatformProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
