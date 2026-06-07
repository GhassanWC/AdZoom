import type { Metadata } from "next";
import { Inter, Sora } from "next/font/google";
import "./globals.css";
import { NoiseOverlay } from "@/components/ui/NoiseOverlay";
import { AuthProvider } from "@/lib/firebase/AuthProvider";
import { ToastProvider } from "@/components/ui/Toast";
import { ConfirmProvider } from "@/components/ui/ConfirmDialog";
import { ThemeProvider, themeInitScript } from "@/lib/theme";
import { ChatWidget } from "@/components/chat/ChatWidget";
import { BRAND, PAGE_TITLE } from "@/lib/branding";

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
  title: PAGE_TITLE.landing,
  description: `${BRAND.longTagline} Auto-zoom, cursor focus, click highlights, motion tracking, vertical reframing — instantly.`,
  metadataBase: new URL(BRAND.url),
  openGraph: {
    title: PAGE_TITLE.landing,
    description: "Upload a screen recording. Framevo edits it with AI.",
    type: "website",
  },
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
            <ToastProvider>
              <ConfirmProvider>
                {children}
                <ChatWidget />
              </ConfirmProvider>
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
