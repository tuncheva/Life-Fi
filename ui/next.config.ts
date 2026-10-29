import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export, served by the server from ui/out (plan-v2 §8).
  // `next dev` ignores this and runs the normal dev server on :3000.
  output: "export",
  // `/alerts` -> `out/alerts/index.html`, which the server's static handler serves.
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
