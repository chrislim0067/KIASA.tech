'use server';

import { revalidatePath } from 'next/cache';

import { requireCandidate } from '@/lib/candidate/session';
import { submitJob, fetchJob, extractJob, createSafeFetcher } from '@/lib/jobs';
import type { FormState } from '@/lib/candidate/form-state';

/*
 * A local constant rather than an import: a 'use server' module may EXPORT only
 * async functions, and a shared routes module would be one more thing for this
 * boundary to depend on. The path appears once.
 */
const JOBS_ROUTE = '/jobs';

/**
 * Adding a job posting, as one server action.
 *
 * EVERYTHING SECURITY-CRITICAL HERE ALREADY EXISTS, and this file deliberately
 * adds none of it. `lib/jobs/url.ts` decides which URLs are usable and what
 * their canonical form is, `lib/jobs/fetcher.ts` refuses loopback, RFC 1918,
 * link-local (including the 169.254.169.254 metadata address), carrier-grade
 * NAT and IPv4-mapped IPv6 before a connection is opened, and bounds the
 * timeout, the body size, the redirect count and the content type.
 * `lib/jobs/operations.ts` owns the writes and the ownership checks. This is
 * the candidate-facing door onto that, and nothing more.
 *
 * WHY IT RUNS SYNCHRONOUSLY
 *
 * Submit, fetch and extract happen in one request so the person gets an answer
 * rather than a row that silently never progresses. The fetch is bounded at
 * fifteen seconds by `FETCH_DEFAULTS`, well inside a function's budget. If a
 * later milestone adds background re-fetching, the state machine in
 * `lib/jobs/state.ts` is already the place for it.
 *
 * WHAT THIS ACTION WILL NOT DO
 *
 * It does not apply for anything. There is no submission path here, no employer
 * login, no form filling, and no scoring — those are later milestones with
 * their own safety requirements. It reads a public posting the candidate chose
 * and stores a bounded record of it.
 */

/**
 * A failed fetch or extraction is NOT a failed submission.
 *
 * The job row exists and is the candidate's; only the reading of the page went
 * wrong. Saying "added, but the page could not be read" is both true and
 * actionable, where "failed" would invite them to add it again and get a
 * deduplicated row telling them nothing.
 */
const PARTIAL =
  'Added. The page could not be read automatically, so the details are blank — ' +
  'you can still open the original link.';

export async function addJobUrl(_prev: FormState, form: FormData): Promise<FormState> {
  const { supabase, user } = await requireCandidate();

  const raw = form.get('url');
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (url === '') return { ok: false, message: 'Paste the link to a job posting.' };

  // Bounded before anything parses it. A URL longer than this is not a link
  // someone copied from a job board.
  if (url.length > 2048) {
    return { ok: false, message: 'That link is too long to be a job posting.' };
  }

  /*
   * HTTPS ONLY — a POLICY, not a second copy of the URL rules.
   *
   * `canonicaliseUrl` deliberately accepts both schemes, because http and
   * https are different origins and collapsing them would merge two distinct
   * postings. That is right for canonicalisation and wrong for a door: a job
   * posting worth storing is served over TLS, and a plain-http link is either
   * a mistake or an attempt to have us fetch something in the clear.
   *
   * The address rules stay where they belong. This does not resolve DNS, does
   * not inspect a host, and does not know what a private range is —
   * `checkHost` does all of that at fetch time, on the RESOLVED address, which
   * is the only place it can be done safely.
   */
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, message: 'Job links must start with https://.' };
  }

  const actor = { type: 'human' as const, id: user.id };

  /*
   * IDEMPOTENT BY CANONICAL URL. `submitJob` returns the EXISTING job when the
   * same posting is added twice, so a double-click or a retry produces one row
   * and one honest answer rather than a duplicate or an error.
   */
  const submitted = await submitJob(supabase, user.id, { url, source: 'user_link' }, actor);
  if (!submitted.ok) {
    // The data layer's message is written for a candidate and is bounded; the
    // code and any detail stay on the server.
    return { ok: false, message: submitted.error.message };
  }

  const { job, deduplicated } = submitted.data;

  const fetched = await fetchJob(supabase, user.id, job.id, createSafeFetcher(), actor);
  if (!fetched.ok) {
    revalidatePath(JOBS_ROUTE);
    return { ok: true, message: PARTIAL };
  }

  const extracted = await extractJob(supabase, user.id, job.id, fetched.data.snapshot.id, actor);

  revalidatePath(JOBS_ROUTE);
  if (!extracted.ok) return { ok: true, message: PARTIAL };

  return {
    ok: true,
    message: deduplicated
      ? 'You had already added that posting — it is in your list.'
      : 'Added.',
  };
}

