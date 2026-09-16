'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { JobBoardStatus } from '@/lib/auth/job-board';

/**
 * Grant or revoke a candidate's view of the shared job board.
 *
 * THE SECOND GATE, and the UI says so: this is not the same control as
 * {@link AccessControl}, it writes a different table, and an administrator
 * clicking Approve on a signup has not touched this. Presenting them as one
 * toggle would be the fastest way to hand the board to everybody by accident.
 *
 * Holds no privilege of its own. It PUTs to
 * /api/admin/users/[userId]/job-board, which re-checks the `jobboard.grant`
 * capability server-side; rendering it to a non-administrator would achieve
 * nothing but a 403.
 *
 * Optimistic, like the access control and for the same reasons — idempotent,
 * instantly reversible, and the round trip is long enough to feel like a stall.
 * The optimistic state is reverted on failure rather than left lying about what
 * happened.
 */
export default function JobBoardControl({
  userId,
  status,
}: {
  userId: string;
  status: JobBoardStatus;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<JobBoardStatus>(status);

  async function decide(next: JobBoardStatus) {
    if (busy) return;

    const previous = optimistic;
    setOptimistic(next);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/users/${userId}/job-board`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ status: next }),
      });

      const body: unknown = await response.json().catch(() => null);
      const message =
        body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
          ? body.message
          : null;

      if (!response.ok) {
        setOptimistic(previous); // put it back — the decision did not happen
        setError(message ?? 'The decision could not be saved.');
        return;
      }

      router.refresh();
    } catch {
      setOptimistic(previous);
      setError('The decision could not be saved — the request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const granted = optimistic === 'granted';

  return (
    <span className="kadmin__chips">
      <button
        type="button"
        className={`kadmin__button kadmin__button--small${granted ? ' kadmin__button--danger' : ''}`}
        disabled={busy}
        onClick={() => decide(granted ? 'revoked' : 'granted')}
        title={
          granted
            ? 'They can currently see the shared board at /job-board.'
            : 'Separate from account approval. They cannot see the board.'
        }
      >
        {busy ? 'Working…' : granted ? 'Revoke job board' : 'Grant job board'}
      </button>

      {error ? (
        <span className="kadmin__notice kadmin__notice--danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
