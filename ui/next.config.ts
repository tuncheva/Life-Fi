import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The backend lives here too (src/server, src/app/api/v1): `next dev` / `next start`
  // serve the dashboard and the API from one process. It reads files, SQLite and the
  // engine socket, so it needs the Node.js server, not a static export.
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
