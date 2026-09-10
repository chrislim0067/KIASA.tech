import { AutomationMode } from '@/lib/agent/contracts';

/**
 * Which AI capability is served by what, given a mode AND what the candidate's
 * machine can actually do.
 *
 * Pure: three inputs, a destination out. No network, no provider, no key, no
 * subprocess. It exists so "where does this reasoning happen" is a table that
 * can be read and tested, rather than a decision made independently at each
 * call site — which is how one path quietly ends up talking to something the
 * design forbids.
 *
 * THE TWO MODES
 *
 *   openrouter_only      The backend does all model work, through OpenRouter,
 *                        with a key held in the SERVER ENVIRONMENT only.
 *
 *   claude_max_assisted  Work is SPLIT. OpenRouter does the mechanical
 *                        reading — scanning a posting, analysing it, producing
 *                        scoring inputs and building the structured prompt.
 *                        The candidate's own Claude does the writing that
 *                        speaks in their voice: tailoring a résumé, drafting
 *                        an application answer, improving their profile.
 *
 * WHY THAT SPLIT, AND NOT THE OTHER ONE
 *
 * The work Claude does here is the work whose OUTPUT IS THE CANDIDATE'S OWN
 * WORDS, submitted to an employer under their name. Doing that on their own
 * subscription, on their own machine, is the arrangement that matches who the
 * output belongs to. Parsing a job posting has no such character, and belongs
 * on the server where it can be cached, batched and paid for centrally.
 *
 * NOTE A CHANGE FROM MILESTONE 2A. That milestone routed *every* model
 * capability in assisted mode to the paste console, and asserted that the mode
 * used no server-held credential at all. Milestone 2B splits the work, so
 * assisted mode now DOES use OpenRouter for the mechanical half. That is a
 * deliberate product decision, not a drift, and the test that asserted the old
 * property has been replaced rather than deleted quietly.
 *
 * THE THIRD INPUT
 *
 * Routing depends on whether a supported local Claude capability is actually
 * present — see `LocalClaudeAvailability`. A capability assigned to local
 * Claude falls back to the visible paste console when it is not, and the
 * fallback is a DIFFERENT destination rather than a silent substitution,
 * because a task done by hand is not unattended automation and must not be
 * recorded as though it were.
 */

/* ------------------------------------------------------- capabilities */

/**
 * Every capability that involves a model.
 *
 * Enumerated rather than free text so a new one cannot be added without
 * deciding, here, where it runs in every combination. `routingTable()` returns
 * a total map, so an unrouted capability is a type error.
 */
export const AI_CAPABILITIES = [
  'resume_extraction',
  'resume_analysis',
  'job_scanning',
  'job_analysis',
  'job_scoring',
  'eligibility_evaluation',
  'structured_task_creation',
  'resume_tailoring',
  'application_answer_generation',
  'candidate_profile_drafting',
] as const;

export type AiCapability = (typeof AI_CAPABILITIES)[number];

/**
 * The capabilities assigned to the candidate's own Claude in assisted mode.
 *
 * Exactly these three, and the list is exported so a test can assert that
 * nothing else ever routes there. Each produces text that will be submitted to
 * an employer as the candidate's own words.
 */
export const LOCAL_CLAUDE_CAPABILITIES = [
  'resume_tailoring',
  'application_answer_generation',
  'candidate_profile_drafting',
] as const;

/** The three, as a type. A narrow tuple, so schemas keyed on it stay total. */
export type LocalClaudeCapability = (typeof LOCAL_CLAUDE_CAPABILITIES)[number];

/** Compile-time proof that every local capability is a real AI capability. */
const _localAreCapabilities: readonly AiCapability[] = LOCAL_CLAUDE_CAPABILITIES;
void _localAreCapabilities;

