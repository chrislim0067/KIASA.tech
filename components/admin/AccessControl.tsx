'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Approve or reject an account.
 *
 * Holds no privilege of its own: it PUTs to
 * /api/admin/users/[userId]/access, which re-checks the `users.approve`
 * capability server-side. Rendering it to a non-administrator would achieve
 * nothing but a 403.
 *
 * Approving is one click — it is the common case, it is reversible, and making
 * an administrator confirm a queue of twenty signups twice each would just
 * train them to click through dialogs. Rejecting asks for a reason first,
 * because that reason is the only record of why, and it is written for whoever
 * reads the audit log later rather than for the applicant.
 */
export default function AccessControl({
  userId,
  status,
  compact = false,
}: {
  userId: string;
  status: 'pending' | 'approved' | 'rejected';
  compact?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  async function decide(next: 'approved' | 'rejected') {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/users/${userId}/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ status: next, reason: next === 'rejected' ? reason : null }),
      });

      const body: unknown = await response.json().catch(() => null);
      const message =
        body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
          ? body.message
          : null;

      if (!response.ok) {
        setError(message ?? 'The decision could not be saved.');
        return;
      }

      setRejecting(false);
      setReason('');
      router.refresh();
    } catch {
      setError('The decision could not be saved — the request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (rejecting) {
    return (
      <span className="kadmin__chips">
        <input
          className="kadmin__input"
          style={{ maxWidth: '18rem' }}
          placeholder="Reason (internal note)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <button
          type="button"
          className="kadmin__button kadmin__button--danger kadmin__button--small"
          onClick={() => decide('rejected')}
          disabled={busy}
        >
          {busy ? 'Working…' : 'Confirm reject'}
        </button>
        <button
          type="button"
          className="kadmin__button kadmin__button--ghost kadmin__button--small"
          onClick={() => {
            setRejecting(false);
            setReason('');
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="kadmin__chips">
      {status !== 'approved' ? (
        <button
          type="button"
          className={`kadmin__button kadmin__button--small${compact ? '' : ''}`}
          onClick={() => decide('approved')}
          disabled={busy}
        >
          {busy ? 'Working…' : 'Approve'}
        </button>
      ) : null}

      {status !== 'rejected' ? (
        <button
          type="button"
          className="kadmin__button kadmin__button--danger kadmin__button--small"
          onClick={() => setRejecting(true)}
          disabled={busy}
        >
          Reject
        </button>
      ) : null}

      {error ? (
        <span className="kadmin__badge kadmin__badge--failed" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
