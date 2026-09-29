import 'server-only';

import { cache } from 'react';

import { createJobBoardClient } from '@/lib/jobboard/client';

/**
 * Whose postings does this KIASA user see on /job-board? Their own, and only
 * their own.
 *
 * The two projects share no `auth.users`, so the only thing tying a KIASA
 * account to an extension account is the email address. This resolves the
 * extension's `auth.users.id` for the caller's email, and every candidate query
 * then filters `saved_jobs.user_id` on it.
 *
 * FAILS CLOSED, in every direction:
 *
 *   * The KIASA email must be confirmed. An unconfirmed address is a string
 *     somebody typed, and matching on it would hand them whoever owns it.
 *   * The extension account must be confirmed as well, for the same reason in
 *     the other direction — an unverified extension signup must not be able to
 *     plant postings on somebody else's board.
 *   * Exactly one match. Zero is "no extension account"; more than one should
 *     be impossible and is treated as no match rather than a guess.
 *   * A failed lookup is no match. It never degrades to "show everything".
 *
 * NOTE: both confirmations are only as strong as the project that set them. A
 * project with auto-confirm on marks every address confirmed at signup, so the
 * matching Supabase setting ("Confirm email") must be on in BOTH projects.
 */

/** Page size for the admin user listing; GoTrue's own maximum. */
const PER_PAGE = 1000;
/** Upper bound on pages walked, so a runaway listing cannot hang a request. */
const MAX_PAGES = 50;

export type JobBoardOwner =
  | { readonly ok: true; readonly ownerId: string }
  | { readonly ok: false; readonly reason: 'unverified_email' | 'no_extension_account' | 'lookup_failed' };

const normalise = (email: string) => email.trim().toLowerCase();

interface KiasaUser {
  readonly email?: string | null;
  readonly email_confirmed_at?: string | null;
}

/** Takes the KIASA session's user. Keyed on primitives so React `cache()` hits. */
export function resolveJobBoardOwner(user: KiasaUser): Promise<JobBoardOwner> {
  return resolveByEmail(user.email_confirmed_at ? (user.email ?? null) : null);
}

const resolveByEmail = cache(async (email: string | null): Promise<JobBoardOwner> => {
  if (!email) return { ok: false, reason: 'unverified_email' };

  const wanted = normalise(email);

  try {
    const client = createJobBoardClient();
    const matches: string[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error } = await client.auth.admin.listUsers({ page, perPage: PER_PAGE });
      if (error) return { ok: false, reason: 'lookup_failed' };

      for (const candidate of data.users) {
        if (
          candidate.email &&
          candidate.email_confirmed_at &&
          normalise(candidate.email) === wanted
        ) {
          matches.push(candidate.id);
        }
      }

      if (data.users.length < PER_PAGE) break;
      if (page === MAX_PAGES) return { ok: false, reason: 'lookup_failed' };
    }

    if (matches.length !== 1) return { ok: false, reason: 'no_extension_account' };
    return { ok: true, ownerId: matches[0] };
  } catch {
    return { ok: false, reason: 'lookup_failed' };
  }
});
