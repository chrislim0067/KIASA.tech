'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';

import { IDLE, type FormState } from '@/lib/candidate/form-state';

/**
 * Wrapper for every profile form.
 *
 * Uses `useActionState`, so the form works with JavaScript disabled and the
 * server action is the single code path either way — no duplicate client-side
 * submit handler that could drift from it.
 *
 * The submit button lives in its own component because `useFormStatus` only
 * reports the pending state to a DESCENDANT of the form. Reading it here would
 * always return false, which is the usual way this hook is got wrong.
 */

function Submit({ label, busyLabel }: { label: string; busyLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="kprof__button" disabled={pending}>
      {pending ? busyLabel : label}
    </button>
  );
}

export default function ProfileForm({
  action,
  children,
  submitLabel = 'Save',
  busyLabel = 'Saving…',
  secondary,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  children: ReactNode;
  submitLabel?: string;
  busyLabel?: string;
  secondary?: ReactNode;
}) {
  const [state, formAction] = useActionState(action, IDLE);

  // The data layer attributes a failure to one field at a time, so the message
  // is shown once at the top with the field named rather than being threaded
  // down to an input that may not exist on this form.
  const fieldIssue = state.issues ? Object.entries(state.issues)[0] : undefined;

  return (
    <form action={formAction} className="kprof__form">
      {children}

      {state.message && state.ok ? (
        <p className="kprof__notice kprof__notice--ok" role="status">
          {state.message}
        </p>
      ) : null}

      {!state.ok && (state.message || fieldIssue) ? (
        <p className="kprof__notice kprof__notice--bad" role="alert">
          {fieldIssue ? (
            <>
              <strong>{fieldIssue[0].replace(/_/g, ' ')}:</strong> {fieldIssue[1]}
            </>
          ) : (
            state.message
          )}
        </p>
      ) : null}

      <div className="kprof__actions">
        <Submit label={submitLabel} busyLabel={busyLabel} />
        {secondary}
      </div>
    </form>
  );
}
