// Server layout so this client page gets its own tab title (metadata only works in Server Components).
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Alerts", description: "What happened in the room and what was done about it, newest first." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
