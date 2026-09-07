import 'server-only';

import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireSupabaseEnv } from '@/lib/supabase/env';
import type { Database } from '@/lib/supabase/database.types';

/**
 * Typed against the generated schema, following the same convention as
 * `ProfileClient` and `JobsClient`. This is not cosmetic: it is what makes a
 * mistyped column name in an administrator query a build failure rather than a
 * runtime `GenericStringError`, and it means regenerating types after a
 * migration immediately surfaces every query this file broke.
 */
export type AdminClient = SupabaseClient<Database>;

/**
 * The privileged Supabase client. Server-only, and deliberately awkward to use.
 *
 * `import 'server-only'` is the load-bearing line: if any file reachable from a
 * Client Component ever imports this module, the build FAILS rather than
 * shipping the secret key to a browser. That is the difference between a
 * convention and a guarantee, and it is why the key is read here and nowhere
 * else.
 *
 * This client bypasses Row Level Security entirely. It exists because two
 * things genuinely require it and cannot be done any other way:
 *
 *   1. `auth.users` is not exposed to the Data API at all. Listing, inviting
 *      and deleting accounts is only possible through the Auth admin API,
 *      which requires the secret key.
 *   2. An administrator reads across users by definition, and every policy in
 *      migrations 7, 13 and 15 is `auth.uid() = user_id`.
 *
 * The alternative — adding an "or the caller is an admin" clause to the RLS
 * policy on every user table — was rejected. It would put an admin bypass on
 * `profiles`, `jobs`, `applications` and everything else, so a single mistake
 * in that predicate would expose every user's data through PostgREST to any
 * signed-in browser. Keeping the elevation in server code confines it to
 * handlers that have already called `requireAdmin()`.
 *
 * RULES, enforced by review and by scripts/test-admin-authorization.mjs:
 *   * Never call this before `requireAdmin()` has returned successfully.
 *   * Never use it for an operation the caller's own session could perform.
 *     Ordinary user work goes through `lib/supabase/server.ts` and RLS.
 *   * Never let a value derived from it reach the client without filtering it
 *     through an explicit projection (see lib/admin/queries.ts).
 */

export const SUPABASE_SECRET_KEY_VAR = 'SUPABASE_SECRET_KEY';

export class SupabaseAdminConfigError extends Error {
  constructor() {
    super(
      `The administrator surface is not configured. Missing environment variable: ` +
        `${SUPABASE_SECRET_KEY_VAR}. Set it as a server-side (non-public) variable in the ` +
        `Vercel project settings and in .env.local for local development, then redeploy. ` +
        `It must never be prefixed NEXT_PUBLIC_.`
    );
    this.name = 'SupabaseAdminConfigError';
  }
}

/** Whether the privileged client can be constructed. */
export function isAdminConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SECRET_KEY);
}

/**
 * Build a service-role client.
 *
 * Created per call rather than memoised at module scope: a module-level client
 * would be constructed during prerender of any route that imports this file,
 * and would throw at build time in an environment without the key.
 *
 * Sessions are explicitly disabled. The service key is not a user session and
 * must never be persisted, refreshed, or written into a cookie store.
 */
export function createAdminClient(): AdminClient {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new SupabaseAdminConfigError();

  // Reuses the same URL the public client uses, so the two can never point at
  // different projects.
  const { url } = requireSupabaseEnv();

  return createSupabaseClient<Database>(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'X-Client-Info': 'kiasa-admin' },
    },
  });
}