/**
 * Where the work actually happens.
 *
 * `deterministic_rules` is a first-class destination, not a fallback. Some
 * decisions must not be made by a model at all, and saying so in the same
 * vocabulary as the model destinations is what keeps that visible.
 *
 * `candidate_claude_max_paste` and `local_claude` are deliberately separate.
 * Both are the candidate's own Claude; only one is unattended. Collapsing them
 * would let a report say "automated" about work a person did by hand.
 */
export type AiDestination =
  | 'openrouter'
  | 'local_claude'
  | 'candidate_claude_max_paste'
  | 'deterministic_rules';

/** Who holds the credential for a destination — and `none` is the common case. */
export type CredentialHolder = 'server_environment' | 'candidate_own_session' | 'none';

export interface CapabilityRouting {
  capability: AiCapability;
  destination: AiDestination;
  credential_holder: CredentialHolder;
  /** Whether a person must act for this to complete. */
  attended: boolean;
  /** Why, in one line. Surfaced in docs and in test output. */
  rationale: string;
}

/* --------------------------------------------- local capability status */

/** Why a local Claude capability is not usable. Closed, and never a free string. */
export const LOCAL_UNSUPPORTED_REASONS = [
  'cli_not_installed',
  'cli_not_authenticated',
  'cli_version_too_old',
  'no_subscription',
  'probe_failed',
  'candidate_has_not_consented',
  'disabled_by_candidate',
  'daily_local_cap_reached',
] as const;
export type LocalUnsupportedReason = (typeof LOCAL_UNSUPPORTED_REASONS)[number];

/**
 * What the candidate's machine can actually do — a discriminated union, so an
 * unavailable capability cannot be read as an available one with some fields
 * missing.
 *
 * `supported` REQUIRES evidence: which adapter, which version, and the model
 * the candidate selected. It is produced only by an actual probe
 * (`lib/agent/local-claude.ts`), never asserted from configuration, because
 * "the candidate ticked a box" is not the same fact as "the interface answered".
 */
export type LocalClaudeAvailability =
  | {
      status: 'supported';
      /** The only supported adapter today. See docs/LOCAL-CLAUDE.md. */
      adapter: 'claude_code_cli';
      /** Reported by the interface itself, never assumed. */
      version: string;
      /** The candidate's selection. NEVER hard-coded — see resolveLocalModel(). */
      model: string;
    }
  | { status: 'unsupported'; reason: LocalUnsupportedReason }
  | { status: 'manual_required'; reason: LocalUnsupportedReason };

/** Convenience, used at every branch so the check is written once. */
export const isLocalClaudeUsable = (
  a: LocalClaudeAvailability
): a is Extract<LocalClaudeAvailability, { status: 'supported' }> => a.status === 'supported';

/** The availability used when the candidate is in openrouter_only mode. */
export const LOCAL_NOT_APPLICABLE: LocalClaudeAvailability = {
  status: 'unsupported',
  reason: 'disabled_by_candidate',
};

/* ------------------------------------------------------ model selection */

/**
 * Model aliases the local interface documents.
 *
 * NOT HARD-CODED TO ANY ONE MODEL. The candidate chooses; this list exists
 * only so an arbitrary string cannot be passed through to a subprocess
 * argument. A full model name is also accepted, matched by shape.
 *
 * There is deliberately no default of `fable` or `opus` here: the candidate's
 * subscription, their quota and their preference are theirs, and picking the
 * most expensive model on their behalf is not ours to do.
 */
export const LOCAL_MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const;

