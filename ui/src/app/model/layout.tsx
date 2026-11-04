import type { Metadata } from "next";

export const metadata: Metadata = { title: "Insights" };

export default function ModelLayout({ children }: { children: React.ReactNode }) {
  return children;
}
