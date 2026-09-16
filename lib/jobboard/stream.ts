import 'server-only';

import { createJobBoardClient } from '@/lib/jobboard/client';

/**
 * The Server-Sent Events relay behind every live job board.
 *
 * ONE RELAY, TWO AUDIENCES. `/api/admin/jobs/stream` and
 * `/api/job-board/stream` differ in exactly one thing — who is allowed to open
 * them — and share everything else. Each route does its own authorization and
 * then calls this; duplicating the subscription, the coalescing and the
 * teardown into two files would have been two places to get a long-lived
 * connection wrong.
 *
 * THIS FUNCTION AUTHORIZES NOBODY. It is called only after a guard has already
 * returned, exactly as `createJobBoardClient()` is. Adding a check here would
 * put the decision in two places; leaving it out keeps it in one.
 *
 * WHY A RELAY RATHER THAN A SOCKET FROM THE BROWSER
 *
 * `saved_jobs` lives in a DIFFERENT Supabase project, protected by
 * `auth.uid() = user_id`. Nobody in KIASA has a session in that project — the
 * two do not share an `auth.users` — so a websocket opened from a browser would
 * be anonymous, row-level security would match nothing, and the channel would
 * subscribe and then sit silent forever. The alternatives were to ship that
 * project's key to the browser behind a read-everything policy, or to keep the
 * credential on the server. This is the second.
 *
 * WHAT CROSSES THE WIRE
 *
 * A change EVENT, never a row. The payload is the operation and a timestamp; no
 * title, no company, no address, nothing personal. A connection held open for
 * hours therefore cannot become a slow leak of other people's postings into
 * browser memory, an intermediary's buffers, or a proxy log. Both audiences get
 * the same event, which is why one relay can serve an administrator and a
 * candidate without the projection question arising at all.
 */

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

export interface StreamOptions {
  /** Aborted when the browser goes away: a navigation, a closed tab, a recycle. */
  readonly signal: AbortSignal;
  /**
   * Distinct per audience, because Supabase Realtime keys subscriptions by
   * name. Two audiences sharing one topic would be one channel serving both.
   */
  readonly channelName: string;
  /** Server-side logging. Never called with anything that reaches the browser. */
  readonly log: (operation: string, error: unknown) => void;
}

export function jobBoardEventStream({ signal, channelName, log }: StreamOptions): Response {
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

      signal.addEventListener('abort', () => void teardown());

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
          .channel(channelName)
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'saved_jobs' },
            (payload) => {
              if (coalesce) clearTimeout(coalesce);
              coalesce = setTimeout(() => {
                coalesce = null;
                // The operation only. Deliberately not the row — see the note
                // at the top of this file about what may cross the wire.
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
              // reopens after `retry`, which re-runs the route handler — guard,
              // client and subscription all rebuilt from scratch. That is
              // strictly simpler than reconnecting a channel in place, and it
              // re-checks authorization on the way through.
              log('stream_channel', new Error(status));
              void teardown();
            }
          });
      } catch (error) {
        log('stream_subscribe', error);
        send(`event: error\ndata: ${JSON.stringify({ message: 'subscription_failed' })}\n\n`);
        await teardown();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // These responses concern other people's data. Nothing about this stream
      // may be stored anywhere on the way to the browser.
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Connection: 'keep-alive',
      // Tells nginx and friends not to buffer, which would otherwise hold every
      // event until the buffer filled and defeat the point of streaming.
      'X-Accel-Buffering': 'no',
    },
  });
}
