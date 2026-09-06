import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { requireSupabaseEnv } from '@/lib/supabase/env';

/**
 * Supabase client for Server Components, Route Handlers and Server Actions.
 *
 * Must be created per request — never hoisted to a module-level singleton — as
 * it closes over that request's cookie store.
 */
export async function createClient() {
  const { url, key } = requireSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot mutate cookies. This is expected and safe:
          // proxy.ts refreshes the session on every request, so the refreshed
          // cookies are written there instead.
        }
      },
    },
  });
}
