'use client';

import { useLiveRefresh } from '@/lib/jobboard/use-live-refresh';

/**
 * The candidate board's live indicator.
 *
 * Points at `/api/job-board/stream`, which re-checks BOTH gates on every
 * connection and on every reconnect — so a revoked grant ends an open feed
 * within the relay's recycle bound rather than surviving for the life of a tab.
 *
 * The wording differs from the administrator's on purpose. "New saves" is what
 * an administrator is watching; a candidate is watching for openings, and does
 * not need to know that a browser extension is what puts them there.
 */
export default function JobBoardLive() {
  const live = useLiveRefresh('/api/job-board/stream');

  return (
    <span
      className={`kjb__live${live ? ' kjb__live--on' : ''}`}
      title={
        live
          ? 'Live — new openings appear on their own'
          : 'Reconnecting. The list still refreshes when you return to this tab.'
      }
    >
      <span className="kjb__liveDot" aria-hidden="true" />
      {live ? 'Live' : 'Reconnecting…'}
    </span>
  );
}
