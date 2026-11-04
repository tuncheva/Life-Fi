// Server layout so this client page gets its own tab title (metadata only works in Server Components).
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Settings", description: "Room name, phone notifications, PIN and server settings." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
