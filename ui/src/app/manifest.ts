// Web app manifest (Next's app/manifest.ts convention): lets a phone add the
// dashboard to its home screen as its own window.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Life-Fi",
    short_name: "Life-Fi",
    description: "Camera-free presence, breathing and fall alerts from Wi-Fi",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f6f8",
    theme_color: "#1b2027",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
