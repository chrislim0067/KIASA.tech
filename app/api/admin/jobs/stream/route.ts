import { guardApi, apiError, logAdminError } from '@/lib/admin/api';
import { createJobBoardClient } from '@/lib/jobboard/client';
import { isJobBoardConfigured } from '@/lib/jobboard/env';

/**
 * GET /api/admin/jobs/stream — the live feed behind the administrator job board.
 *
 * Server-Sent Events. The browser opens one long-lived `EventSource`, this
 * handler holds a Supabase Realtime subscription on its behalf, and each row
 * change becomes one tiny event on the wire. The client's only reaction is
 * `router.refresh()`, so the server component re-runs the same authorized query
 * that painted the page and one code path decides what a job looks like.
 *
 * WHY A RELAY RATHER THAN A SOCKET FROM THE BROWSER
 *
 * `saved_jobs` lives in a DIFFERENT Supabase project, protected by
 * `auth.uid() = user_id`. A KIASA administrator has no session in that project
 * — the two do not share an `auth.users` table — so a websocket opened from
 * their browser would be anonymous, row-level security would match nothing, and
 * the channel would subscribe and then sit silent forever. The alternatives were
 * to ship that project's key to the browser behind a read-everything RLS policy,
 * or to keep the elevated credential on the server. This is the second.
 *
 * It preserves the property `app/api/admin/pulse/route.ts` is built around:
 * every authorization decision stays server-side. It goes further in one way —
 * no key of any kind for the job board project ever reaches a browser.
 *
 * WHAT CROSSES THE WIRE
 *
 * A change EVENT, never a row. The payload is the table, the operation and a
 * timestamp; no title, no company, no email, nothing personal. A connection
 * held open for hours therefore cannot become a slow leak of other people's
 * postings into browser memory, an intermediary's buffers, or a proxy log.
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

/** Slightly under the shortest idle timeout a proxy in front of this is likely to use. */
const HEARTBEAT_MS = 25_000;

/**
 * Coalescing window for bursts.
 *
 * Re-saving a posting writes more than once in quick succession, and each write
 * would otherwise be its own refresh of the whole page. One event after the
 * burst settles is the same information for a fraction of the work.
 */
const COALESCE_MS = 400;

export async function GET(request: Request) {
  const guard = await guardApi('admin.access');
  if (!guard.ok) return guard.response;

  if (!isJobBoardConfigured()) {
    return apiError('unconfigured', 'The job board is not configured on this deployment.');
  }

  const actorId = guard.ctx.user.id;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let coalesce: ReturnType<typeof setTimeout> | null = null;
      let client: ReturnType<typeof createJobBoardClient> | null = null;
      let channel: ReturnType<ReturnType<typeof createJobBoardClient>['channel']> | null = null;

      /**
       * Every write to the controller goes through here.
       *
       * Once a reader disconnects, `enqueue` throws — and an unhandled throw
       * inside the heartbeat interval or a Realtime callback would be an
       * unhandled rejection in the server process rather than a closed stream.
       * Catching it and tearing down is what makes a browser walking away an
       * ordinary event.
       */
      function send(payload: string): void {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          void teardown();
        }
      }

      async function teardown(): Promise<void> {
        if (closed) return;
        closed = true;

        if (heartbeat) clearInterval(heartbeat);
        if (coalesce) clearTimeout(coalesce);

        try {
          if (client && channel) await client.removeChannel(channel);
        } catch {
          // Already gone. Nothing to release.
        }

        try {
          controller.close();
        } catch {
          // Closed by the runtime when the reader disconnected.
        }
      }

      // The browser disconnecting is the normal way this ends: a navigation, a
      // closed tab, or EventSource recycling the connection.
      request.signal.addEventListener('abort', () => void teardown());

      /**
       * `retry:` tells EventSource how long to wait before reconnecting. Set
       * explicitly so a recycled stream comes back promptly instead of at
       * whatever the browser's default happens to be.
       */
      send('retry: 3000\n\n');
      send(`event: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

      heartbeat = setInterval(() => {
        // A comment line. It keeps the connection warm through intermediaries
        // that close idle streams, and costs two bytes of payload.
        send(': keep-alive\n\n');
      }, HEARTBEAT_MS);

      try {
        client = createJobBoardClient();

        channel = client
          .channel('kiasa_admin_saved_jobs')
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'saved_jobs' },
            (payload) => {
              if (coalesce) clearTimeout(coalesce);
              coalesce = setTimeout(() => {
                coalesce = null;
                // The operation only. Deliberately not `payload.new` — see the
                // note at the top of this file about what may cross the wire.
                send(
                  `event: change\ndata: ${JSON.stringify({
                    type: payload.eventType,
                    at: Date.now(),
                  })}\n\n`
                );
              }, COALESCE_MS);
            }
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              send(`event: live\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
              return;
            }

            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              // Ending the stream is the reconnection strategy. EventSource
              // reopens after `retry`, which re-runs this handler — guard,
              // client and subscription all rebuilt from scratch. That is
              // strictly simpler than reconnecting a channel in place, and it
              // re-checks authorization on the way through.
              logAdminError('jobs.stream_channel', new Error(status), { actor_user_id: actorId });
              void teardown();
            }
          });
      } catch (error) {
        logAdminError('jobs.stream_subscribe', error, { actor_user_id: actorId });
        send(`event: error\ndata: ${JSON.stringify({ message: 'subscription_failed' })}\n\n`);
        await teardown();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // Administrative responses concern other people's data. Nothing about
      // this stream may be stored anywhere on the way to the browser.
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Connection: 'keep-alive',
      // Tells nginx and friends not to buffer, which would otherwise hold every
      // event until the buffer filled and defeat the point of streaming.
      'X-Accel-Buffering': 'no',
    },
  });
}
