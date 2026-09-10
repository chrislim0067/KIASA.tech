import 'server-only';

import { z } from 'zod';

import { PROVIDER, providerConfig } from '@/lib/ai/config';
import { toStrictJsonSchema } from '@/lib/ai/json-schema';
import type { ProviderOperation, ProviderUsageRecord } from '@/lib/ai/usage';

/**
 * The OpenRouter adapter.
 *
 * The ONLY place in this application that talks to an AI provider. There is no
 * second provider and no fallback: a fallback is a second thing to secure, a
 * second billing surface, and a second set of failure modes that surface only
 * when the first provider is already having a bad day.
 *
 * Claude Max is NOT reachable from here. It stays a separate capability the
 * user drives on their own machine, under their own account. Nothing here
 * reads a browser session, a cookie, a local token store or a private
 * endpoint, and nothing should ever be added that does.
 *
 * WHAT THIS GUARANTEES
 *
 *   * server-only, so importing it from a client component is a build error
 *     rather than a published key;
 *   * a bounded timeout and a bounded number of retries;
 *   * a request schema the provider will actually accept (see
 *     lib/ai/json-schema.ts — Zod emits keywords strict mode rejects outright);
 *   * structured output validated with the project's own Zod schema, because
 *     the provider's word is never taken for the shape;
 *   * normalised failure categories the caller can act on;
 *   * a usage record carrying metadata only;
 *   * NOTHING from the prompt or the response in any log line. A résumé is the
 *     most sensitive document this platform handles, and a debug log is the
 *     easiest place to leak one.
 */

/** Below the route's own budget (maxDuration 300), so a slow provider fails first. */
export const REQUEST_TIMEOUT_MS = 90_000;

/** One retry. More multiplies the wait a candidate is staring at. */
export const MAX_ATTEMPTS = 2;

/**
 * Every way a provider call can fail, as a VALUE rather than only a type.
 *
 * It is a value because the database now holds this same vocabulary in a CHECK
 * constraint on `resume_imports.provider_failure_code`, and two copies of a
 * list drift. A parity test walks this array against that constraint, so a
 * member added here without the matching migration fails a test rather than
 * failing silently in production on the one row that needed it.
 *
 * The ordering is deliberate: everything that went wrong before the model was
 * reached, then what the model did.
 */
export const PROVIDER_FAILURE_CODES = [
  'not_configured',
  'timeout',
  'rate_limited',
  'auth_failed',
  'bad_request',
  'server_error',
  'connection_failed',
  'no_content',
  /**
   * The model hit the output ceiling before finishing. `finish_reason:
   * "length"`.
   *
   * Separated from `no_content` because they need different answers from a
   * human: truncation means the budget was too small (or the model spent it on
   * reasoning tokens), while `no_content` means it produced nothing at all.
   * Collapsing them is why Milestone 2C.2 could only offer a hypothesis — the
   * one field that would have settled it was being discarded.
   */
  'output_truncated',
  /**
   * The model produced reasoning and no answer.
   *
   * Reported so the diagnosis is visible, NEVER so the reasoning can be used.
   * Reasoning text is not a structured answer and is never parsed as one.
   */
  'reasoning_only',
  /** The model explicitly declined. `refusal`, or `finish_reason` says so. */
  'refused',
  'malformed_json',
  'invalid_structure',
] as const;

export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

/** At most this many paths, and at most this many characters, are reported. */
export const MAX_FAILURE_DETAIL_PATHS = 8;
export const MAX_FAILURE_DETAIL_CHARS = 300;

/**
 * Which fields failed validation — as PATHS, never as values.
 *
 * When a provider returns well-formed JSON that is not a résumé, the useful
 * question is "which field?". Zod answers it precisely and the answer was being
 * discarded, so a production failure could only be guessed at.
 *
 * WHAT THIS DELIBERATELY DOES NOT READ
 *
 * `issue.message`. Zod messages quote the offending VALUE — "Invalid input:
 * expected string, received 214-555-0142" — and in a résumé the offending value
 * is somebody's phone number, employer or address. Only `issue.path` is read,
 * which holds keys and array indices and nothing else.
 *
 * The output is then filtered to a path-shaped character set as a second line
 * of defence: no spaces, no quotes, no punctuation a sentence would need. Even
 * if a future Zod put content in a path, it could not survive this.
 */
