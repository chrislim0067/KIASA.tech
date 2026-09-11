'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { IDLE, type FormState } from '@/lib/candidate/form-state';

/**
 * Adding a job posting by its link.
 *
 * The only validation here is the browser's own `type="url"`, and that is
 * deliberate: every rule that matters — the scheme, the host, the address
 * behind the host, the redirect chain, the size and the content type — is
 * decided on the server by `lib/jobs/url.ts` and `lib/jobs/fetcher.ts`. A
 * server action is a POST endpoint anyone can call, so anything checked only
 * here would be a suggestion rather than a rule.
 *
 * What this does add is an honest wait. Reading a posting is a real network
 * fetch bounded at fifteen seconds, which is long enough that a button which
 * simply goes quiet looks broken.
 */

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="kprof__button" disabled={pending}>
      {pending ? 'Reading the posting…' : 'Add this job'}
    </button>
  );
}

export default function AddJobForm({
  action,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="kprof__form">
      <div className="kprof__field kprof__field--wide">
        <label className="kprof__label" htmlFor="job-url">
          Link to the job posting
        </label>
        <input
          className="kprof__input"
          id="job-url"
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://…"
          required
          maxLength={2048}
        />
        <p className="kprof__hint">
          Paste the address of the posting itself, not a search results page. KIASA reads what
          the page says and stores it for you to look at — it does not apply for anything.
        </p>
      </div>

      {state.message ? (
        <p
          className={`kprof__notice kprof__notice--${state.ok ? 'ok' : 'bad'}`}
          role={state.ok ? 'status' : 'alert'}
        >
          {state.message}
        </p>
      ) : null}

      <div className="kprof__actions">
        <Submit />
      </div>
    </form>
  );
}
