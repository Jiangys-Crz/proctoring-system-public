import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  devIndicators: false,
  // Student and backend applications share a domain but have different chunks.
  assetPrefix: '/candidate-assets',
  async rewrites() {
    return { beforeFiles: [
      { source: '/candidate-assets/_next/static/:path*', destination: '/_next/static/:path*' },
      { source: '/candidate-assets/brand/:path*', destination: '/brand/:path*' },
    ] };
  },
  transpilePackages: ['@cwnupaa/proctor-shared'],
  experimental: { cpus: 1, webpackMemoryOptimizations: true },
};

export default nextConfig;
