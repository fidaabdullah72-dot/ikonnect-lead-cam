import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Monorepo: resolve the shared package and hoisted node_modules from the repo root.
  turbopack: { root: path.join(import.meta.dirname, '..') },
  outputFileTracingRoot: path.join(import.meta.dirname, '..'),
  transpilePackages: ['@batsols/shared'],
  poweredByHeader: false,
  devIndicators: { position: 'bottom-right' },
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '*.supabase.co' }],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
