import { SupabaseConfigError } from '@/lib/supabase/env';

/** Shortest password we accept client-side. Supabase enforces its own minimum too. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Pragmatic email shape check. Deliberately loose — the authoritative check is
 * the confirmation email actually arriving, and over-strict patterns reject
 * valid addresses.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type Errors = Record<string, string>;

export function validateEmail(value: string): string | undefined {
  if (!value.trim()) return 'Enter your email address.';
  if (!EMAIL_RE.test(value.trim())) return 'Enter a valid email address.';
  return undefined;
}

export function validatePassword(value: string): string | undefined {
  if (!value) return 'Enter a password.';
  if (value.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  return undefined;
}

export function validateFullName(value: string): string | undefined {
  if (!value.trim()) return 'Enter your full name.';
  if (value.trim().length < 2) return 'Enter your full name.';
  return undefined;
}

export function validateConfirmation(password: string, confirmation: string): string | undefined {
  if (!confirmation) return 'Re-enter your password.';
  if (password !== confirmation) return 'Passwords do not match.';
  return undefined;
}

/**
 * Turns a thrown value into something safe to render.
 *
 * A missing-configuration error is surfaced verbatim because it names only the
 * absent variable, which is what makes a deployment mistake diagnosable. Every
 * other failure is mapped to plain language: Supabase messages are written for
 * developers and occasionally reveal whether an address is registered.
 */
export function toMessage(error: unknown): string {
  if (error instanceof SupabaseConfigError) return error.message;

  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = raw.toLowerCase();

  if (!text) return 'Something went wrong. Please try again.';
  if (text.includes('invalid login credentials')) return 'That email and password do not match.';
  if (text.includes('email not confirmed')) {
    return 'Confirm your email address first — check your inbox for the link we sent.';
  }
  if (text.includes('user already registered') || text.includes('already been registered')) {
    return 'An account with that email already exists. Try signing in instead.';
  }
  if (text.includes('password should be')) return raw; // Supabase states its own policy clearly
  if (text.includes('rate limit') || text.includes('too many')) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  if (text.includes('same password')) return 'Choose a password you have not used before.';
  if (text.includes('expired') || text.includes('invalid') || text.includes('token')) {
    return 'That link is invalid or has expired. Request a new one.';
  }
  if (text.includes('failed to fetch') || text.includes('network')) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  return 'Something went wrong. Please try again.';
}

/** Reasons the /auth/callback handler can redirect back to /login. */
export function callbackErrorMessage(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  if (code === 'not-configured') return 'Sign-in is not available yet. Please try again later.';
  if (code === 'link-invalid') return 'That link is invalid or has expired. Request a new one.';
  return 'Something went wrong. Please try again.';
}
