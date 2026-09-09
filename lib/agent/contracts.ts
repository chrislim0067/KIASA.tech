import { z } from 'zod';

import { ProviderUsageRecord } from '@/lib/ai/usage';

/**
 * The typed contracts of the agent control plane.
 *
 * NOTHING HERE EXECUTES ANYTHING. These are shapes and their rules — no
 * fetching, no browser, no queue, no worker. They exist so that when those are
 * built, the boundaries are already decided and already tested, rather than
 * being discovered by a worker halfway through submitting an application on
 * somebody's behalf.
 *
 * FOUR DISTINCTIONS THE WHOLE DESIGN RESTS ON
 *
 * 1. UNKNOWN IS NOT FALSE. A résumé that does not mention a work permit does
 *    not say the candidate lacks one. Every tri-state field here is
 *    `'yes' | 'no' | 'unknown'`, never a boolean, because a boolean forces a
 *    guess at the moment of parsing and the guess is then asserted on a real
 *    application form.
 *
 * 2. REJECTED IS NOT UNEVALUATED. A job we scored and declined and a job we
 *    have not looked at are different facts, and only one of them should be
 *    retried tomorrow.
 *
 * 3. MANUAL REVIEW IS NOT FAILURE. A CAPTCHA is the system working correctly
 *    and stopping. Recording it as a failure would make the failure rate
 *    meaningless and would invite a retry that cannot succeed.
 *
 * 4. SUBMITTED IS NOT "SUBMISSION UNKNOWN". If the page never confirmed, we do
 *    not know. Guessing "submitted" hides a lost application; guessing "failed"
 *    invites a duplicate. `submission_unknown` is its own outcome and always
 *    goes to a human.
 *
 * Everything is `.strict()`. An unknown key is a rejection, not a field
 * silently ignored — that is how a `prompt` or a `screenshot` ends up
 * somewhere it was never meant to be.
 */

/* ------------------------------------------------------------- primitives */

/** Unknown is a first-class answer, never coerced to "no". */
export const Tristate = z.enum(['yes', 'no', 'unknown']);
export type Tristate = z.infer<typeof Tristate>;

export const Uuid = z.uuid();

/**
 * An idempotency key supplied by the caller.
 *
 * Opaque and bounded. It is the only thing standing between a retry and a
 * second real job application, so it is required wherever an action could be
 * repeated.
 */
export const IdempotencyKey = z.string().min(16).max(200).regex(/^[A-Za-z0-9_.:-]+$/);

/** Ties every record produced by one logical operation together. */
export const CorrelationId = Uuid;

export const Confidence = z.number().min(0).max(1);

/**
 * An https URL, and only https.
 *
 * `z.url()` alone accepts every scheme a URL parser accepts — including
 * `javascript:`, `file:` and `data:`. A contract field holding a job posting
 * must not, so the scheme is checked explicitly. Caught by its own test, which
 * is the only reason it is not still wrong.
 */
export const HttpsUrl = z
  .string()
  .min(8)
  .max(2048)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be an https URL' }
  );

/**
 * The two supported modes, and exactly these two.
 *
 *   openrouter_only      the backend does the reasoning through OpenRouter.
 *   claude_max_assisted  the CANDIDATE does part of it themselves, in their
 *                        own Claude session, on their own machine. The backend
 *                        never holds a Claude credential, never drives a Claude
 *                        session, and never sees one. It prepares work and
 *                        accepts a pasted result, exactly as the existing
 *                        résumé paste console already does.
 */
export const AutomationMode = z.enum(['openrouter_only', 'claude_max_assisted']);
export type AutomationMode = z.infer<typeof AutomationMode>;

/* --------------------------------------------------------- candidate facts */

/**
 * What we know about the candidate, and how we know it.
 *
 * `verified` is the load-bearing field. A fact a model read off a PDF has NOT
 * been asserted by the person; only a fact they confirmed has. An unverified
 * fact may inform a score. It may never be typed into an employer's form —
 * `SafetyDecision` stops on `unknown_candidate_fact` precisely for this.
 */
