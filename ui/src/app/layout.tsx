import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { LiveProvider } from "@/lib/live";
import { PinProvider } from "@/lib/pin";
import { SoundProvider } from "@/lib/sound";
import { THEME_BOOT } from "@/lib/theme";
import { DISCLAIMER } from "@/lib/words";
import { TopBar } from "@/components/TopBar";
import { AlertBanner } from "@/components/AlertBanner";
import { DevPanel } from "@/components/DevPanel";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Life-Fi",
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
        <LiveProvider>
          <PinProvider>
            <SoundProvider>
            <TopBar />
            <AlertBanner />
            <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:py-6">{children}</main>
            <footer className="px-4 pb-16 pt-4 text-center text-xs text-subtle sm:pb-4">{DISCLAIMER} No camera, no microphone, no images.</footer>
            <DevPanel />
            </SoundProvider>
          </PinProvider>
        </LiveProvider>
      </body>
    </html>
  );
}
