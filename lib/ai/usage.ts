import { z } from 'zod';

/**
 * What an AI provider call is allowed to record about itself.
 *
 * METADATA ONLY, AND THE SHAPE IS THE ENFORCEMENT.
 *
 * There is no field here for a prompt, a completion, a résumé, a candidate
 * fact, a header or a key — not "we agree not to store them", but nowhere to
 * put them. The schema is `.strict()`, so a caller that adds `prompt` or
 * `response` gets a validation failure rather than a row containing a person's
 * employment history.
 *
 * That matters more than usual here. The one thing this platform sends to a
 * third party is the text of somebody's résumé, and a usage table is exactly
 * the sort of well-meaning "just for debugging" surface that ends up holding a
 * copy of it.
 *
 * WHAT IS RECORDED, AND WHY EACH EARNS ITS PLACE
 *
 *   provider/model      which thing was called, so a bad model is identifiable
 *   operation           what it was for, so cost can be attributed
 *   status              succeeded, failed, or refused before any call
 *   failure_class/code  the same vocabulary the résumé path already uses
 *   latency_ms          the number that tells you the timeout is wrong
 *   attempts            retries, so a quiet retry storm is visible
 *   prompt/completion/total tokens, cost   only when the provider reports them
 *   request_id          the provider's own id, for a support conversation
 *   correlation_id      ours, to tie a call to the import it belonged to
 */

export const PROVIDER_USAGE_STATUSES = ['succeeded', 'failed', 'not_attempted'] as const;
export type ProviderUsageStatus = (typeof PROVIDER_USAGE_STATUSES)[number];

/** The operations that may call a provider. Extended deliberately, not casually. */
export const PROVIDER_OPERATIONS = ['resume_extraction', 'job_scoring'] as const;
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];

/**
 * The operations the DATABASE currently accepts — a SUBSET of the above.
 *
 * `provider_usage.operation` carries a CHECK constraint that today lists
 * `resume_extraction` only (migration 21). Milestone 2C added `job_scoring` to
 * the vocabulary above but is not permitted to touch migrations, so the two
 * are deliberately out of step for now.
 *
 * That gap is made EXPLICIT here rather than left latent. Without this list,
 * the first caller to persist a `job_scoring` row would get a constraint
 * violation from PostgREST at runtime — the kind of defect that only appears
 * once real traffic exists. `recordProviderUsage()` consults this list and
 * refuses up front with a named reason instead.
 *
 * TO CLOSE THE GAP: a later migration must extend the CHECK to match
 * `PROVIDER_OPERATIONS`, after which this list becomes the same set and can be
 * deleted. Until then, job-scoring usage is reported in telemetry and not
 * persisted.
 */
export const PERSISTABLE_OPERATIONS: readonly ProviderOperation[] = ['resume_extraction'];

export const isPersistableOperation = (operation: ProviderOperation): boolean =>
  PERSISTABLE_OPERATIONS.includes(operation);

const nonNegativeInt = z.number().int().min(0);

export const ProviderUsageRecord = z
  .object({
    provider: z.literal('openrouter'),
    model: z.string().min(1).max(200),
    operation: z.enum(PROVIDER_OPERATIONS),
    status: z.enum(PROVIDER_USAGE_STATUSES),

    /** Present only when the call failed; matches the résumé failure vocabulary. */
    failure_class: z.string().min(1).max(40).nullable(),
    failure_code: z.string().min(1).max(100).nullable(),

    /** Wall-clock time for the whole attempt sequence, including retries. */
    latency_ms: nonNegativeInt.max(3_600_000),
    /** 0 when the call was refused before any request was made. */
    attempts: nonNegativeInt.max(50),

    /** Only ever what the provider itself reported. Never estimated. */
    prompt_tokens: nonNegativeInt.max(100_000_000).nullable(),
    completion_tokens: nonNegativeInt.max(100_000_000).nullable(),
    total_tokens: nonNegativeInt.max(100_000_000).nullable(),

    /**
     * The provider's own reported cost, in USD. Null unless OpenRouter
     * returned it — a locally estimated cost is a guess that looks like an
     * invoice, and someone will eventually reconcile against it.
     */
    cost_usd: z.number().min(0).max(10_000).nullable(),

    /** The provider's request id, when it sends one. Opaque, not sensitive. */
    provider_request_id: z.string().min(1).max(200).nullable(),

    /** Ours: ties this call to the import it belonged to. */
    correlation_id: z.uuid().nullable(),
  })
  .strict()
  /*
   * The same invariant the database enforces, in the same words.
   *
   * Written against `succeeded` rather than `failed`. A `not_attempted` call —
   * refused before any request because the provider was not configured — has a
   * reason, and an earlier version of the CHECK constraint forbade one. The
   * contract and the table disagreed, so every unconfigured call would have
   * failed to record; CI caught it. They are kept identical here so the next
   * change to either is caught by the other.
   */
  .refine(
    (r) => (r.status === 'succeeded') === (r.failure_class === null),
    { message: 'a succeeded call carries no failure_class; any other outcome must' }
  );

export type ProviderUsageRecord = z.infer<typeof ProviderUsageRecord>;

/**
 * Field names that must never appear on a usage record.
 *
 * `.strict()` already rejects unknown keys; this exists so a test can state
 * the rule in the terms a reviewer cares about, and so the list is somewhere
 * a person adding a field will read it.
 */
export const FORBIDDEN_USAGE_FIELDS = [
  'prompt',
  'system',
  'user',
  'messages',
  'input',
  'output',
  'completion',
  'response',
  'text',
  'resume',
  'resume_text',
  'extracted',
  'content',
  'api_key',
  'apiKey',
  'authorization',
  'headers',
  'candidate',
] as const;

/** Parse, or explain why not. Never throws. */
export function parseUsageRecord(value: unknown): ProviderUsageRecord | null {
  const result = ProviderUsageRecord.safeParse(value);
  return result.success ? result.data : null;
}
