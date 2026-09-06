/**
 * Supabase environment access.
 *
 * Values are read from `process.env` only — nothing is hardcoded, logged or
 * echoed back to the client. Errors name the *variable that is missing*, never
 * its value, so a misconfiguration is diagnosable without leaking anything.
 *
 * Both variables are `NEXT_PUBLIC_` and therefore safe to reach the browser:
 * the URL is public, and the publishable (anon) key is designed to be shipped to
 * clients and is constrained by Row Level Security. No secret or service-role
 * key is read here, and none may ever be used in this app's frontend.
 */

export const SUPABASE_URL_VAR = 'NEXT_PUBLIC_SUPABASE_URL';
export const SUPABASE_KEY_VAR = 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY';

export class SupabaseConfigError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Supabase is not configured. Missing environment variable(s): ${missing.join(', ')}. ` +
        `Set them in the Vercel project settings (and .env.local for local development), then redeploy.`
    );
    this.name = 'SupabaseConfigError';
    this.missing = missing;
  }
}

/**
 * Inlined at build time by Next for `NEXT_PUBLIC_` vars, so these must be
 * referenced as full literal property accesses rather than dynamic lookups.
 */
function readEnv() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  };
}

/** Which required variables are absent. Empty array means fully configured. */
export function missingSupabaseEnv(): string[] {
  const { url, key } = readEnv();
  const missing: string[] = [];
  if (!url) missing.push(SUPABASE_URL_VAR);
  if (!key) missing.push(SUPABASE_KEY_VAR);
  return missing;
}

export function isSupabaseConfigured(): boolean {
  return missingSupabaseEnv().length === 0;
}

/** Throws {@link SupabaseConfigError} when either variable is absent. */
export function requireSupabaseEnv(): { url: string; key: string } {
  const { url, key } = readEnv();
  const missing = missingSupabaseEnv();
  if (missing.length || !url || !key) throw new SupabaseConfigError(missing);
  return { url, key };
}
