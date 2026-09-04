import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OPS-05: emits .next/standalone — a self-contained server with only the
  // dependencies it actually imports, so the production image carries no
  // build toolchain and no devDependencies. That is what makes the image
  // reproducible from the lockfile rather than from whatever happened to be
  // installed when it was built.
  output: "standalone",
  // Lets the Playwright suite (127.0.0.1:3100) and a second device on the
  // local network reach the Turbopack dev server without the cross-origin
  // dev-resource warning Next.js 16 raises by default (DEC-08 multi-device).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
