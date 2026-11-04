// Server layout so this client page gets its own tab title (metadata only works in Server Components).
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Events", description: "Every change the sensor saw and every assistant answer, newest first." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
