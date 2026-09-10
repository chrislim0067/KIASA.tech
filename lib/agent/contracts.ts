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
  /*
   * Added in Milestone 2A, because the worker protocol needs the control plane
   * to be able to SAY these things.
   *
   * A login wall, an unrecognised page and an unsupported site are the three
   * situations most likely to be mistaken for an ordinary application form —
   * the page renders, there are inputs, and a naive worker types into them.
   * Each gets its own name so the reason a candidate sees is the true one, and
   * so the fix ("sign in to Workday") is actionable rather than "something
   * went wrong".
   */
  'employer_authentication_required',
  /** Only reachable in claude_max_assisted mode. See lib/agent/ai-mode.ts. */
  'claude_authentication_required',
  'sensitive_information_requested',
  'unknown_page',
  'unsupported_site',
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

/**
 * THE TOPOLOGY, STATED ONCE.
 *
 *   one candidate
 *     └── one local SUPERVISOR (a process on their own machine)
 *           ├── slot 1   isolated browser context, own lease, own task
 *           ├── slot 2   ...
 *           └── slot N   up to MAX_SLOTS_PER_SUPERVISOR
 *
 * The supervisor is a PROCESS. A slot is an EXECUTION UNIT. The distinction is
 * load-bearing and was got wrong once already: an earlier draft modelled one
 * worker with one `current_task_id`, which cannot describe ten slots doing ten
 * different things. Worse, it invites a heartbeat that names one task while
 * nine others are mid-application and invisible.
 *
 * So the rule below is structural rather than advisory:
 *
 *   AUTHORITATIVE TASK AND LEASE STATE IS PER SLOT. The supervisor heartbeat
 *   carries counts and slot states — it has no `current_task_id`, no
 *   `lease_id` and no `fence_token`, and cannot be given one, because the
 *   schema is `.strict()`.
 *
 * Ten slots is a CAPACITY TARGET, not a shipped feature. Nothing in this
 * repository starts a supervisor, a slot, or a browser.
 */

export const WORKER_CAPABILITIES = [
  'form_fill',
  'file_upload',
  'confirmation_capture',
] as const;

export const WorkerCapability = z.enum(WORKER_CAPABILITIES);
export type WorkerCapability = z.infer<typeof WorkerCapability>;

/** The ceiling the design targets. Not a promise that ten will run. */
export const MAX_SLOTS_PER_SUPERVISOR = 10;

/* ------------------------------------------------- lifecycle and readiness */

/**
 * The SUPERVISOR's lifecycle. Four states, about the process itself.
 *
 * Deliberately separate from slot readiness: "the program is running" and
 * "there is a slot able to take work" are different facts, and conflating them
 * is how a control plane hands a task to a process that has no free browser.
 * See docs/WORKER-PROTOCOL.md, "running is not ready".
 */
export const SUPERVISOR_LIFECYCLE_STATES = ['offline', 'starting', 'running', 'stopping'] as const;
export const SupervisorLifecycle = z.enum(SUPERVISOR_LIFECYCLE_STATES);
export type SupervisorLifecycle = z.infer<typeof SupervisorLifecycle>;

/**
 * A SLOT's readiness. Only `ready` may be given work, and only `working` may
 * finish it.
 *
 * `crashed` is separate from `stopped` because they need different responses:
 * a stopped slot was asked to stop, a crashed one was not, and only the second
 * is a reason to look at logs. Neither may act on a task.
 */
export const SLOT_READINESS_STATES = [
  'initializing',
  'ready',
  'working',
  'paused',
  'stopping',
  'stopped',
  'crashed',
] as const;
export const SlotReadiness = z.enum(SLOT_READINESS_STATES);
export type SlotReadiness = z.infer<typeof SlotReadiness>;

/**
 * Why a slot stopped working on a task WITHOUT failing.
 *
 * These are OBSERVATIONS, not judgements. The worker reports what it saw on
 * the page; `lib/agent/safety.ts` — which runs on the control plane — decides
 * what that means. `lib/agent/worker-state.ts` holds the total mapping from
 * each reason here to a `SafetyStopReason`, so a new observation cannot be
 * added without deciding what the control plane does about it.
 *
 * Every one of these is a STOP, never a thing to work around. There is no
 * reason here that means "try harder", and specifically: no challenge solving,
 * no MFA interception, no anti-bot evasion, no automation fingerprint masking.
 * A challenge exists to establish that a person is present, and the honest
 * answer is to fetch the person.
 */
