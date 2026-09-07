import 'server-only';

import { NextResponse } from 'next/server';

import { resolveAdmin } from '@/lib/admin/guard';
import type { AdminContext } from '@/lib/admin/guard';
import type { Capability } from '@/lib/auth/roles';

/**
 * Shared plumbing for the administrator route handlers.
 *
 * Two jobs: turn an authorization result into the right HTTP status, and make
 * sure nothing internal reaches the client. Every handler in app/api/admin
 * starts with `guardApi()` and returns through `apiError()` / `apiOk()`.
 */

/**
 * Stable, machine-readable failure codes. The browser branches on `code`; the
 * `message` is for humans and is deliberately vague about internals.
 */
export type AdminApiErrorCode =
  | 'unconfigured'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'rate_limited'
  | 'upstream_error'
  | 'internal_error';

const STATUS_BY_CODE: Readonly<Record<AdminApiErrorCode, number>> = Object.freeze({
  unconfigured: 503,
  // 401 tells the browser to re-authenticate.
  unauthenticated: 401,
  // 403, not 404. Hiding the existence of /api/admin from a signed-in
  // non-administrator would be security through obscurity, and it makes a
  // genuine misconfiguration ("why is my admin getting 404s") undiagnosable.
  // The route's existence is not the secret; the data behind it is.
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  rate_limited: 429,
  upstream_error: 502,
  internal_error: 500,
});

export interface AdminApiErrorBody {
  readonly ok: false;
  readonly code: AdminApiErrorCode;
  readonly message: string;
}

/**
 * Build an error response.
 *
 * `message` must already be safe to show a browser. Raw Supabase errors and
 * stack traces never reach here — callers log those server-side with
 * {@link logAdminError} and pass a written-for-humans string instead.
 */
export function apiError(code: AdminApiErrorCode, message: string): NextResponse<AdminApiErrorBody> {
  return NextResponse.json(
    { ok: false as const, code, message },
    {
      status: STATUS_BY_CODE[code],
      // Administrative responses carry personal data about other people. They
      // must never be stored by a shared cache or replayed from the browser's
      // back/forward cache after the administrator signs out.
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    }
  );
}

export function apiOk<T extends object>(body: T, status = 200): NextResponse {
  return NextResponse.json(
    { ok: true as const, ...body },
    { status, headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }
  );
}

/**
 * Structured server-side logging for administrative failures.
 *
 * The diagnostic detail stays here, in the platform log (Vercel captures
 * stdout/stderr per invocation), and never travels to the client. Values are
 * summarised rather than dumped so a caught Supabase error cannot carry a key
 * or a token into the log.
 */
export function logAdminError(operation: string, error: unknown, context: Record<string, string | number | null> = {}): void {
  const summary =
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: 'unknown', message: String(error) };

  console.error(
    JSON.stringify({
      level: 'error',
      scope: 'admin',
      operation,
      ...context,
      error: summary,
      at: new Date().toISOString(),
    })
  );
}

/**
 * Authorize a route handler.
 *
 * Returns either the administrator's context or a ready-to-return response.
 * Written as a discriminated union so a handler physically cannot forget to
 * check: there is no way to reach `ctx` without narrowing away the error case.
 */
export type GuardResult =
  | { readonly ok: true; readonly ctx: AdminContext }
  | { readonly ok: false; readonly response: NextResponse<AdminApiErrorBody> };

export async function guardApi(capability: Capability): Promise<GuardResult> {
  const result = await resolveAdmin(capability);

  if (result.ok) return { ok: true, ctx: { user: result.user, role: result.role } };

  switch (result.reason) {
    case 'unconfigured':
      return {
        ok: false,
        response: apiError('unconfigured', 'The administrator surface is not configured on this deployment.'),
      };
    case 'unauthenticated':
      return { ok: false, response: apiError('unauthenticated', 'Sign in to continue.') };
    case 'forbidden':
    default:
      // Logged, because a signed-in user probing an admin endpoint is worth
      // seeing. The response says nothing about who they are or what they lack.
      logAdminError('authorization.denied', new Error('forbidden'), {
        user_id: result.reason === 'forbidden' ? result.user.id : null,
        capability,
      });
      return {
        ok: false,
        response: apiError('forbidden', 'You do not have permission to perform that operation.'),
      };
  }
}

/** A UUID, validated before it is ever used in a query or an admin API call. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value);

/**
 * Deliberately conservative: length-bounded, single '@', no whitespace. The
 * authoritative check is Supabase's own on invite; this exists so obvious
 * rubbish is rejected before it becomes an upstream call.
 */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const isEmail = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 320 && EMAIL_RE.test(value);

/** Parse a JSON body without letting a malformed one throw past the handler. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
