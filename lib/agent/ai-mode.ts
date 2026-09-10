import { AutomationMode } from '@/lib/agent/contracts';

/**
 * Which AI capability is served by what, in each of the two modes.
 *
 * Pure: a mode and a capability in, a destination out. No network, no
 * provider, no key. It exists so that "where does this reasoning happen" is a
 * table that can be read and tested, rather than a decision made independently
 * at each call site — which is how one path quietly ends up talking to
 * something the design forbids.
 *
 * THE TWO MODES
 *
 *   openrouter_only      The backend does the reasoning, through OpenRouter,
 *                        with a key held in the SERVER ENVIRONMENT only.
 *
 *   claude_max_assisted  The CANDIDATE does the reasoning, in their own Claude
 *                        session, on their own machine. KIASA prepares a
 *                        structured prompt; the candidate pastes the result
 *                        back. The backend holds no Claude credential, drives
 *                        no Claude session, and calls no Claude endpoint —
 *                        exactly as the existing résumé paste console works.
 *
 * WHAT IS NOT HERE, DELIBERATELY
 *
 * There is no destination meaning "the backend calls Claude". Automating a
 * personal Claude Max subscription from a server would be using someone's own
 * account credential as though it were ours, which is a consent and licensing
 * question before it is a technical one. See CLAUDE_MAX_LOCAL_CAPABILITY at
 * the bottom of this file for the documented — and closed — extension point.
 */

/**
 * Every capability that involves a model.
 *
 * Enumerated rather than free text so a new one cannot be added without
 * deciding, here, where it runs in both modes. `routingTable()` returns a
 * total map, so an unrouted capability is a type error.
 */
export const AI_CAPABILITIES = [
  'resume_extraction',
  'resume_analysis',
  'job_analysis',
  'job_scoring',
  'eligibility_evaluation',
  'resume_tailoring',
  'application_answer_generation',
  'structured_task_creation',
] as const;

export type AiCapability = (typeof AI_CAPABILITIES)[number];

/**
 * Where the work actually happens.
 *
 * `deterministic_rules` is a first-class destination, not a fallback. Some
 * decisions must not be made by a model at all, and saying so in the same
 * vocabulary as the model destinations is what keeps that visible.
 */
export type AiDestination =
  | 'openrouter'
  | 'candidate_claude_max_paste'
  | 'deterministic_rules';

/** Who holds the credential for a destination — and `none` is the common case. */
export type CredentialHolder = 'server_environment' | 'candidate_own_session' | 'none';

export interface CapabilityRouting {
  capability: AiCapability;
  destination: AiDestination;
  credential_holder: CredentialHolder;
  /** Why, in one line. Surfaced in docs and in test output. */
  rationale: string;
}

/**
 * ELIGIBILITY IS NEVER ROUTED TO A MODEL, IN EITHER MODE.
 *
 * This is a deliberate divergence from a literal reading of the milestone
 * brief, which lists "eligibility evaluation" among the OpenRouter
 * responsibilities. It is not implemented that way, for a reason worth stating
 * rather than burying:
 *
 * `EligibilityDecision.evaluator` is a `z.literal('deterministic_rules')` —
 * the contract cannot express a model having decided. Eligibility is the
 * decision that gates whether an application is sent to a real employer in a
 * real person's name, and it must be reproducible, explainable after the fact,
 * and identical on two runs of the same inputs. A model is none of those.
 *
 * What a model MAY do is produce the structured facts the rules then evaluate
 * — that is `job_analysis`, and it routes to a provider. The verdict does not.
 *
 * Flagged in the milestone report as a resolved conflict rather than changed
 * silently.
 */
const ELIGIBILITY_RATIONALE =
  'eligibility gates a real application and must be reproducible; the contract admits only deterministic_rules';

const OPENROUTER_ONLY: Readonly<Record<AiCapability, CapabilityRouting>> = {
  resume_extraction: {
    capability: 'resume_extraction',
    destination: 'openrouter',
    credential_holder: 'server_environment',
    rationale: 'PDF text is extracted locally; only bounded text reaches the provider',
  },
  resume_analysis: {
    capability: 'resume_analysis',
    destination: 'openrouter',
    credential_holder: 'server_environment',
    rationale: 'backend reasoning over already-extracted text',
  },
  job_analysis: {
    capability: 'job_analysis',
    destination: 'openrouter',
    credential_holder: 'server_environment',
    rationale: 'structures what a posting says; it does not decide anything',
  },
  job_scoring: {
    capability: 'job_scoring',
    destination: 'openrouter',
    credential_holder: 'server_environment',
    rationale: 'a ranking signal, reviewable and never the sole gate',
  },
  eligibility_evaluation: {
    capability: 'eligibility_evaluation',
    destination: 'deterministic_rules',
    credential_holder: 'none',
    rationale: ELIGIBILITY_RATIONALE,
  },
  resume_tailoring: {
    capability: 'resume_tailoring',
    destination: 'openrouter',
    credential_holder: 'server_environment',
    rationale: 'candidate reviews the result before it is used',
  },
  application_answer_generation: {
    capability: 'application_answer_generation',
    destination: 'openrouter',
    credential_holder: 'server_environment',
    rationale: 'drafts only; an unverified answer still stops on unknown_candidate_fact',
  },
  structured_task_creation: {
    capability: 'structured_task_creation',
    destination: 'openrouter',
    credential_holder: 'server_environment',
    rationale: 'produces steps from the closed action vocabulary, validated on return',
  },
};