export const WORKER_PAUSE_REASONS = [
  /** The employer site wants a login the candidate must perform themselves. */
  'employer_authentication_required',
  /** Claude Max assisted mode only — see AiModeConfig and §2 of the docs. */
  'claude_authentication_required',
  'captcha_detected',
  'anti_bot_challenge_detected',
  'mfa_required',
  /** Government id, bank details, date of birth, immigration documents. */
  'sensitive_information_requested',
  /** The page does not look like an application form we recognise. */
  'unknown_page',
  /** A question we hold no verified answer for. */
  'unknown_question',
  /** A site the adapter does not support. Not a failure; nothing was broken. */
  'unsupported_site',
  /** The control plane paused it — a candidate, a quota, a budget. */
  'control_plane_paused',
] as const;
export const WorkerPauseReason = z.enum(WORKER_PAUSE_REASONS);
export type WorkerPauseReason = z.infer<typeof WorkerPauseReason>;

/** Why a slot is shutting down or gone. Distinct from pausing a task. */
export const WORKER_STOP_REASONS = [
  'candidate_requested',
  'kill_switch',
  'supervisor_shutdown',
  'slot_crashed',
  /** The control plane refused this slot's lease — it is fenced out. */
  'lease_lost',
  /** The slot sent something the protocol does not allow. */
  'protocol_violation',
  'update_required',
] as const;
export const WorkerStopReason = z.enum(WORKER_STOP_REASONS);
export type WorkerStopReason = z.infer<typeof WorkerStopReason>;

/**
 * Where each state named in the Milestone 2A requirement lives.
 *
 * This exists as DATA rather than prose because prose drifts. A test asserts
 * every entry resolves to a real member of a real vocabulary, so deleting or
 * renaming any of them breaks the build rather than quietly removing a state
 * the design depends on.
 */
export const REQUIRED_STATE_COVERAGE = {
  worker_offline: { vocabulary: 'supervisor_lifecycle', member: 'offline' },
  worker_starting: { vocabulary: 'supervisor_lifecycle', member: 'starting' },
  worker_running: { vocabulary: 'supervisor_lifecycle', member: 'running' },
  worker_stopping: { vocabulary: 'supervisor_lifecycle', member: 'stopping' },
  ready_for_work: { vocabulary: 'slot_readiness', member: 'ready' },
  task_paused: { vocabulary: 'slot_readiness', member: 'paused' },
  task_failed: { vocabulary: 'task_event', member: 'task_failed' },
  task_completed: { vocabulary: 'task_event', member: 'task_completed' },
  employer_authentication_required: {
    vocabulary: 'pause_reason',
    member: 'employer_authentication_required',
  },
  claude_authentication_required: {
    vocabulary: 'pause_reason',
    member: 'claude_authentication_required',
  },
  captcha_or_anti_bot: { vocabulary: 'pause_reason', member: 'captcha_detected' },
  mfa_required: { vocabulary: 'pause_reason', member: 'mfa_required' },
  sensitive_information_required: {
    vocabulary: 'pause_reason',
    member: 'sensitive_information_requested',
  },
  unknown_page_or_question: { vocabulary: 'pause_reason', member: 'unknown_page' },
  unsupported_website: { vocabulary: 'pause_reason', member: 'unsupported_site' },
} as const;

/* ------------------------------------------------------------ registration */

/**
 * A supervisor announcing itself.
 *
 * IDEMPOTENT BY KEY. The identity is `supervisor_id`, generated once on the
 * candidate's machine and reused for the life of the install. Re-registering
 * is an upsert of the same row, not a second supervisor — a laptop that
 * reconnects forty times a day must not create forty supervisors, each holding
 * leases nobody will ever release. See `supervisorKey()`.
 *
 * There is NO credential field here, and there is not one anywhere else in
 * this file either. A worker authenticates with the candidate's own Supabase
 * session; it never holds a service-role key and never sees an OpenRouter key.
 */
