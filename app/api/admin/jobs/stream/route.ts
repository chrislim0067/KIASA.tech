import { guardApi, apiError, logAdminError } from '@/lib/admin/api';
import { isJobBoardConfigured } from '@/lib/jobboard/env';
import { jobBoardEventStream } from '@/lib/jobboard/stream';

/**
 * GET /api/admin/jobs/stream — the live feed behind the administrator board.
 *
 * THE GUARD IS THIS FILE'S ONLY JOB. The relay itself — the subscription, the
 * coalescing, the heartbeat, the teardown — lives in `lib/jobboard/stream.ts`
 * and is shared with the candidate feed at `/api/job-board/stream`. The two
 * differ in exactly one thing, which is who may open them, and that difference
 * is the seven lines below rather than a second copy of a long-lived
 * connection's worth of edge cases.
 *
 * It preserves the property `app/api/admin/pulse/route.ts` is built around:
 * every authorization decision stays server-side. It goes further in one way —
 * no key of any kind for the job board project ever reaches a browser.
 */

export const dynamic = 'force-dynamic';

/**
 * Node, not Edge. `@supabase/realtime-js` needs a WebSocket client, and the
 * Node runtime on this version supplies a global one.
 */
export const runtime = 'nodejs';

/**
 * The host will cut a streaming response eventually whatever this says, and a
 * stream that ends is not an error: `EventSource` reconnects on its own. Naming
 * a bound makes the recycle predictable rather than a surprise, and keeps the
 * Realtime subscription from ageing indefinitely behind a dead reader.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const guard = await guardApi('admin.access');
  if (!guard.ok) return guard.response;

  if (!isJobBoardConfigured()) {
    return apiError('unconfigured', 'The job board is not configured on this deployment.');
  }

  const actorId = guard.ctx.user.id;

  return jobBoardEventStream({
    signal: request.signal,
    channelName: 'kiasa_admin_saved_jobs',
    log: (operation, error) =>
      logAdminError(`jobs.${operation}`, error, { actor_user_id: actorId }),
  });
}
