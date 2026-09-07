/**
 * The shape a profile form action returns.
 *
 * Lives in its own module because `lib/candidate/actions.ts` carries the
 * `'use server'` directive, and such a file may export ONLY async functions —
 * every export becomes a callable server endpoint, so a plain object or a type
 * alias there is a build error, not a style issue. Splitting the value out is
 * the fix, and it also lets the client form import the type without pulling the
 * server module into a client bundle.
 */

export interface FormState {
  readonly ok: boolean;
  readonly message?: string;
  /** Field-level messages, keyed by input name. */
  readonly issues?: Record<string, string>;
}

/** Starting state, before a form has been submitted. */
export const IDLE: FormState = { ok: true };
