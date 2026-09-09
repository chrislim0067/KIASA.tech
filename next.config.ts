import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // `unpdf` wraps a serverless build of pdf.js. Bundling it can rewrite the
  // dynamic imports it uses to find its own worker and character maps, which
  // then fails at RUNTIME rather than at build time — the worst place to
  // discover it. Left external, it is required from node_modules as published.
  serverExternalPackages: ['unpdf'],

  // The floating dev badge overlaps the page bottom-left and shows up in
  // screenshot comparisons; the real site has nothing there.
  devIndicators: false,

  // Next 16 blocks dev-only resources (including the HMR socket) for any origin
  // it does not recognise. Opening the site on 127.0.0.1 rather than localhost
  // otherwise fails the HMR handshake, and the Turbopack client then never
  // hydrates — the page renders but no client component mounts, so none of the
  // legacy scripts run. Allow both spellings of loopback and the LAN address.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],

  // The extracted pages ship their own hand-written markup; Next's image
  // optimiser is deliberately kept out of the path so <img> output is identical.
  images: { unoptimized: true },

  async rewrites() {
    // The shipped client code calls the PHP paths literally (wt-track.js has
    // CAPI_URL = '/api/track.php'). Preserving those URLs means zero changes to
    // any page script; the handlers live at clean routes behind them.
    return [
      { source: '/api/track.php', destination: '/api/track' },
      { source: '/api/lead.php', destination: '/api/lead' },
      { source: '/api/estimate.php', destination: '/api/estimate' },
      { source: '/api/blog-posts.php', destination: '/api/blog-posts' },
    ];
  },
};

export default nextConfig;
