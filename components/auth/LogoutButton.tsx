'use client';

import { useFormStatus } from 'react-dom';

/**
 * Submit button for the sign-out form.
 *
 * Split out as a client component purely so `useFormStatus` can report progress;
 * the form itself posts to a Server Action, so sign-out still works with
 * JavaScript disabled.
 */
export default function LogoutButton() {
  const { pending } = useFormStatus();

  return (
    <button className="kauth__button kauth__button--ghost" type="submit" disabled={pending}>
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
