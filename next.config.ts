import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets the Playwright suite (127.0.0.1:3100) and a second device on the
  // local network reach the Turbopack dev server without the cross-origin
  // dev-resource warning Next.js 16 raises by default (DEC-08 multi-device).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
