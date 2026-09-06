import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

import { isSupabaseConfigured, requireSupabaseEnv } from '@/lib/supabase/env';
import { AFTER_SIGNOUT } from '@/lib/auth/routes';

/**
 * Signs out and returns the visitor to the public site.
 *
 * Deliberately a Route Handler answering a native form POST rather than a Server
 * Action ending in `redirect('/')`. A redirect from a Server Action is performed
 * as a client-side RSC navigation, and the marketing pages cannot initialise
 * that way: the hero is an ES module importing the bare specifier "three",
 * resolved by a `<script type="importmap">`. Browsers only honour an import map
 * present when the document is parsed, so on a client-side navigation it is
 * inert, the module throws "Failed to resolve module specifier", the preloader
 * is never dismissed, and the page falls back to its degraded `wt-lite` mode.
 *
 * A form POST answered with 303 makes the browser perform a real GET of "/", so
 * the homepage loads exactly as it does for any other visitor. It also means
 * sign-out works with JavaScript disabled.
 */
export async function POST(request: NextRequest) {
  const { origin } = request.nextUrl;

  // Same-origin guard. Supabase cookies are SameSite=Lax so a cross-site POST
  // would not carry them anyway, but this refuses the request outright rather
  // than letting another site drive a logout endpoint.
  const requestOrigin = request.headers.get('origin');
  if (requestOrigin && requestOrigin !== origin) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const response = NextResponse.redirect(new URL(AFTER_SIGNOUT, origin), { status: 303 });
  // Never let this hop sit in a cache; it is the boundary between an
  // authenticated and an anonymous view.
  response.headers.set('Cache-Control', 'no-store, max-age=0');

  // Nothing to end, and nothing to clear — still send the visitor home.
  if (!isSupabaseConfigured()) return response;

  const { url, key } = requireSupabaseEnv();

  // The cookie jar is this response's, so the expired auth cookies Supabase
  // writes during signOut() ride out on the 303 itself.
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Safe to repeat: signing out without a session is a no-op, so a double
  // submit or a replayed request cannot fail.
  await supabase.auth.signOut();

  return response;
}
