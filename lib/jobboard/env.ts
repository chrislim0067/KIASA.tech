/**
 * Environment access for the JOB BOARD Supabase project.
 *
 * This is a SECOND Supabase project, distinct from the one every other module
 * in this app talks to. It belongs to the browser extension that saves
 * postings; KIASA reads it and never writes to it.
 *
 * WHY BOTH VARIABLES ARE SERVER-SIDE
 *
 * Neither is `NEXT_PUBLIC_`, and that is deliberate. `saved_jobs` is protected
 * by `auth.uid() = user_id` in its own project, and a KIASA administrator holds
 * no session there — their session belongs to KIASA's project, whose `auth.uid()`
 * means nothing across the boundary. So an administrator reading other people's
 * rows can only do it with the secret key, and a secret key may never be
 * inlined into a browser bundle. Everything that touches this project therefore
 * runs on the server, including the realtime subscription (see
 * `app/api/admin/jobs/stream/route.ts`).
 *
 * Errors name the variable that is missing, never its value.
 */

export const JOBBOARD_URL_VAR = 'JOBBOARD_SUPABASE_URL';
export const JOBBOARD_SECRET_KEY_VAR = 'JOBBOARD_SUPABASE_SECRET_KEY';

export class JobBoardConfigError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `The job board is not configured. Missing environment variable(s): ${missing.join(', ')}. ` +
        `Set them as server-side (non-public) variables in the Vercel project settings and in ` +
        `.env.local for local development, then redeploy. Neither may be prefixed NEXT_PUBLIC_.`
    );
    this.name = 'JobBoardConfigError';
    this.missing = missing;
  }
}

/**
 * Read as full literal property accesses rather than a dynamic lookup, for the
 * same reason `lib/supabase/env.ts` does: it keeps the two files the same shape
 * even though only that one is subject to build-time inlining.
 */
function readEnv() {
  return {
    url: process.env.JOBBOARD_SUPABASE_URL,
    secret: process.env.JOBBOARD_SUPABASE_SECRET_KEY,
  };
}

/** Which required variables are absent. Empty array means fully configured. */
export function missingJobBoardEnv(): string[] {
  const { url, secret } = readEnv();
  const missing: string[] = [];
  if (!url) missing.push(JOBBOARD_URL_VAR);
  if (!secret) missing.push(JOBBOARD_SECRET_KEY_VAR);
  return missing;
}

export function isJobBoardConfigured(): boolean {
  return missingJobBoardEnv().length === 0;
}

/** Throws {@link JobBoardConfigError} when either variable is absent. */
export function requireJobBoardEnv(): { url: string; secret: string } {
  const { url, secret } = readEnv();
  const missing = missingJobBoardEnv();
  if (missing.length || !url || !secret) throw new JobBoardConfigError(missing);
  return { url, secret };
}
