# Agent contracts

Runtime-validated shapes for the control plane. Zod, matching the project's
existing convention, in `lib/agent/contracts.ts`. Every schema is `.strict()`.

Nothing here executes. These are the rules a value must satisfy before any
later component is allowed to act on it.

---

## Why `.strict()` everywhere

An unknown key is a rejection, not a field quietly ignored. That is how a
`prompt`, a `screenshot` or a `raw_response` ends up somewhere it was never
meant to be — someone adds a field "just for debugging", nothing complains, and
a candidate's employment history is now in a table that was designed to hold
counters.

## The four distinctions

**1. Unknown is not false.** Every tri-state field is `'yes' | 'no' |
'unknown'`, never a boolean. A résumé that does not mention a work permit does
not say the candidate lacks one. A boolean forces a guess at parse time, and
the guess is then typed into an employer's form as the candidate's own answer.

**2. Rejected is not unevaluated.** `EligibilityDecision.outcome` is
`eligible | ineligible | undetermined`. A job we assessed and declined should
not be retried tomorrow; a job we could not assess should be, once the profile
is complete.

**3. Manual review is not failure.** A CAPTCHA is the system working correctly
and stopping. Recording it as a failure makes the failure rate meaningless and
invites a retry that cannot succeed.

**4. Submitted is not submission-unknown.** If the page never confirmed, we do
not know. Calling it submitted hides a lost application; calling it failed
invites a duplicate. `submission_unknown` is its own outcome and always goes to
a human. Enforced: a `submitted` result **must** carry a
`confirmation_reference`, or it is not a submission.

## The contracts

| Contract | Purpose |
|---|---|
| `CandidateSnapshot` | What we know, and whether the candidate **verified** it |
| `JobUrlInput` | A pasted URL, with ownership and an idempotency key |
| `JobEnvelope` | A validated, canonicalised job with its correlation id |
| `JobSnapshot` | Evidence by **hash**, never the posting text |
| `NormalizedJob` | Structured facts; unreadable parts are named, not dropped |
| `EligibilityDecision` | Deterministic rules only — a model never decides eligibility |
| `ScoreResult` | Score plus confidence plus explanation, from OpenRouter |
| `AutomationMode` | Exactly `openrouter_only` or `claude_max_assisted` |
| `AutomationTask` | A bounded plan of steps from a closed vocabulary |
| `AutomationTaskResult` | Seven outcomes; failures state retryable vs permanent |
| `WorkerLease` | One task, one expiry, one **fence token** |
| `WorkerHeartbeat` | A working worker names its task; an idle one does not |
| `WorkerRegistration` | Capabilities from a fixed list; slot 1–10 |
| `SafetyDecision` | Proceed or stop, with reasons |
| `ApplicationAttempt` | An outcome exactly when it has finished |
| `ProviderUsageRecord` | Metadata only (see `docs/PROVIDER-CONTRACTS.md`) |
| `AutomationEvent` | Audit trail; `detail` is bounded short scalars only |

## The closed action vocabulary

`AUTOMATION_ACTIONS` has exactly nine members:

```
open_job_url · read_form · fill_known_field · attach_resume
answer_verified_question · review_before_submit · submit_application
capture_confirmation · abort
```

There is no `eval`, no `execute_javascript`, no `run_shell`, no
`navigate_to_arbitrary_url`, no `download_file`. A task is a small list of
named intentions, and anything else is a validation failure rather than a
capability. This is what stops a compromised or merely confused planner from
turning the worker into a general remote-execution surface.

A `fill_known_field` step carries a `fact_key`, not a value. The value must
trace to a **verified** `CandidateFact`; the planner may not supply free text,
and `SafetyDecision` stops on `unknown_candidate_fact` if no verified fact
exists. A step carrying an inline `value` fails validation — tested.

## Cross-field rules

Some invariants cannot be expressed field by field, so they are `.refine()`d:

- a `SafetyDecision` that stops must name a reason; one that proceeds must name
  none, and cannot simultaneously require a human;
- a `failed` result states whether it is retryable; nothing else carries a
  `failure_kind`;
- a `submitted` result carries a confirmation reference;
- a lease expires after it was acquired;
- a `working` worker names its task;
- an `ApplicationAttempt` has an outcome exactly when it has finished;
- `attempt` never exceeds `max_attempts`.

## Two bugs these tests caught

Worth recording, because both were in code that looked obviously correct:

- **`z.url()` accepts `javascript:`.** It accepts every scheme a URL parser
  accepts, including `file:` and `data:`. `JobEnvelope.canonical_url` now uses
  `HttpsUrl`, which checks the protocol explicitly.
- **`new URL()` re-serialises IPv4-mapped IPv6.**
  `https://[::ffff:127.0.0.1]/` normalises its host to `[::ffff:7f00:1]` — hex
  groups, not a dotted quad. Matching only the dotted form let a loopback
  address through as "unrecognised". Both spellings are now decoded.