/**
 * Assisted mode: every model capability becomes a prompt the candidate runs
 * themselves and a box they paste into.
 *
 * Note what this costs, honestly: it is not unattended. A mode where a person
 * pastes each result is not a mode that applies to a thousand jobs a day, and
 * the documentation says so rather than implying otherwise.
 */
const CLAUDE_MAX_ASSISTED: Readonly<Record<AiCapability, CapabilityRouting>> = {
  resume_extraction: {
    capability: 'resume_extraction',
    destination: 'candidate_claude_max_paste',
    credential_holder: 'candidate_own_session',
    rationale: 'the existing paste console; the candidate runs it in their own session',
  },
  resume_analysis: {
    capability: 'resume_analysis',
    destination: 'candidate_claude_max_paste',
    credential_holder: 'candidate_own_session',
    rationale: 'prepared prompt, pasted result',
  },
  job_analysis: {
    capability: 'job_analysis',
    destination: 'candidate_claude_max_paste',
    credential_holder: 'candidate_own_session',
    rationale: 'prepared prompt, pasted result',
  },
  job_scoring: {
    capability: 'job_scoring',
    destination: 'candidate_claude_max_paste',
    credential_holder: 'candidate_own_session',
    rationale: 'prepared prompt, pasted result',
  },
  eligibility_evaluation: {
    capability: 'eligibility_evaluation',
    destination: 'deterministic_rules',
    credential_holder: 'none',
    rationale: ELIGIBILITY_RATIONALE,
  },
  resume_tailoring: {
    capability: 'resume_tailoring',
    destination: 'candidate_claude_max_paste',
    credential_holder: 'candidate_own_session',
    rationale: 'prepared prompt, pasted result',
  },
  application_answer_generation: {
    capability: 'application_answer_generation',
    destination: 'candidate_claude_max_paste',
    credential_holder: 'candidate_own_session',
    rationale: 'prepared prompt, pasted result',
  },
  structured_task_creation: {
    capability: 'structured_task_creation',
    destination: 'candidate_claude_max_paste',
    credential_holder: 'candidate_own_session',
    rationale: 'prepared prompt, pasted result, validated against the closed vocabulary',
  },
};

/** The complete routing for a mode. Total by construction. */
export function routingTable(
  mode: AutomationMode
): Readonly<Record<AiCapability, CapabilityRouting>> {
  return mode === 'openrouter_only' ? OPENROUTER_ONLY : CLAUDE_MAX_ASSISTED;
}

/** Where one capability runs. */
export function routeCapability(
  mode: AutomationMode,
  capability: AiCapability
): CapabilityRouting {
  return routingTable(mode)[capability];
}

/**
 * Does this mode depend on the candidate being signed in to Claude?
 *
 * Only `claude_max_assisted` does. This is what makes
 * `claude_authentication_required` a legitimate pause reason in one mode and a
 * protocol violation in the other: raising it under `openrouter_only` would
 * ask the candidate to fix something that has no bearing on the work.
 */
export function requiresClaudeSession(mode: AutomationMode): boolean {
  return mode === 'claude_max_assisted';
}

/**
 * Does any capability in this mode use a server-held credential?
 *
 * True for `openrouter_only`, false for `claude_max_assisted` — which is the
 * whole point of the second mode: no backend AI credential is involved at all.
 */
export function usesServerHeldCredential(mode: AutomationMode): boolean {
  return Object.values(routingTable(mode)).some(
    (r) => r.credential_holder === 'server_environment'
  );
}

/* --------------------------------------------------- the extension point */

/**
 * A possible future: a candidate-controlled LOCAL capability.
 *
 * The idea is that the supervisor on the candidate's own machine could drive
 * their own Claude session locally, rather than the candidate pasting each
 * result by hand. It is recorded here so the design has somewhere to put the
 * question — and it is CLOSED, not merely unbuilt.
 *
 * NOT IMPLEMENTED, and not implementable by adding code alone. Everything
 * below must be answered first, in writing:
 *
 *   1. Account terms. Whether driving a personal subscription programmatically
 *      is permitted at all, and at what rate. This is the blocking question,
 *      and it is not a technical one.
 *   2. Consent. The candidate must understand and agree to what their own
 *      session would be used for, per run, revocably.
 *   3. Locality. It could only ever run on the candidate's machine, under
 *      their own already-open session, initiated by them. The backend would
 *      still hold nothing and see nothing.
 *   4. Security review of the local surface it would open.
 *
 * FOREVER OUT OF SCOPE, whatever the answers: reading browser storage,
 * extracting session tokens, replaying captured credentials, calling private
 * or undocumented endpoints, or disguising automated traffic as human. Those
 * are not implementation details of this extension point; they are the reason
 * it is gated.
 *
 * `AutomationMode` still has exactly two members, and a test asserts that, so
 * this cannot become real by accident.
 */
export const CLAUDE_MAX_LOCAL_CAPABILITY = {
  status: 'not_implemented',
  blocked_on: [
    'account_terms_review',
    'explicit_candidate_consent',
    'local_only_execution_design',
    'security_review',
  ],
  permanently_out_of_scope: [
    'browser_storage_access',
    'session_token_extraction',
    'credential_replay',
    'private_endpoint_calls',
    'automation_disguise',
  ],
} as const;
