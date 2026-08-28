import type { NextConfig } from 'next';

/**
 * titan — single-process Next.js runtime (SPEC-001).
 *
 * The whole product is one Node process on one dev machine: no containers, no
 * orchestration, no external network dependency at runtime. Everything below
 * either enforces that or gets out of its way.
 *
 * Deliberately absent, and not an oversight:
 *   - no `output: 'standalone'` — there is no image to build
 *   - no remote image hosts — media is local disk under `public/uploads` (SPEC-006)
 *   - no rewrites/proxies to any external origin — there is no external origin
 *   - no custom dev port here; the port is pinned in the `dev` script so it is
 *     explicit at the call site and cannot be silently inherited from the env
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,

  // TS strictness is a hard gate (`npm run lint` runs `tsc --noEmit`), so a
  // type error must never be buildable-around.
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },

  images: {
    // Local disk only. An empty allow-list means any attempt to point
    // next/image at a third-party origin fails loudly instead of quietly
    // adding a runtime network dependency.
    remotePatterns: [],
    formats: ['image/webp'],
  },

  experimental: {
    // better-sqlite3 / prisma engines must not be traced into the client
    // bundle; they are server-only native modules.
    serverActions: {
      bodySizeLimit: '8mb',
    },
  },
};

export default nextConfig;