export const CandidateFact = z
  .object({
    key: z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/),
    value: z.string().min(1).max(2000).nullable(),
    verified: z.boolean(),
    /** Where it came from, so an unverified fact is traceable. */
    source: z.enum(['candidate_entered', 'resume_import', 'derived']),
  })
  .strict();

export const CandidateSnapshot = z
  .object({
    candidate_id: Uuid,
    /** The instant this snapshot describes. A later profile edit does not change it. */
    captured_at: z.iso.datetime(),
    mode: AutomationMode,

    profile_complete: z.boolean(),
    has_resume: z.boolean(),

    /** Tri-state on purpose: a silent résumé is not a "no". */
    work_authorization: Tristate,
    requires_visa_sponsorship: Tristate,
    willing_to_relocate: Tristate,

    /**
     * Compensation is only ever answered when the candidate configured it.
     * Absent means the automation must stop, not improvise a number.
     */
    compensation_configured: z.boolean(),

    facts: z.array(CandidateFact).max(500),
  })
  .strict();
export type CandidateSnapshot = z.infer<typeof CandidateSnapshot>;

/* -------------------------------------------------------------- job intake */

/**
 * A URL a candidate pasted.
 *
 * Only the shape is defined here; `lib/agent/job-url.ts` holds the rules, and
 * NOTHING in this milestone fetches it.
 */
export const JobUrlInput = z
  .object({
    candidate_id: Uuid,
    url: z.string().min(8).max(2048),
    idempotency_key: IdempotencyKey,
    submitted_at: z.iso.datetime(),
  })
  .strict();
export type JobUrlInput = z.infer<typeof JobUrlInput>;

/** A validated, canonicalised job URL with its ownership recorded. */
export const JobEnvelope = z
  .object({
    job_id: Uuid,
    candidate_id: Uuid,
    canonical_url: HttpsUrl,
    host: z.string().min(1).max(253),
    source: z.enum(['candidate_url', 'approved_api']),
    idempotency_key: IdempotencyKey,
    correlation_id: CorrelationId,
    received_at: z.iso.datetime(),
  })
  .strict();
export type JobEnvelope = z.infer<typeof JobEnvelope>;

/**
 * Evidence: what the page said, when.
 *
 * `content_hash` rather than the content. This contract deliberately does not
 * carry the posting text — storage of employer content is a separate decision
 * with its own retention rules, and putting it here would smuggle it into
 * every log line that prints a snapshot.
 */
export const JobSnapshot = z
  .object({
    snapshot_id: Uuid,
    job_id: Uuid,
    fetched_at: z.iso.datetime(),
    http_status: z.number().int().min(100).max(599),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    byte_size: z.number().int().min(0).max(50_000_000),
    /** Where the bytes live, if they were kept at all. */
    storage_path: z.string().min(1).max(400).nullable(),
  })
  .strict();
export type JobSnapshot = z.infer<typeof JobSnapshot>;

export const NormalizedJob = z
  .object({
    job_id: Uuid,
    snapshot_id: Uuid,
    title: z.string().min(1).max(300).nullable(),
    company: z.string().min(1).max(300).nullable(),
    location: z.string().min(1).max(300).nullable(),
    remote: Tristate,
    employment_type: z
      .enum(['full_time', 'part_time', 'contract', 'internship', 'temporary', 'freelance'])
      .nullable(),
    /** The ATS the form is on. `unknown` is honest; a guess is not. */
    ats: z.enum(['greenhouse', 'lever', 'workday', 'ashby', 'smartrecruiters', 'other', 'unknown']),
    /** Absent means the posting did not say, never "no salary". */
    salary_min: z.number().min(0).max(100_000_000).nullable(),
    salary_max: z.number().min(0).max(100_000_000).nullable(),
    salary_currency: z.string().length(3).regex(/^[A-Z]{3}$/).nullable(),
    posted_at: z.iso.datetime().nullable(),
    /** What the parser could not read. Named, not silently dropped. */
    unreadable_sections: z.array(z.string().min(1).max(200)).max(50),
  })
  .strict();
