import type { NextConfig } from 'next';

const clientWebBase = (process.env.PROCTOR_CLIENT_WEB_INTERNAL_BASE || 'http://127.0.0.1:4032').replace(/\/+$/, '');
const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  devIndicators: false,
  // ffprobe-static resolves a native executable relative to its own package.
  serverExternalPackages: ['ffprobe-static'],
  outputFileTracingIncludes: {
    '/api/exams/*/code-check*': ['./vendor/contest-code-check/**/*'],
    '/api/client/{upload,public-test-login}': ['./node_modules/ffprobe-static/bin/**/*'],
  },
  transpilePackages: ['@cwnupaa/proctor-shared'],
  async rewrites() {
    return [
      { source: '/contest/:path*', destination: `${clientWebBase}/contest/:path*` },
      { source: '/candidate', destination: `${clientWebBase}/` },
      { source: '/candidate-assets/_next/static/:path*', destination: `${clientWebBase}/_next/static/:path*` },
      { source: '/candidate-assets/brand/:path*', destination: `${clientWebBase}/brand/:path*` },
    ];
  },
  experimental: {
    cpus: 1,
    webpackMemoryOptimizations: true,
    proxyClientMaxBodySize: '90mb',
    serverActions: {
      bodySizeLimit: '90mb'
    }
  }
};

export default nextConfig;
