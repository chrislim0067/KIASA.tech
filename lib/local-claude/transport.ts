import { z } from 'zod';

import {
  LOCAL_CLAUDE_CAPABILITIES,
  type LocalClaudeAvailability,
  type LocalClaudeCapability,
  type LocalUnsupportedReason,
} from '@/lib/agent/ai-mode';

/**
 * The provider-neutral interface to the candidate's own local Claude.
 *
 * PURE. Contracts, validation and a deterministic fake. The one adapter that
 * actually talks to anything lives in `lib/local-claude/cli.ts`, kept separate
 * so this file — and everything that imports it — can be tested without a
 * subprocess, and so `lib/agent/` stays free of any transport at all.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is a way to ask the candidate's OWN Claude, running on the candidate's
 * OWN machine, under the candidate's OWN login, to write something that will
 * be submitted in the candidate's OWN name. The server holds no Claude
 * credential and never sees one; a worker spawns an official interface as a
 * child process and reads its documented output.
 *
 * It is NOT a backend Claude integration, and the difference is not
 * decorative. Nothing here reads browser storage, extracts a session token,
 * replays a credential, calls an undocumented endpoint, or disguises what it
 * is. Those are listed in `PERMANENTLY_OUT_OF_SCOPE` and did not become
 * acceptable just because a supported path was found.
 *
 * THE RULE THAT MATTERS MOST HERE
 *
 * Everything coming back is UNTRUSTED TEXT. It was produced by a model, from a
 * prompt, on a machine we do not control, and it is destined for an employer's
 * form. So it is parsed, schema-validated, bounded, and scanned before any
 * caller sees it — and a response that does not fit is a failure, never a
 * best-effort value.
 */

/* ------------------------------------------------------------- requests */

/** The capabilities that may ever be asked of a local model. Three, closed. */
export const LocalCapability = z.enum(LOCAL_CLAUDE_CAPABILITIES);
export type LocalCapability = LocalClaudeCapability;

export const MAX_PROMPT_CHARS = 20_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 300_000;

/**
 * One request to the local model.
 *
 * NO CREDENTIAL FIELD, and there is nowhere to put one: `.strict()` with this
 * fixed list. The interface authenticates itself from the candidate's own
 * login; KIASA neither supplies nor stores anything.
 *
 * The prompt is bounded because it becomes the stdin of a child process, and
 * an unbounded one is both a cost problem and a way to smuggle a payload past
 * a reviewer who only reads the first screen.
 */
export const LocalClaudeRequest = z
  .object({
    request_id: z.uuid(),
    candidate_id: z.uuid(),
    task_id: z.uuid(),
    capability: LocalCapability,
    /** Resolved by `resolveLocalModel()`. Never hard-coded by KIASA. */
    model: z.string().min(1).max(60),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
    timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS),
  })
  .strict();
export type LocalClaudeRequest = z.infer<typeof LocalClaudeRequest>;

/* -------------------------------------------------------------- outputs */

/**
 * `uncertain` is on every shape, and it is the most important field.
 *
 * A model asked to write an answer it does not have the facts for will write
 * a plausible one. `uncertain: true` is how it says so, and the control plane
 * turns that into `unknown_candidate_fact` — a stop, not a lower-confidence
 * answer that gets typed into a form anyway. See `outcomeRequiresHuman()`.
 */
const uncertain = z.boolean();

export const ApplicationAnswer = z
  .object({
    answer: z.string().min(1).max(2000),
    /**
     * The verified candidate facts this answer drew on, by key.
     *
     * Keys only, never values: the caller already holds the facts and can
     * check them. It is also how a fabricated answer is caught — an answer
     * citing a fact key that was never supplied did not come from the
     * candidate's data.
     */
    used_fact_keys: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(20),
    uncertain,
  })
  .strict();

export const TailoredResumeSection = z
  .object({
    heading: z.string().min(1).max(120),
    bullets: z.array(z.string().min(1).max(400)).min(1).max(10),
    uncertain,
  })
  .strict();

