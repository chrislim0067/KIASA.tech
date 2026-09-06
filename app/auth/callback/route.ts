import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';

import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { DEFAULT_AFTER_AUTH, LOGIN, safeRedirectTarget } from '@/lib/auth/routes';

/**
 * Single landing point for every link Supabase emails out: signup confirmation,
 * magic link, email change and password recovery.
 *
 * Supabase sends one of two shapes depending on the template in use, so both are
 * handled:
 *   - `?code=…`                  PKCE — exchange it for a session
 *   - `?token_hash=…&type=…`     OTP  — verify it for a session
 *
 * On success the session cookies are written by the server client and the user
 * is forwarded on. On failure we redirect to /login with a short, non-sensitive
 * reason rather than rendering Supabase's raw error.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  const failTo = (reason: string) => {
    const url = new URL(LOGIN, origin);
    url.searchParams.set('error', reason);
    return NextResponse.redirect(url);
  };

  if (!isSupabaseConfigured()) return failTo('not-configured');

  // Supabase reports link problems (expired, already used) on the query string.
  const providerError = searchParams.get('error_description') ?? searchParams.get('error');
  if (providerError) return failTo('link-invalid');

  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;

  // A recovery link must land on the form that sets a new password, not the
  // dashboard — the user arrives with a session but no password they know.
  const requested = searchParams.get('next');
  const destination =
    type === 'recovery' ? '/reset-password' : safeRedirectTarget(requested ?? DEFAULT_AFTER_AUTH);

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return failTo('link-invalid');
    return NextResponse.redirect(new URL(destination, origin));
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) return failTo('link-invalid');
    return NextResponse.redirect(new URL(destination, origin));
  }

  return failTo('link-invalid');
}
