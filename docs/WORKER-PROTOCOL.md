# Worker protocol

**Defined, not implemented.** This milestone launches no worker and no browser.
The contracts exist in `lib/agent/contracts.ts` so that when a worker is built,
the boundaries are already decided and already tested.

---

## What a worker is

A process on the **candidate's own machine** that drives a browser to complete
one supported application at a time, under a lease, on behalf of exactly one
candidate.

It is not a service, not multi-tenant, and not trusted. It is a pair of hands
that the control plane supervises.

## What a worker never decides

- **Eligibility.** Deterministic rules on the server —
  `EligibilityDecision.evaluator` is a `z.literal('deterministic_rules')`, so a
  model cannot be substituted without changing the contract.
- **Safety.** `lib/agent/safety.ts` runs server-side. A worker reports what it
  observed; it does not judge it.
- **Whether its own lease is still valid.** See fencing below.

## Registration

`WorkerRegistration` — `worker_id`, `candidate_id`, capabilities from a fixed
list (`form_fill`, `file_upload`, `confirmation_capture`), and `slot` bounded
to **1–10**.

Capabilities are enumerated rather than free-form so a worker cannot claim an
ability it lacks, and so an unsupported ATS control becomes a safety stop
rather than an improvisation.

## Leases

`WorkerLease` — `lease_id`, `task_id`, `worker_id`, `candidate_id`,
`acquired_at`, `expires_at`, `fence_token`.

One task, one worker, one expiry. The lease is granted by the control plane and
is the worker's only authority to act.

### Fencing: the rule that matters most

A worker that stalls — a GC pause, a suspended laptop, a hung network call —
**cannot notice its own lease expiring, because it is not running.** It wakes
believing it still holds the lease and tries to submit.

Expiry alone therefore does not protect anything. Every lease of a task
increases `fence_token`, and the control plane accepts a completion **only from
the current token**. A stale worker holds an old number and is refused,
whatever its own clock believes.

`canSubmit()` requires a valid current lease **and** `ready_to_submit`, checked
in that order, immediately before the irreversible act.

## Heartbeat

`WorkerHeartbeat` — `worker_id`, `lease_id`, `sent_at`, `status`
(`idle | working | draining | stopped`), `current_task_id`.

A `working` worker names its task; an idle one does not. Enforced by the
contract, so a heartbeat cannot claim to be busy with nothing.

A missed heartbeat lets the lease lapse. The task returns to `queued` — the
`leased → queued` edge — and the next lease increases the fence token, which is
what makes the stalled worker harmless when it returns.

## Completion, failure, handoff

- **Completion** — `AutomationTaskResult` with an outcome. `submitted`
  **requires** a `confirmation_reference`; without one it is
  `submission_unknown`, which always goes to a human.
- **Failure** — states `retryable` or `permanent`. Permanent is never retried.
- **Manual-review handoff** — the worker stops and reports the
  `SafetyDecision`. It is not a failure and is not retried automatically.

## Kill switch

`kill_switch_engaged` is checked first in the safety evaluator and stops
everything. `cancelled` is terminal in the state machine, so a stopped task
cannot be resumed by a redelivered message. Paused and cancelled are different
outcomes: paused work is resumable and still owns its idempotency key;
cancelled work is finished.

## Ten slots, later

The design targets up to ten isolated worker slots per candidate, and
`WorkerRegistration.slot` already bounds it. None run yet.

The order is: contracts (this milestone) → a single supervised worker →
concurrency → volume, with a review at each step. Concurrency multiplies the
cost of every unfixed boundary, and the boundary that matters here — two
workers, one task — is exactly what fencing exists to make safe. Building the
fence before the workers is the cheap ordering.