export const ProfileSummary = z
  .object({ summary: z.string().min(1).max(1200), uncertain })
  .strict();

/** Which shape each capability must return. Total over the three. */
export const OUTPUT_SCHEMA = {
  application_answer_generation: ApplicationAnswer,
  resume_tailoring: TailoredResumeSection,
  candidate_profile_drafting: ProfileSummary,
} as const satisfies Record<LocalCapability, z.ZodType>;

export type LocalClaudeOutput =
  | z.infer<typeof ApplicationAnswer>
  | z.infer<typeof TailoredResumeSection>
  | z.infer<typeof ProfileSummary>;

/* ------------------------------------------------------------- outcomes */

/**
 * How a local call ended.
 *
 * A discriminated union with SEVEN arms, because collapsing any of them loses
 * something a caller must act on differently:
 *
 *   ok               a validated result.
 *   invalid_output   the interface answered, but not in the agreed shape. NOT
 *                    an error to retry blindly — a model that returned prose
 *                    where JSON was required will do it again.
 *   refused          the model declined, or a tool it wanted was denied.
 *   timeout          separate from error, because it is the one worth retrying.
 *   unsupported      no local capability at all on this machine.
 *   manual_required  a local capability exists but may not be used right now —
 *                    consent, a cap, the candidate turning it off.
 *   error            anything else, by code, never a raw message.
 *
 * `unsupported` and `manual_required` are the states this milestone was told
 * to make explicit, and they are the reason a mock cannot masquerade as a
 * working integration: an adapter that has nothing behind it must SAY so.
 */
export type LocalClaudeOutcome =
  | {
      status: 'ok';
      request_id: string;
      capability: LocalCapability;
      output: LocalClaudeOutput;
      /** What the interface said it used, not what we asked for. */
      model_reported: string;
      duration_ms: number;
      turns: number;
    }
  | { status: 'invalid_output'; request_id: string; detail: string }
  | { status: 'refused'; request_id: string; detail: string }
  | { status: 'timeout'; request_id: string; timeout_ms: number }
  | { status: 'unsupported'; reason: LocalUnsupportedReason }
  | { status: 'manual_required'; reason: LocalUnsupportedReason }
  | { status: 'error'; request_id: string; code: string };

/**
 * The transport every adapter implements.
 *
 * `probe()` is separate from `run()` on purpose. Capability must be
 * ESTABLISHED, not assumed from configuration: "the candidate enabled local
 * mode" and "the interface answered when asked" are different facts, and only
 * the second may produce `status: 'supported'`.
 */
export interface LocalClaudeTransport {
  /** Stable identifier, for logs and reports. Never a credential hint. */
  readonly name: string;
  probe(): Promise<LocalClaudeAvailability>;
  run(request: LocalClaudeRequest): Promise<LocalClaudeOutcome>;
}

/* ------------------------------------------------------------ validation */

/**
 * Strings that must never appear in a model's output.
 *
 * A defence in depth, not the primary one — the schemas above already bound
 * every field. This catches the case where a model helpfully echoes something
 * from its own environment into a field that legitimately holds free text, and
 * that text is then submitted to an employer.
 */
