import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { LiveProvider } from "@/lib/live";
import { TopBar } from "@/components/TopBar";
import { AlertBanner } from "@/components/AlertBanner";
import { DevPanel } from "@/components/DevPanel";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Life-Fi",
  description: "Camera-free presence, breathing and fall alerts from Wi-Fi",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <LiveProvider>
          <TopBar />
          <AlertBanner />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4">{children}</main>
          <footer className="px-4 py-3 text-center text-xs text-zinc-400">
            Assistive notification, not a medical device. Does not replace a nurse call or emergency services.
          </footer>
          <DevPanel />
        </LiveProvider>
      </body>
    </html>
  );
}