export type NormalizedJob = z.infer<typeof NormalizedJob>;

/* ------------------------------------------------------ decisions and scores */

/**
 * Eligible, ineligible, or undetermined — three outcomes, not two.
 *
 * `undetermined` exists so a missing fact cannot masquerade as a rejection. A
 * job we could not assess should be looked at again once the profile is
 * complete; a job we assessed and declined should not.
 */
export const EligibilityDecision = z
  .object({
    job_id: Uuid,
    candidate_id: Uuid,
    decided_at: z.iso.datetime(),
    outcome: z.enum(['eligible', 'ineligible', 'undetermined']),
    /** Machine-readable, from a fixed vocabulary. */
    reasons: z
      .array(
        z.enum([
          'work_authorization_missing',
          'work_authorization_mismatch',
          'location_mismatch',
          'seniority_mismatch',
          'employment_type_mismatch',
          'compensation_below_floor',
          'duplicate_application',
          'unsupported_ats',
          'profile_incomplete',
          'posting_unreadable',
          'candidate_excluded_company',
        ])
      )
      .max(20),
    /** Deterministic rules only. A model does not decide eligibility. */
    evaluator: z.literal('deterministic_rules'),
  })
  .strict();
export type EligibilityDecision = z.infer<typeof EligibilityDecision>;

export const ScoreResult = z
  .object({
    job_id: Uuid,
    candidate_id: Uuid,
    scored_at: z.iso.datetime(),
    score: z.number().min(0).max(100),
    confidence: Confidence,
    /** Kept so a surprising score can be understood rather than argued with. */
    explanation: z.string().min(1).max(2000),
    model: z.string().min(1).max(200),
    provider: z.literal('openrouter'),
    correlation_id: CorrelationId,
  })
  .strict();
export type ScoreResult = z.infer<typeof ScoreResult>;

/* ------------------------------------------------------------ safety */

export const SAFETY_STOP_REASONS = [
  'captcha',
  'mfa_required',
  'legal_attestation',
  'protected_demographic_question',
  'unknown_candidate_fact',
  'compensation_not_configured',
  'application_fee',
  'external_contact_requested',
  'unsupported_ats_control',
  'anti_bot_warning',
  'ambiguous_submission_state',
  'missing_resume',
  'profile_incomplete',
  'kill_switch',
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
  'budget_exceeded',
] as const;

export const SafetyStopReason = z.enum(SAFETY_STOP_REASONS);
export type SafetyStopReason = z.infer<typeof SafetyStopReason>;

/**
 * The evaluator's verdict.
 *
 * `stop` is never a failure and never retried automatically — see
 * `lib/agent/safety.ts`. It is the system noticing that a human is required.
 */
export const SafetyDecision = z
  .object({
    decided_at: z.iso.datetime(),
    action: z.enum(['proceed', 'stop']),
    reasons: z.array(SafetyStopReason).max(SAFETY_STOP_REASONS.length),
    /** True when a person must look before anything else happens. */
    requires_human: z.boolean(),
  })
  .strict()
  .refine((d) => (d.action === 'stop') === d.reasons.length > 0, {
    message: 'a stop must name at least one reason, and proceeding must name none',
  })
  .refine((d) => !(d.action === 'proceed' && d.requires_human), {
    message: 'proceeding cannot simultaneously require a human',
  });
export type SafetyDecision = z.infer<typeof SafetyDecision>;

/* ------------------------------------------------------------- automation */

/**
 * The actions a worker may ever be asked to perform.
 *
 * A CLOSED VOCABULARY, and that is the point. There is no `eval`, no `script`,
 * no `shell`, no `navigate_to_arbitrary_url`, no `execute_javascript`. A task
 * is a small list of named intentions, and anything outside the list is a
 * validation failure rather than a capability. This is what stops a
 * compromised or confused planner from turning the worker into a general
 * remote-execution surface.
 */
