'use client';

import { useState } from 'react';

/**
 * Sign-out control.
 *
 * A native form POST to /auth/signout, not a Server Action: the handler answers
 * 303 so the browser performs a real document load of "/", which is the only way
 * the legacy homepage initialises correctly (see app/auth/signout/route.ts).
 *
 * Because the submission is native rather than React-driven, `useFormStatus`
 * would never report it, so the pending state is tracked here. Submission has
 * already begun by the time this state lands, so disabling the button cannot
 * cancel it — it only prevents a second request.
 */
export default function SignOutForm() {
  const [pending, setPending] = useState(false);

  return (
    <form method="post" action="/auth/signout" onSubmit={() => setPending(true)}>
      <button className="kauth__button kauth__button--ghost" type="submit" disabled={pending}>
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
      <span role="status" aria-live="polite" className="kauth__hint">
        {pending ? 'Signing out, please wait.' : ''}
      </span>
    </form>
  );
}
