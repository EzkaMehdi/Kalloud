import type { NextConfig } from "next";

/**
 * OPS-05 emits `.next/standalone` — a self-contained server carrying only the
 * dependencies it actually imports, so the production image holds no build
 * toolchain and no devDependencies. That is what makes the image reproducible
 * from the lockfile rather than from whatever happened to be installed when it
 * was built (see docs/deploiement.md).
 *
 * Vercel packages the application itself, from the default build output, and
 * its post-build step reads trace files that the standalone layout does not
 * leave where it looks for them — the build reaches "Running onBuildComplete
 * from Vercel" and then fails on a missing `.next/next-server.js.nft.json`.
 * Standalone is therefore emitted everywhere *except* there.
 *
 * `VERCEL` is set by the platform on every build and at runtime; nothing else
 * sets it, so this cannot mis-fire on the Docker image or in CI.
 */
const isVercel = Boolean(process.env.VERCEL);

const nextConfig: NextConfig = {
  ...(isVercel ? {} : { output: "standalone" as const }),
  // Lets the Playwright suite (127.0.0.1:3100) and a second device on the
  // local network reach the Turbopack dev server without the cross-origin
  // dev-resource warning Next.js 16 raises by default (DEC-08 multi-device).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
