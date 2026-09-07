'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Grant or revoke the administrator role.
 *
 * The button is the only thing this component owns. The decision is entirely
 * the server's: PUT /api/admin/users/[userId]/role re-checks the `roles.grant`
 * capability, refuses to strip the last administrator, and writes `user_roles`
 * with the service key — the only credential that can, because `authenticated`
 * holds no write privilege on that table at all.
 */
export default function RoleControl({
  userId,
  currentRole,
}: {
  userId: string;
  currentRole: 'user' | 'admin';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const nextRole = currentRole === 'admin' ? 'user' : 'admin';
  const verb = nextRole === 'admin' ? 'Make administrator' : 'Revoke administrator';

  async function apply() {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/users/${userId}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ role: nextRole }),
      });

      const body: unknown = await response.json().catch(() => null);
      const message =
        body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
          ? body.message
          : null;

      if (!response.ok) {
        setError(message ?? 'The role could not be changed.');
        return;
      }

      setConfirming(false);
      router.refresh();
    } catch {
      setError('The role could not be changed — the request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <>
        <button
          type="button"
          className="kadmin__button kadmin__button--ghost kadmin__button--small"
          onClick={() => setConfirming(true)}
        >
          {verb}
        </button>
        {error ? (
          <span className="kadmin__badge kadmin__badge--failed" role="alert">
            {error}
          </span>
        ) : null}
      </>
    );
  }

  return (
    <>
      <span className="kadmin__sub">
        {nextRole === 'admin'
          ? 'Grant full administrative access to this account?'
          : 'Remove administrative access from this account?'}
      </span>
      <button
        type="button"
        className="kadmin__button kadmin__button--small"
        onClick={apply}
        disabled={busy}
      >
        {busy ? 'Working…' : 'Confirm'}
      </button>
      <button
        type="button"
        className="kadmin__button kadmin__button--ghost kadmin__button--small"
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
        disabled={busy}
      >
        Cancel
      </button>
    </>
  );
}
