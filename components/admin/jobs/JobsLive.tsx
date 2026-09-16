'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keeps the job board in step with the database.
 *
 * Listens to `/api/admin/jobs/stream` — one `EventSource` onto the Server-Sent
 * Events relay, which holds the Supabase Realtime subscription server-side. On
 * a change it asks Next to re-render the server component rather than patching
 * a local copy from the event payload: the server component is the single
 * source of truth, `router.refresh()` re-runs the same authorized query that
 * painted the page, and one code path decides what a job looks like. The event
 * carries no row data to patch from anyway, by design.
 *
 * THE SUBSCRIPTION IS ESTABLISHED EXACTLY ONCE PER MOUNT, and that is the whole
 * design of this file. An effect that depended on anything reached through
 * `useRouter()` would re-run on every refresh — because `router.refresh()`
 * updates the router context — tearing down the connection and rebuilding it.
 * With saves arriving steadily that becomes a loop: refresh, reconnect, flap,
 * refresh. Nothing that changes on render may enter this effect's dependencies,
 * so everything mutable is reached through a ref.
 *
 * Reconnection is `EventSource`'s own, driven by the `retry:` field the relay
 * sends. A stream that ends is not a failure here; it is the server recycling a
 * long-lived connection, and the browser reopens it — which re-runs the route's
 * authorization guard on the way through.
 */

/** Refreshes are rate-limited to this, however fast events arrive. */
const MIN_REFRESH_GAP_MS = 1_500;

/**
 * How long the stream must stay down before the UI admits it.
 *
 * A connection blips, especially across a recycle. Announcing every blip
 * produces a label that flickers between two states and tells the reader
 * nothing except that something is wrong — which is worse than saying nothing.
 */
const DOWN_GRACE_MS = 4_000;

export default function JobsLive() {
  const router = useRouter();
  const [live, setLive] = useState(false);

  // Everything the long-lived effect touches lives in a ref, so the effect can
  // take an empty dependency list and connect once. The ref is written in its
  // own effect rather than during render — a render-phase ref write is not
  // safe under concurrent rendering, and this one has no reason to be.
  const routerRef = useRef(router);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  const lastRefresh = useRef(0);
  const pending = useRef(false);
  const connected = useRef(false);
  const downTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let disposed = false;

    /**
     * Coalesces refresh requests.
     *
     * A hidden tab records the request instead of running it: re-rendering a
     * list nobody is looking at burns battery on a page that is, by design,
     * left open. The visibility handler replays it on return.
     */
    function requestRefresh() {
      if (disposed) return;

      if (document.visibilityState === 'hidden') {
        pending.current = true;
        return;
      }

      if (refreshTimer.current) return;
      const wait = Math.max(0, MIN_REFRESH_GAP_MS - (Date.now() - lastRefresh.current));

      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        pending.current = false;
        lastRefresh.current = Date.now();
        routerRef.current.refresh();
      }, wait);
    }

    /** Shows "live" immediately, but waits before admitting it is down. */
    function setStatus(up: boolean) {
      connected.current = up;

      if (up) {
        if (downTimer.current) {
          clearTimeout(downTimer.current);
          downTimer.current = null;
        }
        setLive(true);
        return;
      }

      if (downTimer.current) return;
      downTimer.current = setTimeout(() => {
        downTimer.current = null;
        if (!connected.current) setLive(false);
      }, DOWN_GRACE_MS);
    }

    source = new EventSource('/api/admin/jobs/stream');

    // 'live' is the relay confirming the Realtime channel is subscribed. 'open'
    // only means the HTTP response arrived, which is a weaker claim — the
    // database feed behind it may not be up yet, and saying "Live" then would
    // be asserting something not yet true.
    source.addEventListener('live', () => setStatus(true));
    source.addEventListener('change', () => requestRefresh());

    source.onerror = () => {
      setStatus(false);
      // Not closed here: EventSource reconnects on its own, and closing would
      // permanently end a stream the server merely recycled.
    };

    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      // Events that arrived while the machine slept are gone, so returning to
      // the tab re-reads the data if anything was missed or the feed is down.
      if (pending.current || !connected.current) requestRefresh();
    }

    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (downTimer.current) clearTimeout(downTimer.current);
      source?.close();
    };
    // Intentionally empty: see the note above. Anything listed here would
    // rebuild the connection on every refresh.
  }, []);

  return (
    <span
      className={`kjobs__live${live ? ' kjobs__live--on' : ''}`}
      title={
        live
          ? 'Live — new saves appear automatically'
          : 'Reconnecting. The page still refreshes when you return to this tab.'
      }
    >
      <span className="kjobs__liveDot" aria-hidden="true" />
      {live ? 'Live' : 'Reconnecting…'}
    </span>
  );
}
