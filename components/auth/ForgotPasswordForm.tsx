'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';

import { createClient } from '@/lib/supabase/client';
import { toMessage, validateEmail, type Errors } from './formHelpers';

export default function ForgotPasswordForm() {
  const ids = useId();
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  const emailId = `${ids}-email`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);

    const emailError = validateEmail(email);
    setErrors(emailError ? { email: emailError } : {});
    if (emailError) return;

    setPending(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        // The recovery link lands here; the callback verifies it and forwards to
        // /reset-password with a live session so a new password can be set.
        redirectTo: `${window.location.origin}/auth/callback?next=%2Freset-password`,
      });
      if (error) throw error;
      setSent(true);
    } catch (error) {
      setFormError(toMessage(error));
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <div className="kauth__done">
        {/*
          Deliberately the same message whether or not the address has an
          account: confirming which emails are registered would leak the user
          list to anyone with the form.
        */}
        <p className="kauth__alert kauth__alert--success" role="status">
          Check your inbox.
        </p>
        <p>
          If an account exists for <span className="kauth__email">{email.trim()}</span>, we have sent
          a link to reset the password. It expires after a short time.
        </p>
        <div className="kauth__meta">
          <Link className="kauth__link" href="/login">
            Back to sign in
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

      <button className="kauth__button" type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Send reset link'}
      </button>

      <span role="status" aria-live="polite" className="kauth__hint">
        {pending ? 'Sending the reset link, please wait.' : ''}
      </span>

      <div className="kauth__meta">
        <Link className="kauth__link" href="/login">
          Back to sign in
        </Link>
        <Link className="kauth__link" href="/signup">
          Create an account
        </Link>
      </div>
    </form>
  );
}
