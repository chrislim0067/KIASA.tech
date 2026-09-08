/**
 * The OpenRouter adapter.
 *
 * The ONLY place in this application that talks to an AI provider, and the
 * only place `OPENROUTER_API_KEY` is read. There is deliberately no second
 * provider and no fallback: a fallback path is a second thing to secure, a
 * second billing surface, and a second set of failure modes that only appear
 * when the first provider is already having a bad day.
 *
 * Claude Max is NOT reachable from here. It stays a separate capability the
 * user drives on their own machine, under their own account. Nothing in this
 * file reads a browser session, a cookie, a local token store, or any private
 * endpoint, and nothing should ever be added that does.
 *
 * WHAT THIS GUARANTEES
 *
 *   * server-only, so importing it from a client component is a build error
 *     rather than a published key;
 *   * a bounded timeout and a bounded number of retries, so a slow provider
 *     produces a clean failure rather than a hanging request;
 *   * structured output validated with the project's own Zod schema — the
 *     provider's word is never taken for the shape;
 *   * normalised failure categories the caller can act on;
 *   * NOTHING from the prompt or the response in any log line. A résumé is the
 *     most sensitive document this platform handles, and a debug log is the
 *     easiest place to leak one.
 */
import 'server-only';

import { z } from 'zod';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * A default that is cheap, structured-output capable, and explicit.
 *
 * Overridable through `OPENROUTER_RESUME_MODEL` because model availability on
 * OpenRouter changes faster than this repository does, and a hardcoded id
 * becomes an outage.
 */
export const DEFAULT_RESUME_MODEL = 'google/gemini-2.5-flash';

/** Below the route's own budget, so a slow provider fails cleanly first. */
export const REQUEST_TIMEOUT_MS = 90_000;

/** One retry. More multiplies the wait a candidate is staring at. */
export const MAX_ATTEMPTS = 2;

export type ProviderFailureCode =
  | 'not_configured'
  | 'timeout'
  | 'rate_limited'
  | 'auth_failed'
  | 'bad_request'
  | 'server_error'
  | 'connection_failed'
  | 'no_content'
  | 'malformed_json'
  | 'invalid_structure';

export type ProviderResult<T> =
  | { ok: true; data: T; model: string; attempts: number }
  | {
      ok: false;
      code: ProviderFailureCode;
      /** HTTP status when there was one. Never a response body. */
      status?: number;
      retryable: boolean;
      attempts: number;
    };

/** Present and non-empty. Checked at call time so a missing key fails cleanly. */
export function isOpenRouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

export function resumeModel(): string {
  return process.env.OPENROUTER_RESUME_MODEL?.trim() || DEFAULT_RESUME_MODEL;
}

export function baseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Map an HTTP status onto a category and whether trying again could help. */
function classifyStatus(status: number): { code: ProviderFailureCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'auth_failed', retryable: false };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status >= 500) return { code: 'server_error', retryable: true };
  return { code: 'bad_request', retryable: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StructuredRequest<T> {
  /** The Zod schema the reply must satisfy. Also becomes the JSON schema sent. */
  schema: z.ZodType<T>;
  /** A name for the schema; OpenRouter requires one for strict mode. */
  schemaName: string;
  system: string;
  user: string;
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so retry backoff does not slow the suite. */
  sleepImpl?: (ms: number) => Promise<unknown>;
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
    system,
    user,
    fetchImpl = fetch,
    sleepImpl = sleep,
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxAttempts = MAX_ATTEMPTS,
  } = request;

  if (!isOpenRouterConfigured()) {
    return { ok: false, code: 'not_configured', retryable: false, attempts: 0 };
  }

  const model = resumeModel();
  const url = `${baseUrl()}/chat/completions`;
  const jsonSchema = z.toJSONSchema(schema, { io: 'output' });

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
    // Transcription, not composition: no room for invention.
    temperature: 0,
  });

  let attempts = 0;
  let last: Extract<ProviderResult<T>, { ok: false }> = {
    ok: false,
    code: 'connection_failed',
    retryable: true,
    attempts: 0,
  };

  while (attempts < maxAttempts) {
    attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
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
      last = {
        ok: false,
        code: aborted ? 'timeout' : 'connection_failed',
        retryable: true,
        attempts,
      };
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
      last = { ok: false, code, status: response.status, retryable, attempts };
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
      return { ok: false, code: 'malformed_json', status: response.status, retryable: false, attempts };
    }

    const content = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
      ?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, code: 'no_content', status: response.status, retryable: false, attempts };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return { ok: false, code: 'malformed_json', status: response.status, retryable: false, attempts };
    }

    // The provider's structured-output mode is a request, not a guarantee.
    // This is the boundary that decides whether the reply is usable.
    const validated = schema.safeParse(parsedJson);
    if (!validated.success) {
      return {
        ok: false,
        code: 'invalid_structure',
        status: response.status,
        retryable: false,
        attempts,
      };
    }

    return { ok: true, data: validated.data, model, attempts };
  }

  return last;
}
