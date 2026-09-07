'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The live counter in the admin navigation.
 *
 * Behaves the way a notification badge on X or LinkedIn behaves, and for the
 * same reasons:
 *
 *   * It polls a tiny endpoint rather than re-rendering the page. Four integers
 *     over the wire, not a user list.
 *
 *   * It PAUSES when the tab is hidden and resumes — with an immediate fetch —
 *     when you come back. A background tab left open overnight should not make
 *     thousands of requests, and the first thing you want on returning is the
 *     current number, not one up to ten seconds stale.
 *
 *   * It BACKS OFF on failure (2s → 4s → 8s, capped) instead of hammering a
 *     server that is already unhappy, and recovers to the normal interval as
 *     soon as a request succeeds.
 *
 *   * When the pending count changes it calls `router.refresh()`, so the table
 *     you are looking at updates itself without a navigation. That is the part
 *     that makes the queue feel live: approve on one device, watch it disappear
 *     on the other.
 */

const BASE_INTERVAL_MS = 8_000;
const MAX_BACKOFF_MS = 60_000;

interface Pulse {
  usersTotal: number;
  pendingApproval: number;
  applicationsTotal: number;
  adminActions7d: number;
}

export default function LivePulse({ initialPending = 0 }: { initialPending?: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(initialPending);
  const [live, setLive] = useState(true);

  // Refs, not state: changing these must never itself cause a render.
  const lastPending = useRef(initialPending);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  const tick = useCallback(async () => {
    if (stopped.current || document.hidden) return;

    try {
      const response = await fetch('/api/admin/pulse', {
        credentials: 'same-origin',
        // Never let a proxy or the browser hand back a cached count.
        cache: 'no-store',
      });

      if (!response.ok) throw new Error(String(response.status));

      const body: { pulse?: Pulse } = await response.json();
      const next = body.pulse;
      if (!next) throw new Error('malformed');

      failures.current = 0;
      setLive(true);
      setPending(next.pendingApproval);

      // Only disturb the page when the number actually moved. Refreshing on
      // every tick would re-run every server component on the screen for
      // nothing.
      if (next.pendingApproval !== lastPending.current) {
        lastPending.current = next.pendingApproval;
        router.refresh();
      }
    } catch {
      failures.current += 1;
      // Two consecutive failures before admitting it: one blip during a deploy
      // should not flip the badge to "offline".
      if (failures.current >= 2) setLive(false);
    }
  }, [router]);

  useEffect(() => {
    stopped.current = false;

    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      const delay =
        failures.current === 0
          ? BASE_INTERVAL_MS
          : Math.min(BASE_INTERVAL_MS * 2 ** failures.current, MAX_BACKOFF_MS);
      timer.current = setTimeout(run, delay);
    };

    const run = async () => {
      await tick();
      if (!stopped.current) schedule();
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (timer.current) clearTimeout(timer.current);
      } else {
        // Back on screen: fetch now, then resume the cycle.
        void run();
      }
    };

    // Fetch immediately on mount rather than waiting out the first interval,
    // so the badge is correct on first paint instead of eight seconds later.
    void run();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tick]);

  if (pending === 0) {
    return (
      <span
        className="kadmin__pulse"
        title={live ? 'Live — nothing waiting' : 'Reconnecting…'}
        aria-live="polite"
      >
        <span className={`kadmin__pulseDot${live ? '' : ' kadmin__pulseDot--stale'}`} aria-hidden="true" />
        <span className="kadmin__sub">{live ? 'Live' : 'Reconnecting…'}</span>
      </span>
    );
  }

  return (
    <Link
      href="/admin/users?access=pending"
      className="kadmin__pulse kadmin__pulse--alert"
      aria-live="polite"
      prefetch
    >
      <span className={`kadmin__pulseDot${live ? '' : ' kadmin__pulseDot--stale'}`} aria-hidden="true" />
      <span className="kadmin__pulseCount">{pending}</span>
      <span>waiting</span>
    </Link>
  );
}
