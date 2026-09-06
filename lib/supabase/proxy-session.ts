import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

import { isSupabaseConfigured, requireSupabaseEnv } from '@/lib/supabase/env';
import { isAuthOnlyPath, isProtectedPath, DASHBOARD, LOGIN } from '@/lib/auth/routes';

/**
 * Refreshes the Supabase session cookie and applies coarse route policy.
 *
 * Auth tokens are short-lived, so something has to exchange the refresh token
 * and hand the browser new cookies before a Server Component reads them. That is
 * this function's real job; the redirects it performs are, per the Next docs, an
 * *optimistic* check only. The authoritative check lives in the protected page
 * itself, which calls `supabase.auth.getUser()`.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // Without Supabase configured the public marketing site must still serve
  // normally; only the private area is closed off (see below).
  if (!isSupabaseConfigured()) {
    if (isProtectedPath(request.nextUrl.pathname)) {
      const url = request.nextUrl.clone();
      url.pathname = LOGIN;
      url.search = '';
      return NextResponse.redirect(url);
    }
    return NextResponse.next({ request });
  }

  /**
   * Fast path for anonymous visitors.
   *
   * This is a marketing site: most traffic has never signed in, and there is
   * nothing to refresh for a request that carries no Supabase cookie. Without
   * this, every page view — including every crawler hit — would pay a
   * `getUser()` round trip to Supabase before rendering. Supabase stores its
   * session in cookies prefixed `sb-`; with none present the visitor is
   * definitively signed out, so the policy below can be applied directly.
   */
  const hasSessionCookie = request.cookies.getAll().some((c) => c.name.startsWith('sb-'));
  if (!hasSessionCookie) {
    if (isProtectedPath(request.nextUrl.pathname)) {
      const url = request.nextUrl.clone();
      url.pathname = LOGIN;
      url.search = '';
      url.searchParams.set('redirectTo', request.nextUrl.pathname);
      return NextResponse.redirect(url);
    }
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  const { url: supabaseUrl, key } = requireSupabaseEnv();

  const supabase = createServerClient(supabaseUrl, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Write to the request so anything later in this pass sees the new
        // cookies, then rebuild the response so they reach the browser.
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getUser() revalidates the token with Supabase. Do not replace it with
  // getSession(), which trusts whatever is in the cookie without verifying it.
  // Nothing may run between creating the client and this call.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && isProtectedPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = LOGIN;
    url.search = '';
    // Send them back where they were trying to go once they sign in.
    url.searchParams.set('redirectTo', pathname);
    return NextResponse.redirect(url);
  }

  if (user && isAuthOnlyPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = DASHBOARD;
    url.search = '';
    return NextResponse.redirect(url);
  }

  // Must return this exact response object so the refreshed cookies survive.
  return response;
}