/** A full model name, e.g. `claude-sonnet-5`. Conservative on purpose. */
const FULL_MODEL_NAME = /^claude-[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validate a candidate-chosen model.
 *
 * Returns null for anything unrecognised rather than passing it through. The
 * value becomes a command-line argument to a local process, so "reject what we
 * do not recognise" is the only safe posture — and an unrecognised model is a
 * configuration mistake worth surfacing, not one to paper over with a default.
 */
export function resolveLocalModel(chosen: unknown): string | null {
  if (typeof chosen !== 'string') return null;
  const value = chosen.trim().toLowerCase();
  if (value === '') return null;
  if ((LOCAL_MODEL_ALIASES as readonly string[]).includes(value)) return value;
  if (FULL_MODEL_NAME.test(value) && value.length <= 60) return value;
  return null;
}

/* -------------------------------------------------------- the routing */

const ELIGIBILITY_RATIONALE =
  'eligibility gates a real application and must be reproducible; the contract admits only deterministic_rules';

/**
 * ELIGIBILITY IS NEVER ROUTED TO A MODEL, IN ANY MODE OR COMBINATION.
 *
 * A deliberate divergence from a literal reading of both milestone briefs,
 * which list eligibility among OpenRouter's responsibilities. Recorded rather
 * than made silently:
 *
 * `EligibilityDecision.evaluator` is a `z.literal('deterministic_rules')` —
 * the contract cannot express a model having decided. Eligibility gates
 * whether an application is sent to a real employer in a real person's name,
 * so it must be reproducible, explainable afterwards, and identical on two
 * runs of the same inputs. A model is none of those.
 *
 * A model MAY produce the structured facts the rules then evaluate. That is
 * `job_analysis`, and it routes to a provider. The verdict does not.
 */
const server = (capability: AiCapability, rationale: string): CapabilityRouting => ({
  capability,
  destination: 'openrouter',
  credential_holder: 'server_environment',
  attended: false,
  rationale,
});

const deterministic = (capability: AiCapability): CapabilityRouting => ({
  capability,
  destination: 'deterministic_rules',
  credential_holder: 'none',
  attended: false,
  rationale: ELIGIBILITY_RATIONALE,
});

const local = (capability: AiCapability, rationale: string): CapabilityRouting => ({
  capability,
  destination: 'local_claude',
  credential_holder: 'candidate_own_session',
  attended: false,
  rationale,
});

const paste = (capability: AiCapability, reason: LocalUnsupportedReason): CapabilityRouting => ({
  capability,
  destination: 'candidate_claude_max_paste',
  credential_holder: 'candidate_own_session',
  /* A person opens Claude, runs the prompt and pastes the result back. */
  attended: true,
  rationale: `no supported local capability (${reason}); the candidate does this step themselves`,
});

/** The mechanical half. Identical in both modes. */
function serverSide(): Record<
  Exclude<AiCapability, 'resume_tailoring' | 'application_answer_generation' | 'candidate_profile_drafting'>,
  CapabilityRouting
> {
  return {
    resume_extraction: server(
      'resume_extraction',
      'PDF text is extracted locally; only bounded text reaches the provider'
    ),
    resume_analysis: server('resume_analysis', 'backend reasoning over already-extracted text'),
    job_scanning: server('job_scanning', 'reading a posting has no personal character'),
    job_analysis: server('job_analysis', 'structures what a posting says; it decides nothing'),
    job_scoring: server('job_scoring', 'a ranking signal, reviewable and never the sole gate'),
    eligibility_evaluation: deterministic('eligibility_evaluation'),
    structured_task_creation: server(
      'structured_task_creation',
      'produces steps from the closed action vocabulary, validated on return'
    ),
  };
}

/**
 * The complete routing for a mode and a machine. Total by construction.
 *
 * In `openrouter_only` the three writing capabilities go to OpenRouter like
 * everything else — the candidate chose not to involve their own Claude, and
 * that choice is respected rather than second-guessed.
 */
export function routingTable(
  mode: AutomationMode,
  availability: LocalClaudeAvailability = LOCAL_NOT_APPLICABLE
): Readonly<Record<AiCapability, CapabilityRouting>> {
  const base = serverSide();

  if (mode === 'openrouter_only') {
    return {
      ...base,
      resume_tailoring: server('resume_tailoring', 'candidate reviews the result before it is used'),
      application_answer_generation: server(
        'application_answer_generation',
        'drafts only; an unverified answer still stops on unknown_candidate_fact'
      ),
      candidate_profile_drafting: server(
        'candidate_profile_drafting',
        'proposals the candidate confirms field by field'
      ),
    };
  }

  if (isLocalClaudeUsable(availability)) {
    return {
      ...base,
      resume_tailoring: local(
        'resume_tailoring',
        "the output is the candidate's own résumé, written on their own subscription"
      ),
      application_answer_generation: local(
        'application_answer_generation',
        'the answer is submitted to an employer in the candidate’s name'
      ),
      candidate_profile_drafting: local(
        'candidate_profile_drafting',
        "improving the candidate's own profile text"
      ),
    };
  }

  // Assisted mode without a usable local capability: the visible fallback.
  const reason = availability.reason;
  return {
    ...base,
    resume_tailoring: paste('resume_tailoring', reason),
    application_answer_generation: paste('application_answer_generation', reason),
    candidate_profile_drafting: paste('candidate_profile_drafting', reason),
  };
}

/** Where one capability runs. */
export function routeCapability(
  mode: AutomationMode,
  capability: AiCapability,
  availability: LocalClaudeAvailability = LOCAL_NOT_APPLICABLE
): CapabilityRouting {
  return routingTable(mode, availability)[capability];
}

/**
 * Does this mode depend on the candidate being signed in to Claude?
 *
 * Only `claude_max_assisted` does. This is what makes
 * `claude_authentication_required` a legitimate pause reason in one mode and a
 * protocol violation in the other: raising it under `openrouter_only` would
 * ask the candidate to fix something with no bearing on the work.
 */
export function requiresClaudeSession(mode: AutomationMode): boolean {
  return mode === 'claude_max_assisted';
}

/** Does any capability in this combination use a server-held credential? */
export function usesServerHeldCredential(
  mode: AutomationMode,
  availability: LocalClaudeAvailability = LOCAL_NOT_APPLICABLE
): boolean {
  return Object.values(routingTable(mode, availability)).some(
    (r) => r.credential_holder === 'server_environment'
  );
}

/**
 * Does completing this task need a person?
 *
 * True whenever any capability routes to the paste console. A task that needs
 * a human is recorded as candidate-assisted, never as unattended automation —
 * `AutomationTaskResult` and the worker report carry it, so a completion rate
 * cannot quietly count work someone did by hand.
 */
export function requiresCandidateAction(
  mode: AutomationMode,
  availability: LocalClaudeAvailability = LOCAL_NOT_APPLICABLE
): boolean {
  return Object.values(routingTable(mode, availability)).some((r) => r.attended);
}

/* --------------------------------------------------- the extension point */

/**
 * The boundary that does NOT move, whatever the adapter turns out to be.
 *
 * Milestone 2B established that an officially supported local interface
 * exists, and `lib/agent/local-claude.ts` uses it. None of the following
 * became acceptable as a result — they are not implementation details of the
 * supported path, they are the alternatives it exists to avoid.
 */
export const PERMANENTLY_OUT_OF_SCOPE = [
  'browser_storage_access',
  'session_token_extraction',
  'credential_replay',
  'private_endpoint_calls',
  'undocumented_api_calls',
  'automation_disguise',
  'captcha_bypass',
  'mfa_bypass',
] as const;

/**
 * What a supported local integration must satisfy. All four, still.
 *
 * Three of these were met in Milestone 2B by using the official command-line
 * interface. The FIRST — whether the candidate's subscription terms permit
 * programmatic use at the volume this product envisages — is not a technical
 * question and was not answered by a working probe. It is the account
 * holder's, it is recorded in `docs/LOCAL-CLAUDE.md`, and
 * `candidate_has_not_consented` is its enforcement point.
 */
export const LOCAL_INTEGRATION_REQUIREMENTS = {
  account_terms_reviewed_by_candidate: 'open',
  official_documented_interface: 'met',
  runs_only_on_candidate_machine: 'met',
  server_holds_no_claude_credential: 'met',
} as const;
