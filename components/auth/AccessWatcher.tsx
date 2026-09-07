'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Watches the signed-in candidate's own approval status and reacts live.
 *
 * The candidate side of the same idea as the administrator's LivePulse: sitting
 * on the waiting screen should not require refreshing to find out you were let
 * in. An administrator clicks Approve and this page moves to the dashboard on
 * its own within a few seconds.
 *
 * Same manners as LivePulse, for the same reasons:
 *   * pauses while the tab is hidden, and fetches immediately on return —
 *     someone leaves this tab open for hours waiting;
 *   * backs off on failure rather than hammering;
 *   * only acts when the answer actually CHANGES.
 *
 * On approval it navigates with `router.replace` — the dashboard is a Server
 * Component behind the approval gate, so the navigation fetches a fresh RSC
 * payload and that gate re-runs on the server. `replace` rather than `push` so
 * Back cannot land on the waiting screen after being let in.
 */

const BASE_INTERVAL_MS = 6_000;
const MAX_BACKOFF_MS = 60_000;

type Status = 'pending' | 'approved' | 'rejected';

export default function AccessWatcher({
  initialStatus,
  initialReason,
}: {
  initialStatus: Status;
  initialReason: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initialStatus);
  const [reason, setReason] = useState<string | null>(initialReason);
  const [live, setLive] = useState(true);

  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);
  const lastStatus = useRef<Status>(initialStatus);

  const tick = useCallback(async () => {
    if (stopped.current || document.hidden) return;

    try {
      const response = await fetch('/api/access/status', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(String(response.status));

      const body: { status?: Status; reason?: string | null } = await response.json();
      const next = body.status;
      if (!next) throw new Error('malformed');

      failures.current = 0;
      setLive(true);
      setReason(body.reason ?? null);
      setStatus(next);

      if (next !== lastStatus.current) {
        lastStatus.current = next;
        if (next === 'approved') {
          stopped.current = true;
          // `replace`, not `push`: once approved, the waiting screen should not
          // be sitting in history for Back to land on. The navigation fetches a
          // fresh RSC payload, so the dashboard's own approval check re-runs on
          // the server; refresh() afterwards drops any Router Cache entry the
          // pending state may have left behind.
          router.replace('/dashboard');
          router.refresh();
          return;
        }
        // pending -> rejected: re-render the server component so the copy and
        // the reason come from one source rather than being duplicated here.
        router.refresh();
      }
    } catch {
      failures.current += 1;
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
        void run();
      }
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [tick]);

  return (
    <>
      {status === 'rejected' && reason ? (
        <div className="kauth__alert" role="status">
          <strong>Reason given:</strong> {reason}
        </div>
      ) : null}

      <p className="kauth__hint" aria-live="polite">
        {status === 'pending' ? (
          <>
            {live ? 'Checking automatically' : 'Reconnecting'} — this page updates itself the
            moment a decision is made. You do not need to refresh.
          </>
        ) : (
          <>This page updates itself if the decision changes.</>
        )}
      </p>
    </>
  );
}