const OUTPUT_DENYLIST: readonly RegExp[] = [
  /sk-[a-z0-9-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{20,}/, // a JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
];

/**
 * Parse and validate what came back.
 *
 * TWO parses, deliberately. The interface returns an envelope whose `result`
 * is a STRING, and that string is the model's JSON. So the caller unwraps the
 * envelope and hands the inner string here, where it is parsed and then
 * schema-checked against the shape the capability requires.
 *
 * Anything that fails is `invalid_output` with a short reason. Never a partial
 * object, never a coerced one, and never the raw text in the detail — that
 * text is exactly what we are refusing to trust.
 */
export function validateLocalOutput(
  capability: LocalCapability,
  raw: unknown,
  requestId: string
): LocalClaudeOutcome | { ok: true; output: LocalClaudeOutput } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { status: 'invalid_output', request_id: requestId, detail: 'empty response' };
  }
  if (raw.length > 100_000) {
    return { status: 'invalid_output', request_id: requestId, detail: 'response too large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return { status: 'invalid_output', request_id: requestId, detail: 'not json' };
  }

  const result = OUTPUT_SCHEMA[capability].safeParse(parsed);
  if (!result.success) {
    // Field paths only. The values are untrusted and must not be logged.
    const paths = result.error.issues.map((i) => i.path.join('.') || '(root)').slice(0, 5);
    return {
      status: 'invalid_output',
      request_id: requestId,
      detail: `schema: ${paths.join(', ')}`,
    };
  }

  const flat = JSON.stringify(result.data);
  if (OUTPUT_DENYLIST.some((re) => re.test(flat))) {
    return {
      status: 'invalid_output',
      request_id: requestId,
      detail: 'output matched a credential pattern',
    };
  }

  return { ok: true, output: result.data as LocalClaudeOutput };
}

/**
 * Pull the JSON object out of a response that may be wrapped in a fence.
 *
 * Models are asked for bare JSON and usually comply. When one wraps it in
 * ```json … ```, that is a formatting habit rather than a different answer, so
 * it is unwrapped rather than rejected. Anything else is left exactly as it
 * came and allowed to fail the parse — this trims a wrapper, it does not go
 * hunting for something JSON-shaped inside arbitrary prose.
 */
function extractJson(raw: string): string {
  const text = raw.trim();
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : text;
}

/**
 * Must a person look at this before it is used?
 *
 * `uncertain` from the model is the main one, and it is honoured rather than
 * scored: a model saying it was not sure is the clearest signal available that
 * an answer would be a guess, and a guess typed into an employer's form is
 * asserted as the candidate's own.
 *
 * Everything that is not a clean `ok` also requires a human, so the failure
 * direction is "ask someone" rather than "carry on".
 */
export function outcomeRequiresHuman(outcome: LocalClaudeOutcome): boolean {
  if (outcome.status !== 'ok') return true;
  return outcome.output.uncertain === true;
}

/* ------------------------------------------------------------ the mock */

export interface MockScript {
  /** What probe() should report. */
  availability: LocalClaudeAvailability;
  /** Raw strings the fake returns, in order, as the inner `result`. */
  responses?: readonly string[];
  /** Force a specific non-ok outcome instead of returning a response. */
  force?: LocalClaudeOutcome;
}

/**
 * A deterministic fake, for tests only.
 *
 * IT IS NOT AN IMPLEMENTATION OF THE FEATURE, and the name says so at every
 * call site. Milestone 2B was explicit that a mock must not stand in for an
 * unproven integration; this exists so the WORKER can be tested without
 * spending a candidate's subscription, not so the integration can be claimed.
 *
 * It returns exactly what its script says, in order, and throws nothing — the
 * whole point is that a test can assert on `invalid_output` and `refused`
 * without arranging for a real model to misbehave.
 */
export function createMockTransport(script: MockScript): LocalClaudeTransport {
  let index = 0;
  return {
    name: 'mock',
    async probe() {
      return script.availability;
    },
    async run(request: LocalClaudeRequest): Promise<LocalClaudeOutcome> {
      const parsed = LocalClaudeRequest.safeParse(request);
      if (!parsed.success) {
        return { status: 'error', request_id: 'unknown', code: 'invalid_request' };
      }
      if (script.availability.status !== 'supported') {
        return script.availability.status === 'manual_required'
          ? { status: 'manual_required', reason: script.availability.reason }
          : { status: 'unsupported', reason: script.availability.reason };
      }
      if (script.force) return script.force;

      const raw = script.responses?.[index++] ?? '';
      const checked = validateLocalOutput(request.capability, raw, request.request_id);
      if ('ok' in checked) {
        return {
          status: 'ok',
          request_id: request.request_id,
          capability: request.capability,
          output: checked.output,
          model_reported: request.model,
          duration_ms: 1,
          turns: 1,
        };
      }
      return checked;
    },
  };
}
