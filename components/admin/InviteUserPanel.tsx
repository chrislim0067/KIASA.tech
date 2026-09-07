'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

/**
 * Invite-a-user form.
 *
 * A Client Component because it needs local form state and an inline result
 * message. It holds no privilege of its own: it POSTs to
 * /api/admin/users/invite, which re-checks the caller's `users.invite`
 * capability server-side. Rendering this panel to someone who is not an
 * administrator would achieve nothing but a 403.
 *
 * Errors are shown exactly as the API worded them. The API is careful to return
 * a written-for-humans message and never an upstream Supabase error, so there
 * is nothing here to sanitise and nothing internal to leak.
 */

type Result = { kind: 'success' | 'error'; message: string } | null;

export default function InviteUserPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setResult(null);

    try {
      const response = await fetch('/api/admin/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Same-origin only. The session cookie must not be sent anywhere else.
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
      });

      const body: unknown = await response.json().catch(() => null);
      const message =
        body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
          ? body.message
          : null;

      if (!response.ok) {
        setResult({ kind: 'error', message: message ?? 'The invitation could not be sent.' });
        return;
      }

      setResult({ kind: 'success', message: message ?? 'Invitation sent.' });
      setEmail('');
      // Bring the newly invited account into the list behind the panel.
      router.refresh();
    } catch {
      setResult({
        kind: 'error',
        message: 'The invitation could not be sent — the request did not reach the server.',
      });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="kadmin__sectionHead">
        <button type="button" className="kadmin__button" onClick={() => setOpen(true)}>
          Invite user
        </button>
        {result ? (
          <span
            className={`kadmin__badge${result.kind === 'success' ? ' kadmin__badge--active' : ' kadmin__badge--failed'}`}
            role="status"
          >
            {result.message}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <form className="kadmin__filters" onSubmit={onSubmit}>
      <div className="kadmin__field kadmin__field--grow">
        <label className="kadmin__label" htmlFor="invite-email">
          Invite by email
        </label>
        <input
          id="invite-email"
          className="kadmin__input"
          type="email"
          required
          autoComplete="off"
          placeholder="person@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </div>

      <button type="submit" className="kadmin__button" disabled={busy || email.trim() === ''}>
        {busy ? 'Sending…' : 'Send invitation'}
      </button>
      <button
        type="button"
        className="kadmin__button kadmin__button--ghost"
        onClick={() => {
          setOpen(false);
          setResult(null);
        }}
        disabled={busy}
      >
        Cancel
      </button>

      {result ? (
        <p
          className={`kadmin__notice ${result.kind === 'success' ? 'kadmin__notice--success' : 'kadmin__notice--danger'}`}
          style={{ flexBasis: '100%' }}
          role="status"
          aria-live="polite"
        >
          {result.message}
        </p>
      ) : (
        <p className="kadmin__statNote" style={{ flexBasis: '100%' }}>
          Supabase sends the invitation using this project&rsquo;s own email template. If the
          address already has a pending account, the invitation is sent again rather than
          creating a duplicate.
        </p>
      )}
    </form>
  );
}
