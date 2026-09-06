'use client';

import { createBrowserClient } from '@supabase/ssr';
import { requireSupabaseEnv } from '@/lib/supabase/env';

/**
 * Supabase client for browser/client components.
 *
 * Deliberately created on demand rather than at module scope: the production
 * build runs without Supabase env vars present, and a module-level client would
 * throw during prerender of any route that imports this file. Callers create it
 * inside an event handler or effect, which only ever runs in the browser.
 *
 * `createBrowserClient` is a singleton internally, so repeated calls are cheap.
 */
export function createClient() {
  const { url, key } = requireSupabaseEnv();
  return createBrowserClient(url, key);
}
