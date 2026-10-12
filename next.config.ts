import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.space-z.ai"],
  // Hide the dev-tools badge — it overlays the UI and pollutes PWA screenshots.
  devIndicators: false,
};

export default nextConfig;
