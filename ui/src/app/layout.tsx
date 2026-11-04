import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { LiveProvider } from "@/lib/live";
import { PinProvider } from "@/lib/pin";
import { SoundProvider, SoundQuestion } from "@/lib/sound";
import { THEME_BOOT } from "@/lib/theme";
import { DISCLAIMER } from "@/lib/words";
import { TopBar } from "@/components/TopBar";
import { AlertBanner } from "@/components/AlertBanner";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  // Child segments set their own title through a small server layout.tsx.
  title: { default: "Life-Fi", template: "%s · Life-Fi" },
  applicationName: "Life-Fi",
  description: "Camera-free presence, breathing and fall alerts from Wi-Fi",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d10" },
  ],
};

// Explicit props rather than Next's generated `LayoutProps`, so `tsc --noEmit`
// also passes on a fresh checkout where `.next/types` has not been generated yet.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="flex min-h-full flex-col bg-bg text-fg">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-3 focus:font-semibold focus:shadow-lg">
          Skip to content
        </a>
        <LiveProvider>
          <PinProvider>
            <SoundProvider>
            <TopBar />
            <AlertBanner />
            <main id="main" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-4 sm:py-6">
              <SoundQuestion />
              {children}
            </main>
            <footer className="px-4 pb-16 pt-4 text-center text-xs text-subtle sm:pb-4">{DISCLAIMER} No camera, no microphone, no images.</footer>
            </SoundProvider>
          </PinProvider>
        </LiveProvider>
      </body>
    </html>
  );
}
