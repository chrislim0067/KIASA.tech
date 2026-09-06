'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { createClient } from '@/lib/supabase/server';
import { AFTER_SIGNOUT } from '@/lib/auth/routes';

/**
 * Ends the Supabase session and returns to the public site.
 *
 * A Server Action rather than a client-side `signOut()` so the auth cookies are
 * cleared on the response itself — a browser-only sign-out leaves the httpOnly
 * cookies in place until the next refresh, and the user still looks signed in to
 * Server Components.
 */
export async function signOut(): Promise<never> {
  const supabase = await createClient();
  await supabase.auth.signOut();

  // Drop any cached render that was produced for the signed-in user.
  revalidatePath('/', 'layout');
  redirect(AFTER_SIGNOUT);
}
