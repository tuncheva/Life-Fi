// Server layout so this client page gets its own tab title (metadata only works in Server Components).
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Set up this room", description: "About five minutes. Each step checks itself; you can come back to any of them later." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
