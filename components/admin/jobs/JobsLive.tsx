'use client';

import { useLiveRefresh } from '@/lib/jobboard/use-live-refresh';

/**
 * The administrator board's live indicator.
 *
 * All of the connection logic — connect once per mount, coalesce refreshes,
 * defer while hidden, wait before admitting the feed is down — lives in
 * `useLiveRefresh`, shared with the candidate board. What is left here is this
 * surface's own markup and wording.
 */
export default function JobsLive() {
  const live = useLiveRefresh('/api/admin/jobs/stream');

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
