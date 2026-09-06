'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';

import { createClient } from '@/lib/supabase/client';
import { safeRedirectTarget } from '@/lib/auth/routes';
import { callbackErrorMessage, toMessage, validateEmail, type Errors } from './formHelpers';

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const ids = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | undefined>(() =>
    callbackErrorMessage(params.get('error'))
  );
  const [pending, setPending] = useState(false);

  const emailId = `${ids}-email`;
  const passwordId = `${ids}-password`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);

    const next: Errors = {};
    const emailError = validateEmail(email);
    if (emailError) next.email = emailError;
    // No length rule on sign-in: an existing password may predate any policy,
    // and telling an attacker the shape of a valid password helps nobody.
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;

      // Refresh so Server Components re-read the new session cookies, then go.
      router.replace(safeRedirectTarget(params.get('redirectTo')));
      router.refresh();
    } catch (error) {
      setFormError(toMessage(error));
      setPending(false);
    }
  }

  return (
    <form className="kauth__form" onSubmit={onSubmit} noValidate>
      {formError ? (
        <p className="kauth__alert" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="kauth__field">
        <label className="kauth__label" htmlFor={emailId}>
          Email address
        </label>
        <input
          id={emailId}
          className="kauth__input"
          type="email"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={pending}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? `${emailId}-error` : undefined}
        />
        {errors.email ? (
          <p className="kauth__error" id={`${emailId}-error`}>
            {errors.email}
          </p>
        ) : null}
      </div>

      <div className="kauth__field">
        <label className="kauth__label" htmlFor={passwordId}>
          Password
        </label>
        <input
          id={passwordId}
          className="kauth__input"
          type="password"
          name="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          disabled={pending}
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={errors.password ? `${passwordId}-error` : undefined}
        />
        {errors.password ? (
          <p className="kauth__error" id={`${passwordId}-error`}>
            {errors.password}
          </p>
        ) : null}
      </div>

      <button className="kauth__button" type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>

      {/* Announced to screen readers without stealing focus. */}
      <span role="status" aria-live="polite" className="kauth__hint">
        {pending ? 'Signing in, please wait.' : ''}
      </span>

      <div className="kauth__meta">
        <Link className="kauth__link" href="/forgot-password">
          Forgot password?
        </Link>
        <span>
          No account?{' '}
          <Link className="kauth__link" href="/signup">
            Create one
          </Link>
        </span>
      </div>
    </form>
  );
}
