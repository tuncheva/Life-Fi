// Server layout so this client page gets its own tab title (metadata only works in Server Components).
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Labelling", description: "Record a training session and mark what people do while they do it." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
