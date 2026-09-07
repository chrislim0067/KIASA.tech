/**
 * The result contract for the candidate-profile data layer.
 *
 * Expected failures are returned, not thrown, so an agent runtime can branch on
 * a stable value instead of parsing exception text. Every category below is
 * mapped from a signal observed against a real local Supabase stack, not from
 * documentation — see `scripts/test-data-layer-errors.mjs`, which provokes each
 * one and asserts the mapping.
 */

/**
 * What a caller should DO about a failure. An autonomous agent branches on this
 * alone: retry, ask the human, or stop.
 */
export type ErrorCategory =
  /** No authenticated identity, or an id that does not match the session. Stop. */
  | 'unauthenticated'
  /** Authenticated but not permitted — RLS denial, or a reserved value. Stop. */
  | 'forbidden'
  /** The row does not exist, or is not visible to this user. Often expected. */
  | 'not_found'
  /** Failed the layer's own mirror of a constraint; never reached the database. */
  | 'invalid_input'
  /** The database rejected it (CHECK / NOT NULL). Fix the value, then retry. */
  | 'constraint_violation'
  /** Uniqueness collision. For a create, usually means "update instead". */
  | 'conflict'
  /** A database-managed column was written. A programming error. */
  | 'immutable_field'
  /** A referenced row is missing. */
  | 'foreign_key_violation'
  /** Schema/database object missing or stale cache. Deploy problem, not input. */
  | 'schema_mismatch'
  /** Transport failure. Safe to retry with backoff. */
  | 'unavailable'
  /** Unmapped. Treated as non-retryable; escalate. */
  | 'unknown';

/** Categories where retrying the identical call could plausibly succeed. */
export const RETRYABLE_CATEGORIES: readonly ErrorCategory[] = Object.freeze(['unavailable']);

/**
 * Categories that mean a human must decide. An agent must not attempt to work
 * around these by inventing or altering candidate facts.
 */
export const HUMAN_ESCALATION_CATEGORIES: readonly ErrorCategory[] = Object.freeze([
  'forbidden', 'constraint_violation', 'invalid_input', 'conflict', 'immutable_field',
]);

export interface DataLayerError {
  readonly category: ErrorCategory;
  /** Stable identifier for this specific failure. Safe to branch on and to log. */
  readonly code: string;
  /**
   * Safe for display. Deliberately free of SQL, constraint internals, table
   * names and connection details, so it can cross to the browser.
   */
  readonly message: string;
  /** The field the failure concerns, when it is attributable to one. */
  readonly field?: string;
  /**
   * Server-side only. Holds the raw driver code and message for logs. Never
   * send this to a browser; nothing in the layer does.
   */
  readonly detail?: string;
  /** True when retrying the identical call could plausibly succeed. */
  readonly retryable: boolean;
  /** True when a human decision is required before proceeding. */
  readonly requiresHuman: boolean;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: DataLayerError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });

export function fail(
  category: ErrorCategory,
  code: string,
  message: string,
  options: { field?: string; detail?: string } = {},
): Result<never> {
  return {
    ok: false,
    error: {
      category,
      code,
      message,
      ...(options.field === undefined ? {} : { field: options.field }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      retryable: RETRYABLE_CATEGORIES.includes(category),
      requiresHuman: HUMAN_ESCALATION_CATEGORIES.includes(category),
    },
  };
}

/** The shape supabase-js returns in `error`. Structural, so no import is needed. */
export interface PostgrestLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

/**
 * Observed signals, each measured against a local stack rather than assumed:
 *
 *   PGRST116  `.single()` matched no row
 *   PGRST202  function missing from the schema cache
 *   PGRST204  column missing from the schema cache
 *   23514     CHECK violation (bad format, invisible-only element, over-limit)
 *   23505     unique violation
 *   23502     NOT NULL violation (e.g. a half-specified work authorization)
 *   23503     foreign key violation
 *   428C9     write to a GENERATED column
 *   42501     RLS denial, a reserved `source`, or an anonymous caller
 *   42883     undefined function — what a dropped CHECK helper would surface as
 *
 * 42501 deliberately maps to `forbidden` rather than `not_found`: it means the
 * server refused, and blurring that into "missing" would hide a real denial.
 */
export function mapPostgrestError(
  error: PostgrestLikeError | null | undefined,
  context: { table?: string; operation?: string } = {},
): Result<never> {
  const code = error?.code ?? '';
  const raw = error?.message ?? '';
  const where = context.table ? ` (${context.operation ?? 'operation'} on ${context.table})` : '';
  const detail = `${code}${raw ? `: ${raw}` : ''}${where}`;

  switch (code) {
    case 'PGRST116':
      return fail('not_found', 'row_not_found', 'The requested record does not exist.', { detail });
    case '23514':
      return fail(
        'constraint_violation',
        'check_violation',
        'A value was rejected by the database rules. It may be empty, contain only invisible characters, be too long, or be outside the allowed set.',
        { field: constraintField(raw), detail },
      );
    case '23505':
      return fail('conflict', 'unique_violation', 'A record with those key values already exists.', {
        field: constraintField(raw), detail,
      });
    case '23502':
      return fail(
        'constraint_violation',
        'not_null_violation',
        'A required value was missing. Partial records are not accepted; supply every required field or none.',
        { field: nullColumn(raw), detail },
      );
    case '23503':
      return fail('foreign_key_violation', 'foreign_key_violation', 'A referenced record does not exist.', { detail });
    case '428C9':
      return fail(
        'immutable_field',
        'generated_column_write',
        'That value is computed by the database and cannot be written.',
        { field: quoted(raw), detail },
      );
    case '42501':
      return fail(
        'forbidden',
        raw.includes('reserved for server-side') ? 'reserved_value' : 'permission_denied',
        raw.includes('reserved for server-side')
          ? 'That value is reserved for server-side workflows and cannot be set by an application client.'
          : 'You do not have permission to perform that operation.',
        { detail },
      );
    case '42883':
      return fail(
        'schema_mismatch',
        'undefined_function',
        'A required database function is missing. The database schema is not in the expected state.',
        { detail },
      );
    case 'PGRST202':
      return fail('schema_mismatch', 'function_not_found', 'A required database function is unavailable.', { detail });
    case 'PGRST204':
      return fail('schema_mismatch', 'column_not_found', 'A required column is unavailable.', { detail });
    default:
      break;
  }

  // supabase-js surfaces transport problems with no PostgREST code.
  if (!code && /fetch|network|ECONNREFUSED|timeout|socket/i.test(raw)) {
    return fail('unavailable', 'transport_error', 'The database could not be reached. Try again shortly.', { detail });
  }
  return fail('unknown', 'unmapped_error', 'The operation failed for an unexpected reason.', { detail });
}

/** `...violates check constraint "x"` / `...unique constraint "x"` -> `x`. */
function constraintField(message: string): string | undefined {
  return /constraint "([^"]+)"/.exec(message)?.[1];
}

/** `null value in column "x" of relation ...` -> `x`. */
function nullColumn(message: string): string | undefined {
  return /column "([^"]+)"/.exec(message)?.[1];
}

function quoted(message: string): string | undefined {
  return /"([^"]+)"/.exec(message)?.[1];
}