export function describeSchemaFailure(issues: readonly { path: PropertyKey[] }[]): string {
  const seen = new Set<string>();

  for (const issue of issues) {
    const path = issue.path
      .map((segment) => String(segment))
      .join('.')
      // Keys, indices and separators only. Anything else is dropped, not
      // escaped: there is no legitimate path character outside this set.
      .replace(/[^a-zA-Z0-9_.]/g, '');

    if (path !== '') seen.add(path);
    if (seen.size >= MAX_FAILURE_DETAIL_PATHS) break;
  }

  // An empty result is honest: it means Zod reported no usable path, which is
  // itself worth seeing rather than papering over.
  return [...seen].join(',').slice(0, MAX_FAILURE_DETAIL_CHARS);
}

/** Metadata about the call, always returned, success or failure. */
export interface CallTelemetry {
  usage: ProviderUsageRecord;
}

export type ProviderResult<T> =
  | ({ ok: true; data: T; model: string; attempts: number } & CallTelemetry)
  | ({
      ok: false;
      code: ProviderFailureCode;
      /** HTTP status when there was one. Never a response body. */
      status?: number;
      retryable: boolean;
      attempts: number;
      /**
       * Which fields failed schema validation, as a comma-separated list of
       * PATHS — `work_experiences.3.end_date`. Present only for
       * `invalid_structure`, because it is the only outcome where a field can
       * be named.
       *
       * Never a value, never a message, never a fragment of the document. See
       * `describeSchemaFailure`.
       */
      detail?: string;
    } & CallTelemetry);

/** Present and non-empty. Checked at call time so a missing key fails cleanly. */
export function isOpenRouterConfigured(): boolean {
  const result = providerConfig();
  return result.ok;
}

/** Map an HTTP status onto a category and whether trying again could help. */
function classifyStatus(status: number): { code: ProviderFailureCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'auth_failed', retryable: false };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status >= 500) return { code: 'server_error', retryable: true };
  return { code: 'bad_request', retryable: false };
}

/**
 * Failure classes matching `resume_imports.failure_class`, so a usage row and
 * an import row describe the same event in the same words.
 */