export const SupervisorRegistration = z
  .object({
    supervisor_id: Uuid,
    candidate_id: Uuid,
    registered_at: z.iso.datetime(),
    /** Free text would be a fingerprint; this is a coarse bucket. */
    platform: z.enum(['windows', 'macos', 'linux']),
    /** The supervisor build, so an old protocol can be refused. */
    agent_version: z.string().min(1).max(40).regex(/^\d+\.\d+\.\d+$/),
    /** How many slots this install intends to run. A ceiling, not a promise. */
    declared_slots: z.number().int().min(1).max(MAX_SLOTS_PER_SUPERVISOR),
  })
  .strict();
export type SupervisorRegistration = z.infer<typeof SupervisorRegistration>;

/**
 * One slot announcing itself, under its supervisor.
 *
 * CAPABILITIES ARE DECLARED PER SLOT, not per supervisor. A slot is a browser
 * context, and whether a file upload works is a property of that context
 * rather than of the program that spawned it. Declaring once at the top would
 * let one broken context claim an ability the others have.
 *
 * `browser_context_id` is an opaque local handle. It exists so the control
 * plane can tell two slots apart in a support conversation. It is deliberately
 * NOT a path, NOT a profile directory and NOT a reference to stored browser
 * credentials: nothing about the candidate's browser contents ever crosses
 * this boundary.
 */
export const SlotRegistration = z
  .object({
    slot_id: Uuid,
    supervisor_id: Uuid,
    candidate_id: Uuid,
    /** 1..10, unique within a supervisor. The uniqueness is a DB constraint. */
    slot_index: z.number().int().min(1).max(MAX_SLOTS_PER_SUPERVISOR),
    capabilities: z.array(WorkerCapability).min(1).max(WORKER_CAPABILITIES.length),
    browser_context_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    registered_at: z.iso.datetime(),
  })
  .strict();
export type SlotRegistration = z.infer<typeof SlotRegistration>;

/* ------------------------------------------------------------------ leases */

/**
 * A lease: the right for ONE SLOT to work on ONE TASK until ONE INSTANT.
 *
 * `fence_token` is what makes a stale slot harmless. It increases every time a
 * task is leased, and the control plane accepts work only from the CURRENT
 * token. A slot that stalls past its expiry, wakes, and tries to submit is
 * holding an old number and is refused — without this, "my lease expired" is
 * something the slot has to notice about itself, and a suspended laptop cannot
 * notice anything.
 *
 * The lease names its SLOT, not its supervisor, because the supervisor is not
 * the thing doing the work. A supervisor-scoped lease would let slot 3 finish
 * a task slot 7 was leased.
 */
