import os from "node:os";
import type { NextConfig } from "next";

/**
 * Origins allowed to fetch /_next/* assets and open the dev HMR websocket.
 *
 * Next rejects those requests from origins it doesn't know about, and when the
 * HMR websocket is rejected the dev client retries 12 times and then calls
 * location.reload() (next/dist/client/dev/hot-reloader/app/web-socket.js).
 * That reload resets the retry counter, so the tab keeps refreshing on its own
 * — roughly every 40s. FluxDrop is routinely opened from this machine's LAN
 * address, so resolve the local IPv4 addresses at startup instead of
 * hard-coding whichever one DHCP handed out.
 */
function lanDevOrigins(): string[] {
  const addresses: string[] = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      addresses.push(info.address);
    }
  }
  return addresses;
}

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.space-z.ai", ...lanDevOrigins()],
  // Hide the dev-tools badge — it overlays the UI and pollutes PWA screenshots.
  devIndicators: false,
};

export default nextConfig;
