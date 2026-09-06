import { missingSupabaseEnv } from '@/lib/supabase/env';

/**
 * Shown instead of a form when Supabase is not configured.
 *
 * Names only the *variables that are absent* — never a value, and never any
 * other server state. That is enough to fix a deployment without turning the
 * page into an information leak.
 */
export default function ConfigNotice() {
  const missing = missingSupabaseEnv();

  return (
    <div className="kauth__done">
      <p className="kauth__alert" role="alert">
        Sign-in is unavailable: the server is not configured.
      </p>
      <p>
        {missing.length === 1
          ? 'A required environment variable is missing:'
          : 'Required environment variables are missing:'}
      </p>
      <ul className="kauth__hint">
        {missing.map((name) => (
          <li key={name}>
            <code>{name}</code>
          </li>
        ))}
      </ul>
      <p className="kauth__hint">
        Set these in the Vercel project settings (and in <code>.env.local</code> for local
        development), then redeploy.
      </p>
    </div>
  );
}
