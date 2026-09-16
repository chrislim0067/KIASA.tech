import { NextResponse } from 'next/server';

import { resolveJobBoardAccess } from '@/lib/candidate/job-board';
import { isJobBoardConfigured } from '@/lib/jobboard/env';
import { jobBoardEventStream } from '@/lib/jobboard/stream';
import { logAdminError } from '@/lib/admin/api';

/**
 * GET /api/job-board/stream — the live feed behind the candidate board.
 *
 * BOTH GATES, RE-CHECKED ON EVERY CONNECTION. `resolveJobBoardAccess()` is the
 * same function the page awaits: it requires an approved KIASA account AND the
 * separate grant from migration 32, and it fails closed on absence, on a
 * malformed value and on a failed read. An administrator passes without a
 * grant, as they do on the page.
 *
 * Re-checked is the operative word. `EventSource` reopens this route after
 * every recycle, so revoking somebody's grant does not merely stop them opening
 * a new stream — their existing one dies within `maxDuration` and the reconnect
 * is refused. Access is not granted once for the lifetime of a tab.
 *
 * 403 RATHER THAN A SILENT STREAM. A caller without the grant is told so.
 * Holding the connection open and never sending anything would be
 * indistinguishable from a working feed with nothing happening, which is the
 * failure mode that made the original job board look "Live" while showing
 * nothing.
 *
 * THE RELAY IS SHARED with `/api/admin/jobs/stream` and sends both audiences
 * the identical event: an operation and a timestamp, never a row. That is what
 * lets one relay serve an administrator and a candidate without the projection
 * question arising — there is nothing in the payload to project. The candidate
 * page reacts by re-running its OWN server query, which selects the candidate
 * column set and no other.
 */

export const dynamic = 'force-dynamic';

/** Node, not Edge: `@supabase/realtime-js` needs a WebSocket client. */
export const runtime = 'nodejs';

/** Recycled on this bound; EventSource reopens and the guards run again. */
export const maxDuration = 300;

export async function GET(request: Request) {
  const access = await resolveJobBoardAccess();

  if (!access.allowed) {
    return NextResponse.json(
      { ok: false as const, code: 'forbidden', message: 'You do not have access to the job board.' },
      { status: 403, headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
    );
  }

  if (!isJobBoardConfigured()) {
    return NextResponse.json(
      {
        ok: false as const,
        code: 'unconfigured',
        message: 'The job board is not available on this deployment.',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
    );
  }

  return jobBoardEventStream({
    signal: request.signal,
    /*
     * A different channel name from the administrator feed. Supabase Realtime
     * keys subscriptions by topic, and one shared name would mean one channel
     * serving both audiences — harmless today, because the event is identical,
     * and exactly the assumption that stops being true the moment either feed
     * carries something the other should not see.
     */
    channelName: 'kiasa_candidate_saved_jobs',
    // Logged without an actor id: a candidate's identity has no place in a log
    // line about a websocket that failed to subscribe.
    log: (operation, error) => logAdminError(`job_board.${operation}`, error),
  });
}
