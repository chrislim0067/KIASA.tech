import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

import { isSupabaseConfigured, requireSupabaseEnv } from '@/lib/supabase/env';
import { isAuthOnlyPath, isProtectedPath, DASHBOARD, LOGIN } from '@/lib/auth/routes';
import { isAdminPath } from '@/lib/auth/roles';

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

  /**
   * Turn away non-administrators at the door, with a real HTTP redirect.
   *
   * This is NOT the authorization boundary — `requireAdminPage()` in every
   * /admin page still is, and still runs. This exists because the admin routes
   * have a `loading.tsx`, which makes Next stream them: the response commits as
   * 200 with the skeleton before the page's `redirect()` is reached, so an
   * unauthorized visitor got 200-then-a-redirect-inside-the-stream instead of a
   * clean 307. No data leaked — the skeleton holds none — but an authorization
   * boundary should be observable at the HTTP layer, not only to a client that
   * executes the streamed payload. A test caught the change; this restores it.
   *
   * Cost is one indexed lookup, and only on /admin paths. It also makes the
   * unauthorized case *faster*: they are turned around before the route runs
   * any of its queries.
   */
  if (user && isAdminPath(pathname)) {
    const { data } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .maybeSingle();

    // Absence means the ordinary role, and a failed read resolves the same way
    // — the identical fail-closed rule the page-level check uses.
    if (data?.role !== 'admin') {
      const url = request.nextUrl.clone();
      url.pathname = DASHBOARD;
      url.search = '';
      return NextResponse.redirect(url);
    }
  }

  // Keep authenticated pages out of every cache, including the back/forward
  // cache. Without this, pressing Back after signing out can redisplay the
  // rendered dashboard from the browser's own store even though the session is
  // gone and the server would now refuse it.
  if (isProtectedPath(pathname)) {
    response.headers.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
  }

  // Must return this exact response object so the refreshed cookies survive.
  return response;
}
