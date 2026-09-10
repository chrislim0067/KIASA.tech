import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { ProviderUsageRecord } from '@/lib/ai/usage';

/**
 * Persisting what a provider call cost and how it went.
 *
 * WHY THIS IS THE ONLY WRITER, AND WHY IT IS DELIBERATELY DULL
 *
 * `provider_usage` is metadata about money and reliability. It is not a debug
 * log, and the difference matters: the one thing this platform sends to a
 * third party is the text of somebody's résumé, and a usage table is exactly
 * the well-meaning "just for debugging" surface that ends up holding a copy of
 * it. So this module takes a validated `ProviderUsageRecord` and writes
 * precisely its fields — it does not accept a free-form object, it does not
 * spread caller input into the row, and there is nowhere for a prompt to enter.
 *
 * WHY IT NEVER THROWS
 *
 * A failure to record accounting must never fail the thing being accounted
 * for. A candidate whose résumé parsed correctly should not see an error
 * because a metrics insert timed out. Every path returns a discriminated
 * result the caller may ignore, and nothing here is on the critical path of
 * the import.
 *
 * WHY IT USES THE ELEVATED CLIENT
 *
 * The table grants `INSERT` to `service_role` only. A row here is an assertion
 * about what OUR SERVER did and what it was charged; a browser cannot know
 * either, so `authenticated` holds `SELECT` on its own rows and nothing more.
 * This is the one place that elevation is used for usage, and it writes a
 * fixed, validated column set — never caller-shaped data.
 */

export type UsageWriteResult =
  | { ok: true; id: string }
  | {
      ok: false;
      /** Why it did not persist. Never a provider payload or a database row. */
      reason:
        | 'not_configured'
        | 'invalid_record'
        | 'rejected_by_database'
        | 'unexpected';
      /** Short, safe, and free of candidate data. */
      detail: string;
    };

/** The exact column set. Nothing else is ever written. */
interface UsageRow {
  user_id: string | null;
  provider: string;
  model: string;
  operation: string;
  status: string;
  failure_class: string | null;
  failure_code: string | null;
  latency_ms: number;
  attempts: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  provider_request_id: string | null;
  correlation_id: string | null;
}

/**
 * Build the row from a validated record.
 *
 * Field by field, not by spreading. A spread would carry whatever a future
 * caller had attached to the object, and `.strict()` on the schema is the
 * first line of that defence rather than the only one — this is the second.
 * `created_at` is deliberately absent: the database stamps it, and a caller
 * does not get to choose when a charge happened.
 */
export function toUsageRow(record: ProviderUsageRecord, userId: string | null): UsageRow {
  return {
    user_id: userId,
    provider: record.provider,
    model: record.model,
    operation: record.operation,
    status: record.status,
    failure_class: record.failure_class,
    failure_code: record.failure_code,
    latency_ms: record.latency_ms,
    attempts: record.attempts,
    prompt_tokens: record.prompt_tokens,
    completion_tokens: record.completion_tokens,
    total_tokens: record.total_tokens,
    cost_usd: record.cost_usd,
    provider_request_id: record.provider_request_id,
    correlation_id: record.correlation_id,
  };
}

/** Every key `toUsageRow` may produce. Used by the tests to assert the shape. */
export const USAGE_ROW_KEYS = [
  'user_id',
  'provider',
  'model',
  'operation',
  'status',
  'failure_class',
  'failure_code',
  'latency_ms',
  'attempts',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cost_usd',
  'provider_request_id',
  'correlation_id',
] as const;

/**
 * Record one provider call.
 *
 * @param record   metadata about the call, validated here rather than trusted
 * @param userId   the candidate the call was made for, or null when unknown
 * @param client   injected in tests; defaults to the elevated server client
 */
export async function recordProviderUsage(
  record: unknown,
  userId: string | null,
  client?: Pick<SupabaseClient, 'from'>
): Promise<UsageWriteResult> {
  // Validate before anything else. An unknown key, a prompt smuggled onto the
  // object, a negative latency or a status that disagrees with its failure
  // class all stop here rather than reaching the database.
  const parsed = ProviderUsageRecord.safeParse(record);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_record',
      // Field paths only. Zod messages can quote offending VALUES, and a value
      // here could be anything a caller mistakenly attached.
      detail: parsed.error.issues
        .map((i) => i.path.join('.') || '(root)')
        .slice(0, 8)
        .join(', '),
    };
  }

  /*
   * There is no persistability guard here any more, and its absence is the
   * point.
   *
   * Milestone 2C added `job_scoring` to the vocabulary while forbidden from
   * touching migrations, so the TypeScript enum and the database CHECK were
   * deliberately out of step, and this function refused the difference up
   * front. Migration 23 closed that gap: the CHECK now lists exactly
   * `PROVIDER_OPERATIONS`, and a parity test asserts it in both directions.
   *
   * So the Zod enum above is the only gate needed. An unknown operation is
   * `invalid_record` before anything reaches the database, and a known one is
   * accepted by the constraint by construction. A second list here would just
   * be a third place for the vocabulary to drift.
   */

  let db = client;
  if (!db) {
    if (!isAdminConfigured()) {
      return {
        ok: false,
        reason: 'not_configured',
        detail: 'the elevated client is not configured',
      };
    }
    db = createAdminClient();
  }

  try {
    const { data, error } = await db
      .from('provider_usage')
      .insert(toUsageRow(parsed.data, userId))
      .select('id')
      .maybeSingle<{ id: string }>();

    if (error) {
      return {
        ok: false,
        reason: 'rejected_by_database',
        // The code, never the message: PostgREST error messages quote the
        // failing row, and the failing row is the thing being protected.
        detail: error.code ?? 'unknown',
      };
    }
    if (!data?.id) {
      return { ok: false, reason: 'unexpected', detail: 'insert returned no id' };
    }
    return { ok: true, id: data.id };
  } catch (error) {
    return {
      ok: false,
      reason: 'unexpected',
      detail: (error as { name?: string })?.name ?? 'error',
    };
  }
}