export const SlotLease = z
  .object({
    lease_id: Uuid,
    task_id: Uuid,
    slot_id: Uuid,
    supervisor_id: Uuid,
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
export type SlotLease = z.infer<typeof SlotLease>;

/**
 * A slot asking for more time.
 *
 * Renewal EXTENDS a living lease; it never revives a dead one. An expired
 * lease has already been returned to the queue and re-leased under a higher
 * fence token, so reviving it would put two slots on one task — precisely the
 * outcome fencing exists to prevent. `evaluateRenewal()` in
 * `lib/agent/worker-state.ts` enforces that, and is tested at the boundary.
 */
export const LeaseRenewalRequest = z
  .object({
    lease_id: Uuid,
    task_id: Uuid,
    slot_id: Uuid,
    /** The token the slot believes it holds. Compared, never trusted. */
    fence_token: z.number().int().min(1),
    requested_at: z.iso.datetime(),
    /** How much longer, bounded. An unbounded extension is not a lease. */
    extend_by_seconds: z.number().int().min(30).max(900),
  })
  .strict();
export type LeaseRenewalRequest = z.infer<typeof LeaseRenewalRequest>;

/* -------------------------------------------------------------- slot state */

/**
 * What a slot is doing, as a DISCRIMINATED UNION.
 *
 * A union rather than a status string with optional fields, because the fields
 * that matter differ per state and optionality is where lies live: a `paused`
 * status with an optional `pause_reason` permits a pause that never says why,
 * and a `working` status with an optional `task_id` permits the exact bug this
 * milestone exists to fix. Here, a `working` slot cannot be constructed
 * without a task and a lease, and a `paused` slot cannot be constructed
 * without a reason.
 */
export const SlotState = z.discriminatedUnion('state', [
  z.object({ state: z.literal('initializing'), since: z.iso.datetime() }).strict(),
  z.object({ state: z.literal('ready'), since: z.iso.datetime() }).strict(),
  z
    .object({
      state: z.literal('working'),
      since: z.iso.datetime(),
      task_id: Uuid,
      lease_id: Uuid,
    })
    .strict(),
  z
    .object({
      state: z.literal('paused'),
      since: z.iso.datetime(),
      /** A pause before a task was leased is possible; the reason is not. */
      task_id: Uuid.nullable(),
      lease_id: Uuid.nullable(),
      pause_reason: WorkerPauseReason,
      /** True when only the candidate can clear it — a login, a challenge. */
      requires_candidate_action: z.boolean(),
    })
    .strict(),
  z
    .object({
      state: z.literal('stopping'),
      since: z.iso.datetime(),
      stop_reason: WorkerStopReason,
    })
    .strict(),
  z
    .object({ state: z.literal('stopped'), since: z.iso.datetime(), stop_reason: WorkerStopReason })
    .strict(),
  z
    .object({
      state: z.literal('crashed'),
      since: z.iso.datetime(),
      /** A short code, never a stack trace and never page content. */
      failure_code: z.string().min(1).max(100),
    })
    .strict(),
]);
export type SlotState = z.infer<typeof SlotState>;

/**
 * Whether the sessions a slot depends on are actually established.
 *
 * FOUR VALUES, not a boolean and not a tri-state. `not_applicable` is a real
 * answer here: in `openrouter_only` mode there is no Claude session to be
 * authenticated to, and reporting `unknown` for it would raise a pause reason
 * that mode can never satisfy.
 */
export const SessionState = z.enum([
  'authenticated',
  'not_authenticated',
  'unknown',
  'not_applicable',
]);
export type SessionState = z.infer<typeof SessionState>;

/**
 * Authentication as its own reported fact, separate from readiness.
 *
 * A slot can be perfectly healthy and still unable to proceed because the
 * candidate is signed out of the employer's site. That is not a crash, not a
 * failure and not a reason to retry — it is a pause that only a person can
 * clear, which is why it is modelled here rather than folded into an error.
 *
 * `claude_max_session` is `not_applicable` in `openrouter_only` mode and must
 * be a real answer in `claude_max_assisted` mode. Enforced below, so
 * `claude_authentication_required` cannot be raised in a mode that has no
 * Claude session — one of this milestone's required tests.
 */
export const SlotAuthenticationState = z
  .object({
    slot_id: Uuid,
    candidate_id: Uuid,
    checked_at: z.iso.datetime(),
    mode: AutomationMode,
    /** Whether the employer site considers this browser context signed in. */
    employer_session: SessionState,
    /** The host it was checked against. A hostname, never a URL with a path. */
    employer_host: z.string().min(1).max(253).nullable(),
    claude_max_session: SessionState,
  })
  .strict()
  .refine((a) => (a.mode === 'openrouter_only') === (a.claude_max_session === 'not_applicable'), {
    message:
      'a Claude session is not applicable in openrouter_only mode, and must be reported in claude_max_assisted mode',
  })
  .refine((a) => a.employer_session !== 'not_applicable', {
    message: 'there is always an employer session to report',
  });
export type SlotAuthenticationState = z.infer<typeof SlotAuthenticationState>;

/* -------------------------------------------------------------- heartbeats */

/**
 * ONE SLOT's heartbeat. This is the authoritative one.
 *
 * Everything the control plane needs to decide whether this slot may act is
 * here: its state, its lease, and the token it believes it holds. The lease
 * block is present exactly when the state is `working`, which the refinement
 * below enforces — a heartbeat cannot claim to be mid-task with no lease, nor
 * hold a lease while idle.
 *
 * NO SECRETS, STRUCTURALLY. `.strict()` plus this fixed field list means there
 * is no key a token, session credential, header or page fragment could be
 * attached to. A test asserts the key set directly, because "we would never
 * add that field" is not a control.
 */
export const SlotHeartbeat = z
  .object({
    slot_id: Uuid,
    supervisor_id: Uuid,
    candidate_id: Uuid,
    slot_index: z.number().int().min(1).max(MAX_SLOTS_PER_SUPERVISOR),
    sent_at: z.iso.datetime(),
    /** Monotonic per slot. A late heartbeat must not resurrect an old state. */
    sequence: z.number().int().min(0),
    state: SlotState,
    lease: z
      .object({
        lease_id: Uuid,
        task_id: Uuid,
        fence_token: z.number().int().min(1),
        expires_at: z.iso.datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((h) => (h.state.state === 'working') === (h.lease !== null), {
    message: 'a working slot holds a lease; every other state holds none',
  })
  .refine(
    (h) =>
      h.state.state !== 'working' ||
      (h.lease !== null &&
        h.lease.task_id === h.state.task_id &&
        h.lease.lease_id === h.state.lease_id),
    { message: 'a working slot must hold the lease for the task it names' }
  );
export type SlotHeartbeat = z.infer<typeof SlotHeartbeat>;

/**
 * One line about one slot, for the supervisor's summary.
 *
 * Readiness and task id only. No lease, no fence token, no expiry: the summary
 * is a convenience for showing a candidate what their machine is doing, and
 * anything authoritative must be read from the slot's own heartbeat. Making
 * that a schema fact rather than a habit is the point.
 */
export const SlotSummary = z
  .object({
    slot_id: Uuid,
    slot_index: z.number().int().min(1).max(MAX_SLOTS_PER_SUPERVISOR),
    readiness: SlotReadiness,
    task_id: Uuid.nullable(),
  })
  .strict()
  .refine((s) => (s.readiness === 'working') === (s.task_id !== null), {
    message: 'a working slot names its task; every other readiness names none',
  });
export type SlotSummary = z.infer<typeof SlotSummary>;

/**
 * The SUPERVISOR's heartbeat. Summary only.
 *
 * THE FIELD THAT IS DELIBERATELY ABSENT is `current_task_id`. A supervisor
 * running ten slots is working on up to ten tasks, and a single task id at
 * this level would be false in nine ways at once. `.strict()` means it cannot
 * be added by accident, and a test asserts its absence by name so that adding
 * it back is a failing build rather than a code review someone skims.
 *
 * The counts are checked against `slots` below, so a summary cannot report
 * three ready slots while listing none.
 */
export const SupervisorHeartbeat = z
  .object({
    supervisor_id: Uuid,
    candidate_id: Uuid,
    sent_at: z.iso.datetime(),
    sequence: z.number().int().min(0),
    lifecycle: SupervisorLifecycle,
    slots: z.array(SlotSummary).max(MAX_SLOTS_PER_SUPERVISOR),
    slots_ready: z.number().int().min(0).max(MAX_SLOTS_PER_SUPERVISOR),
    slots_working: z.number().int().min(0).max(MAX_SLOTS_PER_SUPERVISOR),
    slots_paused: z.number().int().min(0).max(MAX_SLOTS_PER_SUPERVISOR),
  })
  .strict()
  .refine((h) => new Set(h.slots.map((s) => s.slot_index)).size === h.slots.length, {
    message: 'slot_index is unique within a supervisor',
  })
  .refine((h) => new Set(h.slots.map((s) => s.slot_id)).size === h.slots.length, {
    message: 'a slot appears at most once in a summary',
  })
  .refine((h) => h.slots.filter((s) => s.readiness === 'ready').length === h.slots_ready, {
    message: 'slots_ready must match the slots listed',
  })
  .refine((h) => h.slots.filter((s) => s.readiness === 'working').length === h.slots_working, {
    message: 'slots_working must match the slots listed',
  })
  .refine((h) => h.slots.filter((s) => s.readiness === 'paused').length === h.slots_paused, {
    message: 'slots_paused must match the slots listed',
  })
  .refine((h) => h.lifecycle !== 'offline' || h.slots.length === 0, {
    message: 'an offline supervisor has no slots',
  });
export type SupervisorHeartbeat = z.infer<typeof SupervisorHeartbeat>;

/* ----------------------------------------------------- commands and events */

/**
 * The control plane instructing a slot.
 *
 * The steps come from `AUTOMATION_ACTIONS` and nowhere else. There is no
 * `script`, no `url` the planner picked freely, no arbitrary navigation: a
 * command is a short list of named intentions against a task that was already
 * validated, scored and approved server-side. This is what keeps a confused or
 * compromised planner from turning a candidate's browser into a general
 * remote-execution surface.
 *
 * It carries the fence token so the slot can be refused at completion time
 * even if it was leased legitimately when the command was issued.
 */
export const SlotCommand = z
  .object({
    command_id: Uuid,
    task_id: Uuid,
    slot_id: Uuid,
    candidate_id: Uuid,
    lease_id: Uuid,
    fence_token: z.number().int().min(1),
    issued_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    mode: AutomationMode,
    steps: z.array(AutomationStep).min(1).max(50),
  })
  .strict()
  .refine((c) => Date.parse(c.expires_at) > Date.parse(c.issued_at), {
    message: 'a command must expire after it was issued',
  });
export type SlotCommand = z.infer<typeof SlotCommand>;

/** What a slot may report about a task. Four kinds, closed. */
export const TASK_EVENT_KINDS = [
  'task_started',
  'task_paused',
  'task_completed',
  'task_failed',
] as const;

/**
 * A slot reporting how a task went.
 *
 * DUPLICATES ARE EXPECTED, not exceptional. A completion sent over a flaky
 * connection is retried; a redelivered queue message replays. So the event
 * carries `idempotency_key`, and `(task_id, idempotency_key)` is the identity
 * — `completionKey()` builds it and `dedupeTaskEvents()` collapses on it, so a
 * message delivered twice produces one application rather than two.
 *
 * The fence token is carried and checked. A completion from a stale slot is
 * REFUSED rather than deduplicated: those are different facts, and treating a
 * fenced submission as "already done" would hide it.
 */
export const TaskEvent = z
  .object({
    event_id: Uuid,
    kind: z.enum(TASK_EVENT_KINDS),
    task_id: Uuid,
    slot_id: Uuid,
    supervisor_id: Uuid,
    candidate_id: Uuid,
    lease_id: Uuid,
    fence_token: z.number().int().min(1),
    idempotency_key: IdempotencyKey,
    correlation_id: CorrelationId,
    reported_at: z.iso.datetime(),
    /** Present exactly when the task finished. */
    result: AutomationTaskResult.nullable(),
    /** Present exactly when the task paused. */
    pause_reason: WorkerPauseReason.nullable(),
  })
  .strict()
  .refine((e) => (e.kind === 'task_paused') === (e.pause_reason !== null), {
    message: 'a pause names its reason, and nothing else carries one',
  })
  .refine((e) => (e.kind === 'task_completed' || e.kind === 'task_failed') === (e.result !== null), {
    message: 'a finished task carries its result, and an unfinished one does not',
  });
export type TaskEvent = z.infer<typeof TaskEvent>;

/* ------------------------------------------------------- candidate ai mode */

/**
 * Which mode this candidate has chosen, and what that implies.
 *
 * THERE IS NO CREDENTIAL FIELD, in either mode, and this is the contract where
 * one would most plausibly be added by someone in a hurry. The OpenRouter key
 * lives in the server environment and is read by `lib/ai/config.ts`; it is
 * never stored per candidate, never returned to a browser, never sent to a
 * supervisor and never written to a row. `claude_max_assisted` holds no Claude
 * credential because it does not use one — the candidate does the work in
 * their own session and pastes the result back.
 *
 * A test asserts the key set of this object directly.
 */
export const AiModeConfig = z
  .object({
    candidate_id: Uuid,
    mode: AutomationMode,
    updated_at: z.iso.datetime(),
    /** `vendor/model`, resolved server-side. Null means the server default. */
    openrouter_model: z
      .string()
      .min(3)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/)
      .nullable(),
    /** The paste console is the whole of Claude Max assisted mode. */
    paste_console_enabled: z.boolean(),
  })
  .strict()
  .refine((c) => (c.mode === 'claude_max_assisted') === c.paste_console_enabled, {
    message: 'claude_max_assisted is the paste console; openrouter_only does not enable it',
  });
export type AiModeConfig = z.infer<typeof AiModeConfig>;

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
