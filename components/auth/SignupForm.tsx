'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';

import { createClient } from '@/lib/supabase/client';
import { DASHBOARD } from '@/lib/auth/routes';
import {
  MIN_PASSWORD_LENGTH,
  toMessage,
  validateConfirmation,
  validateEmail,
  validateFullName,
  validatePassword,
  type Errors,
} from './formHelpers';

export default function SignupForm() {
  const router = useRouter();
  const ids = useId();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  /** Set when the project requires email confirmation before first sign-in. */
  const [confirmSent, setConfirmSent] = useState(false);

  const nameId = `${ids}-name`;
  const emailId = `${ids}-email`;
  const passwordId = `${ids}-password`;
  const confirmId = `${ids}-confirm`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);

    const next: Errors = {};
    const nameError = validateFullName(fullName);
    const emailError = validateEmail(email);
    const passwordError = validatePassword(password);
    const confirmError = validateConfirmation(password, confirmation);
    if (nameError) next.fullName = nameError;
    if (emailError) next.email = emailError;
    if (passwordError) next.password = passwordError;
    if (confirmError) next.confirmation = confirmError;
    setErrors(next);
    if (Object.keys(next).length) return;

    setPending(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          // Stored on the user record as user_metadata.full_name.
          data: { full_name: fullName.trim() },
          // Where the confirmation link lands. Must be listed in Supabase's
          // Redirect URLs allow-list or Supabase refuses to send it there.
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(DASHBOARD)}`,
        },
      });
      if (error) throw error;

      // Supabase returns a session only when email confirmation is disabled.
      // With confirmation on, `session` is null and the user must click the link.
      if (data.session) {
        router.replace(DASHBOARD);
        router.refresh();
        return;
      }
      setConfirmSent(true);
      setPending(false);
    } catch (error) {
      setFormError(toMessage(error));
      setPending(false);
    }
  }

  if (confirmSent) {
    return (
      <div className="kauth__done">
        <p className="kauth__alert kauth__alert--success" role="status">
          Account created. Confirm your email to finish.
        </p>
        <p>
          We sent a confirmation link to <span className="kauth__email">{email.trim()}</span>. Open it
          on this device to activate your account and sign in.
        </p>
        <p className="kauth__hint">
          No email after a minute or two? Check your spam folder — the link expires, so request a new
          one from the sign-in page if it has.
        </p>
        <div className="kauth__meta">
          <Link className="kauth__link" href="/login">
            Go to sign in
          </Link>
        </div>
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
        <label className="kauth__label" htmlFor={nameId}>
          Full name
        </label>
        <input
          id={nameId}
          className="kauth__input"
          type="text"
          name="fullName"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          autoComplete="name"
          required
          disabled={pending}
          aria-invalid={errors.fullName ? true : undefined}
          aria-describedby={errors.fullName ? `${nameId}-error` : undefined}
        />
        {errors.fullName ? (
          <p className="kauth__error" id={`${nameId}-error`}>
            {errors.fullName}
          </p>
        ) : null}
      </div>

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
          Confirm password
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
        {pending ? 'Creating account…' : 'Create account'}
      </button>

      <span role="status" aria-live="polite" className="kauth__hint">
        {pending ? 'Creating your account, please wait.' : ''}
      </span>

      <div className="kauth__meta">
        <span>
          Already have an account?{' '}
          <Link className="kauth__link" href="/login">
            Sign in
          </Link>
        </span>
      </div>
    </form>
  );
}
