import 'server-only';

/**
 * The AI provider configuration boundary.
 *
 * ONE place decides which provider is called, with which credential, at which
 * URL, using which model. Everything else asks this module, so adding an
 * operation later does not mean scattering `process.env` reads through the
 * codebase — which is how a key ends up read in a file that later becomes
 * reachable from a client bundle.
 *
 * OpenRouter is the only AI API this application may call. This is deliberately
 * NOT a multi-provider abstraction: there is one provider, and a second one
 * would be a second thing to secure, a second billing surface and a second set
 * of failure modes. When a second provider is genuinely needed, it earns its
 * own review.
 *
 * Claude Max is not reachable from here and must never be. It is a separate
 * capability the user drives on their own machine, under their own account.
 *
 * FAIL CLOSED. Every accessor returns a discriminated result rather than
 * throwing or falling back to a default credential. A misconfigured deployment
 * produces one clear message, not a confusing provider error three layers down.
 */

/** The provider this application talks to. There is exactly one. */
export const PROVIDER = 'openrouter' as const;

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * A cheap, widely available model with structured-output support.
 *
 * A default rather than a hardcoded choice: model availability on OpenRouter
 * changes faster than this repository does, so `OPENROUTER_RESUME_MODEL`
 * overrides it without a deploy. Whatever is chosen, the reply is validated
 * against this project's own Zod schema, so a model that ignores the schema
 * fails cleanly instead of writing a plausible, wrong profile.
 */
export const DEFAULT_RESUME_MODEL = 'google/gemini-2.5-flash';

/**
 * `vendor/model`, optionally with an OpenRouter variant suffix (`:free`,
 * `:nitro`, `:floor`). Validated so a typo or a stray quotation mark in a
 * dashboard becomes a configuration error here, rather than a 404 from the
 * provider halfway through a candidate's résumé import.
 */
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(:[a-z0-9-]+)?$/i;

export type ConfigProblemCode =
  | 'missing_api_key'
  | 'invalid_base_url'
  | 'insecure_base_url'
  | 'invalid_model'
  /**
   * Nobody chose a model, and nothing chose one on their behalf.
   *
   * Deliberately distinct from `invalid_model`, which means a value WAS
   * supplied and is malformed. Two different mistakes deserve two different
   * messages: one is a typo, the other is an unmade decision.
   */
  | 'model_not_configured';

export interface ProviderConfig {
  provider: typeof PROVIDER;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type ConfigResult =
  | { ok: true; config: ProviderConfig }
  | { ok: false; code: ConfigProblemCode; message: string };

/** Whether a credential is present at all. Cheap, and safe to call anywhere. */
export function isProviderConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

/**
 * Loopback is allowed over plain HTTP so a developer can point the adapter at
 * a local mock. Anything else must be HTTPS: a résumé's extracted text is not
 * something to put on the wire in the clear.
 */
function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

export function resolveBaseUrl(raw = process.env.OPENROUTER_BASE_URL): ConfigResult | string {
  const value = raw?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      code: 'invalid_base_url',
      message: 'OPENROUTER_BASE_URL is not a valid URL.',
    };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    return {
      ok: false,
      code: 'insecure_base_url',
      message: 'OPENROUTER_BASE_URL must use https, except for a loopback address.',
    };
  }
  return value.replace(/\/+$/, '');
}

/** The model for résumé extraction, validated. */
export function resolveResumeModel(raw = process.env.OPENROUTER_RESUME_MODEL): ConfigResult | string {
  const value = raw?.trim() || DEFAULT_RESUME_MODEL;
  if (!MODEL_PATTERN.test(value)) {
    return {
      ok: false,
      code: 'invalid_model',
      message: 'OPENROUTER_RESUME_MODEL must look like "vendor/model" or "vendor/model:variant".',
    };
  }
  return value;
}

/**
 * The model for everything OTHER than résumé extraction. NO DEFAULT.
 *
 * WHY THIS ONE FAILS CLOSED WHERE `resolveResumeModel` DOES NOT
 *
 * The résumé path has shipped with a default since its own milestone, it is
 * covered by its own tests, and changing it now would alter behaviour nobody
 * asked to change. This path is new, and a default here would be worse than an
 * error for three reasons:
 *
 *   1. It spends the candidate's money on a model nobody picked.
 *   2. Model availability on OpenRouter changes faster than this repository
 *      does, so a hardcoded slug is a 404 waiting for a deploy — and choosing
 *      one from training data is guessing about a live catalogue.
 *   3. Scoring quality and cost differ enormously between models. "Which model
 *      scores my job matches" is a product decision, not a fallback.
 *
 * So an unset `OPENROUTER_MODEL` is `model_not_configured`, the caller stops,
 * and nothing is billed.
 */
export function resolveGatewayModel(raw = process.env.OPENROUTER_MODEL): ConfigResult | string {
  const value = raw?.trim();
  if (!value) {
    return {
      ok: false,
      code: 'model_not_configured',
      message:
        'OPENROUTER_MODEL is not set. Choose a model deliberately; this path has no default.',
    };
  }
  if (!MODEL_PATTERN.test(value)) {
    return {
      ok: false,
      code: 'invalid_model',
      message: 'OPENROUTER_MODEL must look like "vendor/model" or "vendor/model:variant".',
    };
  }
  return value;
}

/**
 * The configuration for the general gateway: key, base URL, and a model that
 * somebody actually chose.
 *
 * The same shape as `providerConfig()` so callers are interchangeable, but the
 * model resolves through `resolveGatewayModel`, so a missing choice is an
 * error rather than a silent default.
 */
export function gatewayConfig(): ConfigResult {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, code: 'missing_api_key', message: 'OPENROUTER_API_KEY is not set.' };
  }

  const baseUrl = resolveBaseUrl();
  if (typeof baseUrl !== 'string') return baseUrl;

  const model = resolveGatewayModel();
  if (typeof model !== 'string') return model;

  return { ok: true, config: { provider: PROVIDER, apiKey, baseUrl, model } };
}

/**
 * Is the general gateway usable at all? Booleans only.
 *
 * Returns yes/no and NOTHING else — not the key, not its length, not a prefix.
 * A diagnostic that echoes the first few characters of the key has leaked it
 * to whatever reads that line, and a length narrows a search space.
 */
export function gatewayReadiness(): { keyConfigured: boolean; modelConfigured: boolean } {
  return {
    keyConfigured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
    modelConfigured: typeof resolveGatewayModel() === 'string',
  };
}

/**
 * The complete configuration, or the first problem with it.
 *
 * Read at call time rather than at module scope: a value captured at import
 * time is a lie the moment the environment changes, and it makes the module
 * impossible to test without reloading it.
 */
export function providerConfig(): ConfigResult {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      code: 'missing_api_key',
      message: 'OPENROUTER_API_KEY is not set.',
    };
  }

  const baseUrl = resolveBaseUrl();
  if (typeof baseUrl !== 'string') return baseUrl;

  const model = resolveResumeModel();
  if (typeof model !== 'string') return model;

  return { ok: true, config: { provider: PROVIDER, apiKey, baseUrl, model } };
}
