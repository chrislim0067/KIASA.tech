import 'server-only';

import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireJobBoardEnv } from '@/lib/jobboard/env';

/**
 * The privileged client for the JOB BOARD Supabase project.
 *
 * `import 'server-only'` is the load-bearing line, exactly as it is in
 * `lib/supabase/admin.ts`: if any file reachable from a Client Component ever
 * imports this module, the BUILD fails rather than shipping the secret key to a
 * browser. That is the difference between a convention and a guarantee.
 *
 * Untyped against a generated schema on purpose — see the note at the top of
 * `lib/jobboard/types.ts`. `npm run db:types` targets KIASA's own database, and
 * pointing it at a second project would overwrite the types this app depends on.
 * The hand-written interfaces in that file are the contract instead, applied at
 * the one place rows are read (`lib/jobboard/queries.ts`).
 *
 * WHY THE SECRET KEY AND NOT A SESSION
 *
 * `saved_jobs` is protected by `auth.uid() = user_id`. A KIASA administrator's
 * session is issued by KIASA's Supabase project and is meaningless in this one,
 * so there is no session that could read across users here — the two projects
 * do not share an `auth.users` table. Reading the board at all therefore
 * requires the secret key, which is why every path to it is server-side.
 *
 * RULES, the same ones `createAdminClient()` carries:
 *   * Never call this before `requireAdminPage()` or `guardApi()` has returned
 *     successfully.
 *   * Never let a row from it reach the client without an explicit projection.
 *     `lib/jobboard/queries.ts` owns that projection.
 *   * READ ONLY. KIASA does not own this data; the extension does. Nothing in
 *     this app writes to `saved_jobs`.
 */
export type JobBoardClient = SupabaseClient;

/**
 * Built per call rather than memoised at module scope.
 *
 * A module-level client would be constructed during prerender of any route
 * that imports this file, and would throw at build time in an environment
 * without the key — which is every preview build that has not been configured.
 *
 * Sessions are explicitly disabled. A secret key is not a user session and must
 * never be persisted, refreshed, or written into a cookie store.
 */
export function createJobBoardClient(): JobBoardClient {
  const { url, secret } = requireJobBoardEnv();

  return createSupabaseClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'X-Client-Info': 'kiasa-admin-jobboard' },
    },
  });
}
