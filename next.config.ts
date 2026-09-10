import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  poweredByHeader: false,
  trailingSlash: false,
  // The original site was served without trailing slashes but the sitemap uses them.
  async redirects() {
    return [];
  },
  async headers() {
    return [
      {
        // Engine, models, textures and audio never change: cache aggressively.
        source: '/:prefix(engine|cdn|basis|draco|fonts|audio|top)/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default nextConfig;