export const AUTOMATION_ACTIONS = [
  'open_job_url',
  'read_form',
  'fill_known_field',
  'attach_resume',
  'answer_verified_question',
  'review_before_submit',
  'submit_application',
  'capture_confirmation',
  'abort',
] as const;

export const AutomationAction = z.enum(AUTOMATION_ACTIONS);

/**
 * One step. `field` and `value` exist only for `fill_known_field`, and the
 * value must trace to a VERIFIED candidate fact — the planner may not invent
 * an answer, which `SafetyDecision.unknown_candidate_fact` also enforces.
 */
export const AutomationStep = z
  .object({
    action: AutomationAction,
    field: z.string().min(1).max(120).regex(/^[a-z][a-z0-9_]*$/).nullable(),
    /** The key of the CandidateFact this value came from. Never free text. */
    fact_key: z.string().min(1).max(80).regex(/^[a-z][a-z0-9_]*$/).nullable(),
  })
  .strict();

export const AutomationTask = z
  .object({
    task_id: Uuid,
    job_id: Uuid,
    candidate_id: Uuid,
    mode: AutomationMode,
    /** Required. It is what makes a retry safe. */
    idempotency_key: IdempotencyKey,
    correlation_id: CorrelationId,
    created_at: z.iso.datetime(),
    /** Bounded so a runaway plan cannot be scheduled. */
    steps: z.array(AutomationStep).min(1).max(50),
    /** Attempts already made. A retry increments it; it never resets. */
    attempt: z.number().int().min(0).max(10),
    max_attempts: z.number().int().min(1).max(10),
  })
  .strict()
  .refine((t) => t.attempt <= t.max_attempts, {
    message: 'attempt cannot exceed max_attempts',
  });
export type AutomationTask = z.infer<typeof AutomationTask>;

/**
 * How a task ended.
 *
 * `submission_unknown` is separate from both `submitted` and `failed`, and
 * always requires a human. A page that never confirmed leaves us genuinely not
 * knowing: calling it submitted hides a lost application, calling it failed
 * invites a duplicate.
 *
 * `paused` is separate from `cancelled`. Paused work is resumable and still
 * owns its idempotency key; cancelled work is finished and must never resume.
 */
export const AutomationTaskResult = z
  .object({
    task_id: Uuid,
    finished_at: z.iso.datetime(),
    outcome: z.enum([
      'submitted',
      'submission_unknown',
      'manual_review',
      'failed',
      'paused',
      'cancelled',
      'duplicate',
    ]),
    /** Present for every outcome except a clean submission. */
    safety: SafetyDecision.nullable(),
    /** Retryable and permanent are different facts; a caller must not infer. */
    failure_kind: z.enum(['retryable', 'permanent']).nullable(),
    failure_code: z.string().min(1).max(100).nullable(),
    /** Proof, when the page gave any. A reference, never a screenshot blob. */
    confirmation_reference: z.string().min(1).max(300).nullable(),
    steps_completed: z.number().int().min(0).max(50),
  })
  .strict()
  .refine((r) => (r.outcome === 'failed') === (r.failure_kind !== null), {
    message: 'a failure states whether it is retryable; nothing else carries a failure_kind',
  })
  .refine((r) => !(r.outcome === 'submitted' && r.confirmation_reference === null), {
    message: 'a submission without a confirmation reference is submission_unknown, not submitted',
  });
export type AutomationTaskResult = z.infer<typeof AutomationTaskResult>;

/* ---------------------------------------------------------------- workers */

export const WORKER_CAPABILITIES = [
  'form_fill',
  'file_upload',
  'confirmation_capture',
] as const;

/**
 * A lease: the right to work on exactly one task until exactly one instant.
 *
 * `fence_token` is what makes a stale worker harmless. It increases every time
 * a task is leased, and the control plane accepts a completion only from the
 * CURRENT token. A worker that stalls past its expiry, wakes, and tries to
 * submit is holding an old token and is refused — without this, "my lease
 * expired" is something the worker has to notice about itself, and a paused
 * process cannot notice anything.
 */
