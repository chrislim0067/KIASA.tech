import type { Metadata } from 'next';

import ProfileShell from '@/components/profile/ProfileShell';
import JobBoardWorkspace from '@/components/jobboard/JobBoardWorkspace';
import { requireCandidate } from '@/lib/candidate/session';
import { resolveJobBoardAccess } from '@/lib/candidate/job-board';
import { listJobOpportunities } from '@/lib/jobboard/queries';
import { isJobBoardConfigured } from '@/lib/jobboard/env';
import { JOB_BOARD_LOCKED } from '@/lib/auth/job-board';
import '@/styles/job-board.css';

/**
 * /job-board — the shared pool of postings the extension has collected.
 *
 * NOT /jobs. That is the candidate's OWN list, in KIASA's own database, of
 * postings they added themselves. This is a different table in a different
 * Supabase project, and the two must never be confused in a URL.
 *
 * TWO GATES, IN ORDER, AND BOTH ON THIS PAGE
 *
 *   1. `requireCandidate()` — a session, and an approved account. A pending or
 *      rejected signup is redirected to /pending and never reaches step two.
 *   2. `resolveJobBoardAccess()` — the separate grant from migration 32. Being
 *      approved for KIASA is not being approved for this.
 *
 * Both are awaited here rather than in a layout, for the reason spelled out in
 * `lib/admin/page-guard.ts` and in this Next version's own authentication
 * guide: a layout does not re-render on client-side navigation within its
 * segment, so a check placed only there can be walked around.
 *
 * A REFUSAL IS A PANEL, NOT A 404. Somebody who has been told this page exists
 * and is sent to a "not found" learns nothing except that KIASA is broken. The
 * board's existence is not the secret — its contents are, and those are behind
 * the grant.
 *
 * WHAT THIS AUDIENCE DOES NOT SEE. `listJobOpportunities()` selects a different
 * column set from the administrator's query: no `user_id`, no `status`, no
 * `notes`. The board is a pool of openings here, not a window onto whose
 * application is where. See the note above the candidate projection in
 * `lib/jobboard/queries.ts`.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Job board | KIASA',
  // Never indexed. These are real postings collected for named people.
  robots: { index: false, follow: false, nocache: true },
};

export default async function JobBoardPage() {
  const { user } = await requireCandidate();
  const access = await resolveJobBoardAccess();

  if (!access.allowed) {
    return (
      <ProfileShell title="Job board" email={user.email ?? null} back>
        <div className="kjb__locked">
          <h2>{JOB_BOARD_LOCKED.title}</h2>
          <p>{JOB_BOARD_LOCKED.body}</p>
        </div>
      </ProfileShell>
    );
  }

  if (!isJobBoardConfigured()) {
    return (
      <ProfileShell title="Job board" email={user.email ?? null} back>
        <div className="kjb__locked">
          <h2>The job board is unavailable</h2>
          <p>
            This deployment is not connected to the job board. Nothing is wrong with your access —
            an administrator needs to finish configuring it.
          </p>
        </div>
      </ProfileShell>
    );
  }

  const { jobs, error, truncated } = await listJobOpportunities();

  return (
    <ProfileShell
      title="Job board"
      lede="Openings collected by the KIASA browser extension."
      email={user.email ?? null}
      back
    >
      {error ? (
        <div className="kjb__locked">
          <h2>The board could not be read</h2>
          {/*
            The underlying message is deliberately not shown. A candidate can do
            nothing with a PostgREST error, and it describes infrastructure they
            have no business seeing. The administrator surface prints it; this
            one does not.
          */}
          <p>Something went wrong reading the postings. Try again shortly.</p>
        </div>
      ) : (
        <JobBoardWorkspace jobs={jobs} truncated={truncated} />
      )}
    </ProfileShell>
  );
}
