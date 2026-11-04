// Server layout so this client page gets its own tab title (metadata only works in Server Components).
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Source & replay", description: "Show the live sensor, or play back a recording. A replay is always marked on every page." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
