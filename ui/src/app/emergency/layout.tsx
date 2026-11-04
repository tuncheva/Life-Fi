// Server layout so this client page gets its own tab title (metadata only works in Server Components).
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Emergency demo", description: "Prototype: a simulated building, not connected to sensors." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
