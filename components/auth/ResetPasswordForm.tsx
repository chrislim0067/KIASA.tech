'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { createClient } from '@/lib/supabase/client';
import { DASHBOARD } from '@/lib/auth/routes';
import {
  MIN_PASSWORD_LENGTH,
  toMessage,
  validateConfirmation,
  validatePassword,
  type Errors,
} from './formHelpers';

type Stage = 'checking' | 'ready' | 'invalid' | 'done';

export default function ResetPasswordForm() {
  const router = useRouter();
  const ids = useId();

  const [stage, setStage] = useState<Stage>('checking');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const settled = useRef(false);

  const passwordId = `${ids}-password`;
  const confirmId = `${ids}-confirm`;

  /**
   * A recovery link gives the visitor a real (if limited) session. Setting a new
   * password therefore requires only that a session exists — but it has to
   * exist, or anyone could open this page and change an account they do not own.
   *
   * Two flows can land here: PKCE, where /auth/callback has already exchanged
   * the code before we render, and implicit, where the tokens arrive in the URL
   * fragment and the browser client picks them up asynchronously. The
   * subscription covers the second case; the direct read covers the first.
   */
  useEffect(() => {
    // The page renders ConfigNotice instead of this form when Supabase is not
    // configured, so the client can be created unconditionally here.
    const supabase = createClient();

    const settle = (ok: boolean) => {
      if (settled.current) return;
      settled.current = true;
      setStage(ok ? 'ready' : 'invalid');
    };

    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        settle(true);
      }
    });

    void supabase.auth.getUser().then(({ data }) => {
      if (data.user) settle(true);
      // Give the implicit-flow listener a moment before declaring the link dead.
      else setTimeout(() => settle(false), 1200);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);

    const next: Errors = {};
    const passwordError = validatePassword(password);
    const confirmError = validateConfirmation(password, confirmation);
    if (passwordError) next.password = passwordError;
    if (confirmError) next.confirmation = confirmError;
    setErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setStage('done');
      setPending(false);
    } catch (error) {
      setFormError(toMessage(error));
      setPending(false);
    }
  }

  if (stage === 'checking') {
    return (
      <p className="kauth__hint" role="status" aria-live="polite">
        Checking your reset link…
      </p>
    );
  }

  if (stage === 'invalid') {
    return (
      <div className="kauth__done">
        <p className="kauth__alert" role="alert">
          {formError ?? 'This reset link is invalid or has expired.'}
        </p>
        <p>Request a new link and it will arrive within a minute.</p>
        <div className="kauth__meta">
          <Link className="kauth__link" href="/forgot-password">
            Request a new link
          </Link>
          <Link className="kauth__link" href="/login">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (stage === 'done') {
    return (
      <div className="kauth__done">
        <p className="kauth__alert kauth__alert--success" role="status">
          Password updated.
        </p>
        <p>You are signed in with your new password.</p>
        <button
          className="kauth__button"
          type="button"
          onClick={() => {
            router.replace(DASHBOARD);
            router.refresh();
          }}
        >
          Continue to dashboard
        </button>
      </div>
    );
  }

  return (
    <form className="kauth__form" onSubmit={onSubmit} noValidate>
      {formError ? (
        <p className="kauth__alert" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="kauth__field">
        <label className="kauth__label" htmlFor={passwordId}>
          New password
        </label>
        <input
          id={passwordId}
          className="kauth__input"
          type="password"
          name="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={pending}
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={errors.password ? `${passwordId}-error` : `${passwordId}-hint`}
        />
        {errors.password ? (
          <p className="kauth__error" id={`${passwordId}-error`}>
            {errors.password}
          </p>
        ) : (
          <p className="kauth__hint" id={`${passwordId}-hint`}>
            At least {MIN_PASSWORD_LENGTH} characters.
          </p>
        )}
      </div>

      <div className="kauth__field">
        <label className="kauth__label" htmlFor={confirmId}>
          Confirm new password
        </label>
        <input
          id={confirmId}
          className="kauth__input"
          type="password"
          name="confirmPassword"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          autoComplete="new-password"
          required
          disabled={pending}
          aria-invalid={errors.confirmation ? true : undefined}
          aria-describedby={errors.confirmation ? `${confirmId}-error` : undefined}
        />
        {errors.confirmation ? (
          <p className="kauth__error" id={`${confirmId}-error`}>
            {errors.confirmation}
          </p>
        ) : null}
      </div>

      <button className="kauth__button" type="submit" disabled={pending}>
        {pending ? 'Updating…' : 'Update password'}
      </button>

      <span role="status" aria-live="polite" className="kauth__hint">
        {pending ? 'Updating your password, please wait.' : ''}
      </span>
    </form>
  );
}
