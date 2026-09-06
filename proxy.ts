import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/proxy-session';

/**
 * Next.js 16 renamed Middleware to Proxy; the file must sit at the project root
 * alongside `app/`. See node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  /**
   * Run on pages only. The marketing site serves a lot of static weight from
   * public/ — /Assets (images, video, audio, the vendored JS), /generated (the
   * extracted per-page CSS and JS) and /brand — and refreshing a session on
   * those would add a Supabase round trip to every asset request for nothing.
   */
  matcher: [
    '/((?!_next/static|_next/image|Assets/|generated/|brand/|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|mp4|webm|mp3|wav|css|js|mjs|map|woff|woff2|ttf|otf)$).*)',
  ],
};
