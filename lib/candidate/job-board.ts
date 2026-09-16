import 'server-only';

import { cache } from 'react';

import { resolveCandidate } from '@/lib/candidate/session';
import { isAdminRole } from '@/lib/auth/roles';
import { getCallerRole } from '@/lib/admin/guard';
import {
  DEFAULT_JOB_BOARD_ACCESS,
  canSeeJobBoard,
  isJobBoardStatus,
  type JobBoardStatus,
} from '@/lib/auth/job-board';

/**
 * May this candidate read the shared job board?
 *
 * Two conditions, and BOTH must hold:
 *
 *   1. They are an approved KIASA candidate — `resolveCandidate()` already
 *      enforces that, and a pending or rejected account never gets here.
 *   2. Their `job_board_access` row says `granted`.
 *
 * FAILS CLOSED, three times over. No session, no row, or a failed read all
 * resolve to no access. The row is read under the candidate's OWN session, so
 * the RLS policy from migration 32 is doing the ownership check — there is no
 * elevated credential on this path and no id from a URL to get wrong.
 *
 * ADMINISTRATORS PASS WITHOUT A GRANT. They can already read every posting,
 * every owner and every private note at /admin/jobs; requiring a grant to see
 * the strictly smaller candidate view would be a gate that protects nothing and
 * a support question waiting to happen. The check is still a capability check,
 * not a role comparison — see `lib/auth/roles.ts`.
 *
 * Wrapped in React `cache()` so the page, the nav and anything else asking in
 * the same request share one round trip.
 */

export interface JobBoardAccess {
  readonly allowed: boolean;
  readonly status: JobBoardStatus;
  /** True when access comes from being an administrator rather than a grant. */
  readonly viaAdmin: boolean;
}

const DENIED: JobBoardAccess = Object.freeze({
  allowed: false,
  status: DEFAULT_JOB_BOARD_ACCESS,
  viaAdmin: false,
});

export const resolveJobBoardAccess = cache(async (): Promise<JobBoardAccess> => {
  const candidate = await resolveCandidate();
  if (!candidate.ok) return DENIED;

  const { supabase, user } = candidate.session;

  const { data, error } = await supabase
    .from('job_board_access')
    .select('status')
    .eq('user_id', user.id)
    .maybeSingle();

  const status =
    !error && data && isJobBoardStatus(data.status) ? data.status : DEFAULT_JOB_BOARD_ACCESS;

  if (canSeeJobBoard(status)) return { allowed: true, status, viaAdmin: false };

  // Only asked once the grant has already said no, so an ordinary candidate
  // costs one query rather than two. `getCallerRole()` shares this request's
  // cached auth round trip and answers about the caller, never about an id.
  const { role } = await getCallerRole();
  if (isAdminRole(role)) return { allowed: true, status, viaAdmin: true };

  return { allowed: false, status, viaAdmin: false };
});