function failureClassFor(code: ProviderFailureCode): string {
  switch (code) {
    case 'timeout':
      return 'timeout';
    case 'no_content':
    case 'output_truncated':
    case 'reasoning_only':
    case 'refused':
    case 'malformed_json':
    case 'invalid_structure':
      return 'unreadable';
    default:
      return 'model_error';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull token counts out of a provider reply without trusting its shape. */
function readUsage(payload: unknown): {
  prompt: number | null;
  completion: number | null;
  total: number | null;
  cost: number | null;
} {
  const u = (payload as { usage?: Record<string, unknown> })?.usage;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const money = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  return {
    prompt: num(u?.prompt_tokens),
    completion: num(u?.completion_tokens),
    total: num(u?.total_tokens),
    // OpenRouter reports actual cost on the usage object. Never estimated.
    cost: money(u?.cost),
  };
}

export interface StructuredRequest<T> {
  /** The Zod schema the reply must satisfy. Also becomes the JSON schema sent. */
  schema: z.ZodType<T>;
  /** A name for the schema; strict mode requires one. */
  schemaName: string;
  /** What this call is for, recorded on the usage row. */
  operation: ProviderOperation;
  system: string;
  user: string;
  /**
   * The model to use, overriding the configured résumé model.
   *
   * Supplied by callers that resolve their own: `lib/ai/job-scoring.ts` reads
   * `OPENROUTER_MODEL` and FAILS CLOSED when it is unset, rather than
   * inheriting the résumé path's default. Omitting it keeps the previous
   * behaviour byte for byte, so the résumé path is unchanged.
   *
   * A model SLUG — never a URL, never a credential. The caller validates it
   * against the same pattern `lib/ai/config.ts` uses.
   */
  model?: string;
  /**
   * A ceiling on generated tokens.
   *
   * Omitted by the résumé path, which keeps its previous behaviour exactly.
   * Supplied where the reply is a small fixed object: a schema that can only
   * hold four short fields has no honest reason to generate a thousand tokens,
   * and a cap is a cost control that does not depend on the model behaving.
   */
  maxOutputTokens?: number;
  /** Ties the call to the record it belongs to. */
  correlationId?: string | null;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so retry backoff does not slow the suite. */
  sleepImpl?: (ms: number) => Promise<unknown>;
  /** Injected in tests so latency is deterministic. */
  nowImpl?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
}

/**
 * One structured completion, validated.
 *
 * Returns a discriminated result rather than throwing: every caller has to
 * decide what to tell the candidate, and an exception makes that easy to
 * forget.
 */
export async function completeStructured<T>(
  request: StructuredRequest<T>
): Promise<ProviderResult<T>> {
  const {
    schema,
    schemaName,
    operation,
    system,
    user,
    model: modelOverride,
    maxOutputTokens,
    correlationId = null,
    fetchImpl = fetch,
    sleepImpl = sleep,
    nowImpl = Date.now,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxAttempts = MAX_ATTEMPTS,
  } = request;

  const started = nowImpl();

  const config = providerConfig();
  if (!config.ok) {
    return {
      ok: false,
      code: 'not_configured',
      retryable: false,
      attempts: 0,
      usage: {
        provider: PROVIDER,
        model: 'unknown',
        operation,
        status: 'not_attempted',
        failure_class: 'model_error',
        failure_code: 'not_configured',
        latency_ms: Math.max(0, nowImpl() - started),
        attempts: 0,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        cost_usd: null,
        provider_request_id: null,
        correlation_id: correlationId,
      },
    };
  }

  const { apiKey, baseUrl } = config.config;
  // The caller's model wins when supplied; otherwise the configured default,
  // exactly as before.
  const model = modelOverride ?? config.config.model;
  const url = `${baseUrl}/chat/completions`;

  // Zod emits keywords strict structured output rejects outright — measured at
  // 43 occurrences on the résumé schema. Structure and descriptions survive;
  // the real enforcement is the Zod validation of the reply below.
  const jsonSchema = toStrictJsonSchema(z.toJSONSchema(schema, { io: 'output' }));

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema: jsonSchema },
    },
    /*
     * ROUTE ONLY TO ENDPOINTS THAT HONOUR THE PARAMETERS ABOVE.
     *
     * OpenRouter fronts many providers for the same model, and they do not all
     * support structured outputs. Without this, `response_format` and
     * `strict: true` are advisory: the request can be routed to an endpoint
     * that ignores them and replies with whatever it likes — which is
     * indistinguishable, from here, from a model that simply misbehaved.
     *
     * `require_parameters` narrows routing to endpoints that actually support
     * every parameter sent. Preferring a clean failure over a silent
     * downgrade is the same posture as the rest of this file.
     */
    provider: { require_parameters: true },
    // Transcription, not composition: no room for invention.
    temperature: 0,
    usage: { include: true },
    ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
  });

  const finish = (
    partial: Omit<ProviderUsageRecord, 'provider' | 'model' | 'operation' | 'latency_ms' | 'correlation_id'>
  ): ProviderUsageRecord => ({
    provider: PROVIDER,
    model,
    operation,
    latency_ms: Math.max(0, nowImpl() - started),
    correlation_id: correlationId,
    ...partial,
  });

  let attempts = 0;
  let last: ProviderResult<T> = {
    ok: false,
    code: 'connection_failed',
    retryable: true,
    attempts: 0,
    usage: finish({
      status: 'failed',
      failure_class: 'model_error',
      failure_code: 'connection_failed',
      attempts: 0,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      cost_usd: null,
      provider_request_id: null,
    }),
  };

  const fail = (
    code: ProviderFailureCode,
    retryable: boolean,
    status?: number,
    extra: Partial<ProviderUsageRecord> = {}
    // The failure member specifically, so the invalid_structure branch can
    // add a `detail` to it without TypeScript fearing the success shape.
  ): Extract<ProviderResult<T>, { ok: false }> => ({
    ok: false,
    code,
    ...(status === undefined ? {} : { status }),
    retryable,
    attempts,
    usage: finish({
      status: 'failed',
      failure_class: failureClassFor(code),
      failure_code: code,
      attempts,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      cost_usd: null,
      provider_request_id: null,
      ...extra,
    }),
  });

  while (attempts < maxAttempts) {
    attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // OpenRouter attribution headers. Public, non-secret.
          'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kiasa.tech',
          'X-Title': 'KIASA',
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as { name?: string })?.name === 'AbortError';
      last = fail(aborted ? 'timeout' : 'connection_failed', true);
      if (attempts < maxAttempts) {
        await sleepImpl(250 * attempts);
        continue;
      }
      return last;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const { code, retryable } = classifyStatus(response.status);
      last = fail(code, retryable, response.status);
      if (retryable && attempts < maxAttempts) {
        await sleepImpl(250 * attempts);
        continue;
      }
      return last;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // A 200 that is not JSON is not worth retrying; the provider is
      // answering, just not with what was asked for.
      return fail('malformed_json', false, response.status);
    }

    const tokens = readUsage(payload);
    const requestId =
      typeof (payload as { id?: unknown })?.id === 'string'
        ? ((payload as { id: string }).id.slice(0, 200) as string)
        : null;
    const observed = {
      prompt_tokens: tokens.prompt,
      completion_tokens: tokens.completion,
      total_tokens: tokens.total,
      cost_usd: tokens.cost,
      provider_request_id: requestId,
    };

    /*
     * WHY THE SHAPE IS READ BEFORE THE CONTENT.
     *
     * An empty `content` has several causes that need different answers from a
     * person, and reporting them all as `no_content` is what left Milestone
     * 2C.2 with a hypothesis instead of a root cause. `finish_reason` was
     * present in that response and thrown away.
     *
     * NOTHING HERE PARSES REASONING. `reasoning` is inspected only for its
     * PRESENCE, to explain an empty answer. It is never read as the structured
     * result: reasoning is a model thinking aloud, not the object we asked for,
     * and accepting it would defeat the schema entirely.
     */
    const choice = (payload as {
      choices?: {
        finish_reason?: unknown;
        native_finish_reason?: unknown;
        message?: { content?: unknown; reasoning?: unknown; refusal?: unknown };
      }[];
    })?.choices?.[0];

    const finishReason =
      typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
    const content = choice?.message?.content;
    const hasContent = typeof content === 'string' && content.trim() !== '';

    // An explicit refusal is its own outcome, and never retried.
    if (typeof choice?.message?.refusal === 'string' && choice.message.refusal.trim() !== '') {
      return fail('refused', false, response.status, observed);
    }

    if (!hasContent) {
      // Truncation first: it is the one an operator can act on immediately by
      // raising the ceiling, and 397 of a 400-token budget is what it looks
      // like from the outside.
      if (finishReason === 'length') {
        return fail('output_truncated', false, response.status, observed);
      }
      if (finishReason === 'content_filter') {
        return fail('refused', false, response.status, observed);
      }
      const reasoning = choice?.message?.reasoning;
      if (typeof reasoning === 'string' && reasoning.trim() !== '') {
        return fail('reasoning_only', false, response.status, observed);
      }
      return fail('no_content', false, response.status, observed);
    }

    /*
     * Content is present but the model was cut off, so the JSON is very likely
     * incomplete. Reported as truncation rather than as malformed JSON,
     * because the fix is a bigger budget, not a better parser.
     */
    if (finishReason === 'length') {
      return fail('output_truncated', false, response.status, observed);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return fail('malformed_json', false, response.status, observed);
    }

    // The provider's structured-output mode is a request, not a guarantee.
    // This is the boundary that decides whether the reply is usable.
    const validated = schema.safeParse(parsedJson);
    if (!validated.success) {
      /*
       * NAME THE FIELDS THAT FAILED, AND NOTHING ELSE.
       *
       * Zod has just computed exactly which paths are wrong, and this branch
       * used to throw that away — the same defect as the collapsed provider
       * code, one level deeper. A production import failed here and there was
       * no way to learn whether it was a date, a URL or a phone number without
       * spending another live request.
       *
       * `describeSchemaFailure` reads `issue.path` ONLY. It never touches
       * `issue.message`, which quotes offending VALUES — and an offending value
       * in a résumé is a person's phone number.
       */
      return {
        ...fail('invalid_structure', false, response.status, observed),
        detail: describeSchemaFailure(validated.error.issues),
      };
    }

    return {
      ok: true,
      data: validated.data,
      model,
      attempts,
      usage: finish({
        status: 'succeeded',
        failure_class: null,
        failure_code: null,
        attempts,
        ...observed,
      }),
    };
  }

  return last;
}
