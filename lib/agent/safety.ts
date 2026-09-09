import { SAFETY_STOP_REASONS, type SafetyStopReason } from '@/lib/agent/contracts';

/**
 * The safety evaluator.
 *
 * Pure: an object in, a decision out. No database, no network, no clock of its
 * own. That is what makes it exhaustively testable, and being exhaustively
 * testable is the only reason to trust it — this is the component that decides
 * whether a machine fills in a legal attestation on a real person's behalf.
 *
 * NO RULE MAY FAIL OPEN.
 *
 * Every rule is written so that MISSING INFORMATION STOPS. Not "if we saw a
 * CAPTCHA, stop" but "unless we positively established there was no CAPTCHA,
 * stop". The difference matters because the input comes from a page parser
 * that will sometimes fail to describe a page: a field it could not read
 * becomes `unknown`, and `unknown` must never be treated as `false`.
 *
 * This is why `SafetyInput` uses tri-states rather than booleans. A boolean
 * forces the caller to invent an answer at the moment of parsing, and the
 * invention is invisible by the time it reaches here.
 *
 * A STOP IS NOT A FAILURE. It is the system noticing a human is required. It
 * is never retried automatically, and the state machine sends it to
 * `manual_review` rather than `failed`, so that the failure rate keeps meaning
 * what it says.
 */

export type Tri = 'yes' | 'no' | 'unknown';

export interface SafetyInput {
  /* ---- what the page appears to contain. `unknown` means "not established". */
  captcha_present: Tri;
  mfa_required: Tri;
  legal_attestation_present: Tri;
  demographic_question_present: Tri;
  application_fee_present: Tri;
  external_contact_requested: Tri;
  anti_bot_warning_present: Tri;
  /** Every control on the form is one the worker knows how to operate. */
  all_controls_supported: Tri;
  /** The page confirmed the outcome of a submission. */
  submission_state_confirmed: Tri;
  /** The form asks about pay. */
  compensation_question_present: Tri;

  /* ---- what we know about the candidate and the account. */
  /** Questions the form asks for which we hold no VERIFIED candidate fact. */
  unverified_required_facts: readonly string[];
  compensation_configured: boolean;
  has_resume: boolean;
  profile_complete: boolean;

  /* ---- limits. */
  kill_switch_engaged: boolean;
  applications_today: number;
  daily_quota: number;
  applications_this_month: number;
  monthly_quota: number;
  spend_usd_this_month: number;
  monthly_budget_usd: number;
}

export interface SafetyResult {
  action: 'proceed' | 'stop';
  reasons: SafetyStopReason[];
  requires_human: boolean;
}

/**
 * A hazard is present unless positively ruled out.
 *
 * `'yes'` stops. `'unknown'` stops. Only an explicit `'no'` proceeds. Written
 * once here so no individual rule can get the polarity wrong.
 */
const hazard = (t: Tri): boolean => t !== 'no';

/**
 * A capability is absent unless positively confirmed.
 *
 * The mirror image: only an explicit `'yes'` counts as present.
 */
const confirmed = (t: Tri): boolean => t === 'yes';

/**
 * Evaluate.
 *
 * Every reason is collected rather than returning on the first — a candidate
 * looking at a stopped application should see everything that stopped it, not
 * discover the next problem after fixing the first.
 */
export function evaluateSafety(input: SafetyInput): SafetyResult {
  const reasons: SafetyStopReason[] = [];

  // The candidate's own stop. Checked first: nothing else matters after it.
  if (input.kill_switch_engaged) reasons.push('kill_switch');

  // Limits. Reaching a quota exactly means it is used up, not that one more
  // fits — `>=`, deliberately.
  if (input.applications_today >= input.daily_quota) reasons.push('daily_quota_exceeded');
  if (input.applications_this_month >= input.monthly_quota) reasons.push('monthly_quota_exceeded');
  if (input.spend_usd_this_month >= input.monthly_budget_usd) reasons.push('budget_exceeded');

  // Page hazards. Each stops on 'yes' AND on 'unknown'.
  if (hazard(input.captcha_present)) reasons.push('captcha');
  if (hazard(input.mfa_required)) reasons.push('mfa_required');
  if (hazard(input.legal_attestation_present)) reasons.push('legal_attestation');
  if (hazard(input.demographic_question_present)) {
    reasons.push('protected_demographic_question');
  }
  if (hazard(input.application_fee_present)) reasons.push('application_fee');
  if (hazard(input.external_contact_requested)) reasons.push('external_contact_requested');
  if (hazard(input.anti_bot_warning_present)) reasons.push('anti_bot_warning');

  // Capabilities. Absent unless confirmed.
  if (!confirmed(input.all_controls_supported)) reasons.push('unsupported_ats_control');
  if (!confirmed(input.submission_state_confirmed)) reasons.push('ambiguous_submission_state');

  // Candidate facts. A question we cannot answer from a VERIFIED fact is not
  // one to guess at — the answer would be asserted to an employer as the
  // candidate's own.
  if (input.unverified_required_facts.length > 0) reasons.push('unknown_candidate_fact');

  // Pay is only ever answered from an explicit configuration.
  if (hazard(input.compensation_question_present) && !input.compensation_configured) {
    reasons.push('compensation_not_configured');
  }

  // Prerequisites.
  if (!input.has_resume) reasons.push('missing_resume');
  if (!input.profile_complete) reasons.push('profile_incomplete');

  return {
    action: reasons.length > 0 ? 'stop' : 'proceed',
    reasons,
    requires_human: reasons.length > 0,
  };
}

/**
 * The input that proceeds.
 *
 * Exported so tests can start from "everything is fine" and break one thing at
 * a time, which is the only way to prove each rule fires on its own rather
 * than being masked by another.
 *
 * Note what it takes to get here: every hazard explicitly `'no'`, every
 * capability explicitly `'yes'`, quotas and budget genuinely under, and the
 * profile complete. That is intentionally demanding.
 */
export const SAFE_BASELINE: SafetyInput = {
  captcha_present: 'no',
  mfa_required: 'no',
  legal_attestation_present: 'no',
  demographic_question_present: 'no',
  application_fee_present: 'no',
  external_contact_requested: 'no',
  anti_bot_warning_present: 'no',
  all_controls_supported: 'yes',
  submission_state_confirmed: 'yes',
  compensation_question_present: 'no',
  unverified_required_facts: [],
  compensation_configured: true,
  has_resume: true,
  profile_complete: true,
  kill_switch_engaged: false,
  applications_today: 0,
  daily_quota: 50,
  applications_this_month: 0,
  monthly_quota: 500,
  spend_usd_this_month: 0,
  monthly_budget_usd: 25,
};

/** Every reason the evaluator can produce, for exhaustiveness tests. */
export const ALL_STOP_REASONS: readonly SafetyStopReason[] = SAFETY_STOP_REASONS;
