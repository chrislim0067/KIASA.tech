'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * Deletion, with the friction a destructive action deserves.
 *
 * There is no one-click delete. Opening the dialog shows exactly which account
 * is about to be removed and exactly what happens to its data, and the
 * permanent option additionally requires the administrator to type the
 * account's email address. That last step is not theatre: soft deletion is
 * reversible and permanent deletion is not, so only the irreversible one asks
 * for proof that the right row is selected.
 *
 * The request echoes the target id in its body. The server refuses any deletion
 * whose echoed id does not match the URL, so a stale client or a cross-origin
 * request cannot delete the wrong account — see app/api/admin/users/[userId].
 */

export default function DeleteUserDialog({
  userId,
  email,
  displayName,
}: {
  userId: string;
  email: string | null;
  displayName: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'soft' | 'hard'>('soft');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes the dialog, and focus lands somewhere sensible when it opens.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy]);

  const label = displayName ?? email ?? userId;
  const hardConfirmed = mode === 'soft' || (email !== null && confirmText.trim() === email);

  async function onConfirm() {
    if (busy || !hardConfirmed) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        // The server requires this to equal the id in the path.
        body: JSON.stringify({ confirmUserId: userId, mode }),
      });

      const body: unknown = await response.json().catch(() => null);
      const message =
        body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
          ? body.message
          : null;

      if (!response.ok) {
        setError(message ?? 'The account could not be deleted.');
        return;
      }

      // The user we were looking at may no longer exist, so go back to the list
      // rather than re-rendering a detail page for a deleted account.
      router.push('/admin/users');
      router.refresh();
    } catch {
      setError('The account could not be deleted — the request did not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="kadmin__button kadmin__button--danger kadmin__button--small"
        onClick={() => setOpen(true)}
      >
        Delete user
      </button>
    );
  }

  return (
    <div
      className="kadmin__dialogBackdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="del-title"
      onMouseDown={(e) => {
        // Only a click on the backdrop itself dismisses; a drag that ends
        // outside the dialog must not close it mid-interaction.
        if (e.target === e.currentTarget && !busy) setOpen(false);
      }}
    >
      <div className="kadmin__dialog">
        <h2 className="kadmin__dialogTitle" id="del-title">
          Delete {label}?
        </h2>

        <div className="kadmin__dialogBody">
          <p>
            You are about to remove <strong>{email ?? label}</strong>.
            <br />
            <span className="kadmin__sub">User id: {userId}</span>
          </p>

          <fieldset style={{ border: 0, padding: 0, margin: '1.25rem 0 0' }}>
            <legend className="kadmin__label" style={{ marginBottom: '0.5rem' }}>
              How
            </legend>

            <label style={{ display: 'block', marginBottom: '0.85rem', cursor: 'pointer' }}>
              <input
                type="radio"
                name="del-mode"
                checked={mode === 'soft'}
                onChange={() => setMode('soft')}
                disabled={busy}
              />{' '}
              <strong>Deactivate</strong> — recommended
              <br />
              <span className="kadmin__sub">
                The account can no longer sign in. Every record it owns is kept, and the deletion
                can be undone.
              </span>
            </label>

            <label style={{ display: 'block', cursor: 'pointer' }}>
              <input
                type="radio"
                name="del-mode"
                checked={mode === 'hard'}
                onChange={() => setMode('hard')}
                disabled={busy}
              />{' '}
              <strong>Delete permanently</strong> — cannot be undone
              <br />
              <span className="kadmin__sub">
                Removes the account and everything that references it.
              </span>
            </label>
          </fieldset>

          {mode === 'hard' ? (
            <div className="kadmin__notice kadmin__notice--danger" style={{ marginTop: '1rem' }}>
              <p>
                <strong>This permanently destroys:</strong>
              </p>
              <ul className="kadmin__list">
                <li>the candidate profile, skills, experience, education and verified answers</li>
                <li>job preferences, automation settings and work authorisations</li>
                <li>every job taken in, with its snapshots, extracted facts and event history</li>
                <li>every application and application attempt, and their statistics</li>
              </ul>
              <p style={{ marginTop: '0.5rem' }}>
                The administrative audit log is <strong>kept</strong> — the record that this
                account existed and was deleted survives.
              </p>

              <label className="kadmin__label" htmlFor="del-confirm" style={{ marginTop: '0.9rem', display: 'block' }}>
                Type {email ?? 'the email address'} to confirm
              </label>
              <input
                id="del-confirm"
                className="kadmin__input"
                autoComplete="off"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={busy}
              />
            </div>
          ) : null}

          {error ? (
            <p className="kadmin__notice kadmin__notice--danger" role="alert" style={{ marginTop: '1rem' }}>
              {error}
            </p>
          ) : null}
        </div>

        <div className="kadmin__dialogActions">
          <button
            ref={closeRef}
            type="button"
            className="kadmin__button kadmin__button--ghost"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="kadmin__button kadmin__button--danger"
            onClick={onConfirm}
            disabled={busy || !hardConfirmed}
          >
            {busy ? 'Working…' : mode === 'soft' ? 'Deactivate account' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