export const WorkerLease = z
  .object({
    lease_id: Uuid,
    task_id: Uuid,
    worker_id: Uuid,
    /** Leases belong to the candidate whose work they touch. */
    candidate_id: Uuid,
    acquired_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    fence_token: z.number().int().min(1),
  })
  .strict()
  .refine((l) => Date.parse(l.expires_at) > Date.parse(l.acquired_at), {
    message: 'a lease must expire after it was acquired',
  });
export type WorkerLease = z.infer<typeof WorkerLease>;

export const WorkerHeartbeat = z
  .object({
    worker_id: Uuid,
    lease_id: Uuid.nullable(),
    sent_at: z.iso.datetime(),
    status: z.enum(['idle', 'working', 'draining', 'stopped']),
    /** The worker's own view; the control plane still decides. */
    current_task_id: Uuid.nullable(),
  })
  .strict()
  .refine((h) => (h.status === 'working') === (h.current_task_id !== null), {
    message: 'a working worker names its task; an idle one does not',
  });
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeat>;

export const WorkerRegistration = z
  .object({
    worker_id: Uuid,
    candidate_id: Uuid,
    /** Free-form names invite a worker claiming capabilities it lacks. */
    capabilities: z.array(z.enum(WORKER_CAPABILITIES)).min(1).max(WORKER_CAPABILITIES.length),
    registered_at: z.iso.datetime(),
    /** Ten slots is the ceiling the design targets; see docs/WORKER-PROTOCOL.md. */
    slot: z.number().int().min(1).max(10),
  })
  .strict();
export type WorkerRegistration = z.infer<typeof WorkerRegistration>;

/* ------------------------------------------------------------ application */

export const ApplicationAttempt = z
  .object({
    attempt_id: Uuid,
    job_id: Uuid,
    candidate_id: Uuid,
    task_id: Uuid,
    started_at: z.iso.datetime(),
    finished_at: z.iso.datetime().nullable(),
    outcome: z
      .enum(['submitted', 'submission_unknown', 'manual_review', 'failed', 'cancelled', 'duplicate'])
      .nullable(),
    mode: AutomationMode,
    idempotency_key: IdempotencyKey,
    correlation_id: CorrelationId,
  })
  .strict()
  .refine((a) => (a.finished_at === null) === (a.outcome === null), {
    message: 'an attempt has an outcome exactly when it has finished',
  });
export type ApplicationAttempt = z.infer<typeof ApplicationAttempt>;

/* ---------------------------------------------------------------- events */

/**
 * The audit trail.
 *
 * `detail` is a bounded map of short scalars — deliberately not `z.unknown()`,
 * because an unconstrained payload is where a job description, a prompt or a
 * screenshot eventually lands. If something does not fit in a short scalar, it
 * does not belong in an event.
 */
export const AutomationEvent = z
  .object({
    event_id: Uuid,
    candidate_id: Uuid,
    job_id: Uuid.nullable(),
    task_id: Uuid.nullable(),
    correlation_id: CorrelationId,
    occurred_at: z.iso.datetime(),
    kind: z.enum([
      'job_received',
      'job_validated',
      'snapshot_stored',
      'job_normalized',
      'job_scored',
      'job_rejected',
      'task_queued',
      'task_leased',
      'task_processing',
      'manual_review_required',
      'ready_to_submit',
      'application_submitted',
      'task_failed',
      'task_duplicate',
      'task_cancelled',
      'kill_switch_engaged',
      'quota_exceeded',
      'budget_exceeded',
    ]),
    detail: z
      .record(
        z.string().min(1).max(40),
        z.union([z.string().max(200), z.number(), z.boolean(), z.null()])
      )
      .refine((d) => Object.keys(d).length <= 20, { message: 'at most 20 detail keys' }),
  })
  .strict();
export type AutomationEvent = z.infer<typeof AutomationEvent>;

/** Re-exported so every agent contract is reachable from one module. */
export { ProviderUsageRecord };
