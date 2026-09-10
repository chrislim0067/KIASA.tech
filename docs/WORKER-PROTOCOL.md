# Worker protocol

**Defined, not implemented.** Nothing in this repository starts a supervisor, a
slot or a browser. The contracts live in `lib/agent/contracts.ts`, the rules in
`lib/agent/worker-state.ts`, and 202 offline checks in
`scripts/test-worker-protocol.mjs` hold them to it.

Written first on purpose: a boundary discovered afterwards is discovered by an
application that has already been sent to a real employer in someone's name.

---

## 1. Topology: one supervisor, many slots

```text
KIASA web application
        ↓
Vercel control plane
        ↓
Supabase database and task queue
        ↓
Candidate's local supervisor          ← one process, on their own machine
        ├── slot 1                    ← isolated browser context, own lease
        ├── slot 2
        └── slot N                    ← up to 10
        ↓
Supported employer application website
```

The **supervisor** is a process. A **slot** is an execution unit. They are not
the same thing and the protocol never treats them as one.

Each slot has, independently: a slot id, a browser context, a lease, a current
task, a heartbeat, a readiness state, a pause state, an error state and a
shutdown state. Nine slots carrying on while the tenth crashes is the normal
case, not an edge case.

### The mistake this replaces

An earlier draft modelled **one worker with one `current_task_id`**. That shape
cannot describe ten slots doing ten different things: a heartbeat naming one
task is false about the other nine, and nine in-flight applications become
invisible to the control plane.

So the rule is structural rather than advisory:

> **Authoritative task and lease state is per slot.** The supervisor heartbeat
> carries a lifecycle, a list of slot summaries and three counts. It has no
> `current_task_id`, no `lease_id` and no `fence_token`, and cannot be given
> one — the schema is `.strict()` and a test asserts each absence by name.

The summary counts are *derived* from the slot list by `summariseSlots()` and
re-checked by the contract, so a supervisor cannot report three ready slots
while listing none.

### Ten slots is a target, not a feature

Ten is the ceiling the design admits (`MAX_SLOTS_PER_SUPERVISOR`, and
`slot_index` is bounded 1–10). **None run.** The order is contracts → a single
supervised slot → concurrency → volume, with a review at each step, because
concurrency multiplies the cost of every unfixed boundary.

## 2. Running is not ready

Two vocabularies, deliberately separate:

| Vocabulary | Values | About |
|---|---|---|
| `SUPERVISOR_LIFECYCLE_STATES` | `offline` · `starting` · `running` · `stopping` | the process |
| `SLOT_READINESS_STATES` | `initializing` · `ready` · `working` · `paused` · `stopping` · `stopped` · `crashed` | one execution unit |

"The program is running" and "there is a slot able to take work" are different
facts. A supervisor still opening its browser contexts is `starting`, and a
task handed to it is a task dropped. `canAcceptTask()` requires **both** a
`running` supervisor and a `ready` slot.

`crashed` is separate from `stopped`: a stopped slot was asked to stop, a
crashed one was not, and only the second is a reason to read logs. Neither may
act on a task.

`SlotState` is a discriminated union rather than a status string with optional
fields, because optionality is where lies live. A `working` slot cannot be
constructed without a task **and** its lease; a `paused` slot cannot be
constructed without a reason.

## 3. Leases and fencing

`SlotLease` — `lease_id`, `task_id`, `slot_id`, `supervisor_id`,
`candidate_id`, `acquired_at`, `expires_at`, `fence_token`.

The lease names its **slot**, not its supervisor. A supervisor-scoped lease
would let slot 3 complete the task slot 7 holds.

### Why expiry alone is not enough

A slot that stalls — a GC pause, a suspended laptop, a hung network call —
**cannot notice its own lease expiring, because it is not running.** It wakes
believing it still holds the lease and tries to submit.

So the control plane decides, not the slot. Every lease of a task increases
`fence_token`, and work is accepted **only from the current token**. A stale
slot holds an old number and is refused, whatever its own clock believes.

### Renewal

`evaluateRenewal()` extends a living lease. Two rules:

1. **An expired lease is never renewed.** It already returned to the queue and
   was re-leased under a higher token; reviving it would put two slots on one
   task. A slot refused with `expired` must abandon the task — someone else has
   it now.
2. **A lease cannot be held forever by renewing.** A hung slot that keeps
   sending renewals looks alive and would hold a task hostage.
   `MAX_TOTAL_LEASE_SECONDS` (3600) from acquisition is the ceiling.

The new expiry is measured from *now*, not from the old expiry, so a slot that
renews late does not bank the time it was unresponsive.

### Submission takes four checks

`canSlotSubmit()`, in order: supervisor `running` → slot `working` → lease
valid and current → task `ready_to_submit`.

The lease check alone is not enough. A slot can hold a perfect lease and still
have no business submitting: it may have paused on a challenge, be shutting
down, or have crashed and restarted into a context that never saw the form.

## 4. Heartbeats

**Per slot** (`SlotHeartbeat`) — authoritative. State, lease and the token the
slot believes it holds. A `working` slot must hold the lease *for the task it
names*; every other state holds none.

**Per supervisor** (`SupervisorHeartbeat`) — summary only, for showing a
candidate what their machine is doing. Anything authoritative is read from the
slot's own heartbeat.

`sequence` is monotonic per slot and `isHeartbeatFresh()` discards anything not
strictly newer. Heartbeats arrive out of order — a retry can overtake the
message it was retrying — and applying a stale one would show a crashed slot as
`working` and leave its task leased. Equal sequence numbers are rejected too: a
duplicate carries no news and must not restart the liveness clock.

**No credential rides along.** `.strict()` with a fixed field list means there
is no key a token or session credential could attach to, and
`findCredentialLikeKeys()` asserts it by reading key names — with planted
positive controls, because a detector that never fires is not a control.
`fence_token` is a counter, not a credential, and deliberately does not match.

## 5. Idempotency

**Registration.** A supervisor is identified by `supervisor_id`, generated once
on the candidate's machine; a slot by `(supervisor_id, slot_index)`. Timestamps
are not part of the key, so re-registering is an upsert. A laptop that
reconnects forty times a day must not create forty supervisors, each holding
leases nobody will release.

**Completion.** `(task_id, idempotency_key)` is the identity of a report.
`dedupeTaskEvents()` sorts incoming reports into four buckets:

| Bucket | Meaning |
|---|---|
| `accepted` | the first report for a key |
| `duplicates` | the same key making the same claim — discarded, counted |
| `conflicts` | the same key making a **different** claim — sent to a human |
| `fenced` | a report from a slot holding a stale token — refused |

A conflict is never resolved by picking one. "Submitted" and "failed" cannot
both be true, and a last-write-wins rule would settle a question about a real
application by arrival order. A fenced report is kept apart from duplicates on
purpose: folding it in would hide a stale slot claiming a submission.

## 6. Stops: authentication, challenges, unknown pages

The worker **reports what it observed**; the control plane decides what it
means. `WORKER_PAUSE_REASONS` is the observation vocabulary,
`SAFETY_STOP_REASONS` the decision vocabulary, and `PAUSE_REASON_TO_SAFETY` is
a total map between them — a new observation cannot be added without deciding
what the control plane does about it.

| The slot saw | The control plane calls it |
|---|---|
| `employer_authentication_required` | `employer_authentication_required` |
| `claude_authentication_required` | `claude_authentication_required` |
| `captcha_detected` | `captcha` |
| `anti_bot_challenge_detected` | `anti_bot_warning` |
| `mfa_required` | `mfa_required` |
| `sensitive_information_requested` | `sensitive_information_requested` |
| `unknown_page` | `unknown_page` |
| `unknown_question` | `unknown_candidate_fact` |
| `unsupported_site` | `unsupported_site` |
| `control_plane_paused` | — (the control plane already knows) |

**A login page is not a form.** It is the single most dangerous page to
misread: it renders inputs, labels and a submit button, and a worker that types
into it puts the candidate's details into a login attempt. `employer_session`
is a capability that must be positively confirmed — `unknown` pauses.

**A challenge is never worked around.** No solving, no MFA interception, no
anti-bot evasion, no automation fingerprint masking. A challenge exists to
establish that a person is present, and the honest answer is to fetch the
person. No pause reason means "try harder"; a test asserts none of them match
`bypass|solve|evade|retry|ignore`.

**Sensitive information stops unconditionally.** Government id numbers, bank
details, dates of birth, immigration documents. There is no configuration that
turns these into an answer a machine may type: the harm of being wrong is not a
bad application, it is a person's identity documents in a form they never saw.

**An unrecognised page or unsupported site is a stop, not a guess.** Both are
capabilities requiring positive confirmation, so "we could not tell" pauses.

A stop is **not a failure** and is never retried automatically. It is the
system noticing a human is required.

## 7. Stop reasons

`WORKER_STOP_REASONS` — `candidate_requested`, `kill_switch`,
`supervisor_shutdown`, `slot_crashed`, `lease_lost`, `protocol_violation`,
`update_required`. Shutting a slot down is a different fact from pausing a
task, and the two vocabularies do not overlap.

`kill_switch_engaged` is checked first in the safety evaluator. `cancelled` is
terminal in the state machine, so a stopped task cannot be resumed by a
redelivered message. Paused work is resumable and still owns its idempotency
key; cancelled work is finished.

## 8. What a slot may be asked to do

`SlotCommand` carries steps drawn from `AUTOMATION_ACTIONS` and nothing else:
`open_job_url`, `read_form`, `fill_known_field`, `attach_resume`,
`answer_verified_question`, `review_before_submit`, `submit_application`,
`capture_confirmation`, `abort`.

There is no `script`, no `execute_javascript`, no freely-chosen navigation, no
shell. A command is a short list of named intentions against a task already
validated, scored and approved server-side. This is what stops a confused or
compromised planner from turning a candidate's browser into a general
remote-execution surface.

Capabilities are declared **per slot** (`form_fill`, `file_upload`,
`confirmation_capture`), because a browser context is what determines whether a
file upload works. Declaring once at the supervisor would let one broken
context claim what the others have. An unsupported control is a stop, never an
improvisation.

## 9. What a worker never decides

- **Eligibility.** `EligibilityDecision.evaluator` is a
  `z.literal('deterministic_rules')` — the contract cannot express a model
  having decided.
- **Safety.** `lib/agent/safety.ts` runs on the control plane.
- **Whether its own lease is still valid.** See fencing.
- **Whether a task is approved, paused, rejected or executable.** All four are
  the control plane's.

A worker is registered to **one candidate** and may only lease that candidate's
tasks. RLS is the enforcement; schema validation is not authorization.

## 10. Implemented now, and not

Updated at Milestone 2B.

| | Status |
|---|---|
| Contracts, state vocabularies, lease and fencing rules, routing table | **implemented** (types and pure functions) |
| Offline test suites | **implemented** — 209 worker, 142 local-Claude, 88 slice |
| **Database tables** for supervisors, slots, tasks, leases, events | **implemented** — migration 22, with RLS, partial unique indexes and transition triggers |
| **Local Claude adapter** (official interface) | **implemented and proven working** — see `docs/LOCAL-CLAUDE.md` |
| **One-slot flow** against a local fixture | **implemented** — `npm run demo:slice` |
| Supervisor process, long-running slot runtime | not implemented |
| Pairing code, scoped worker token, HTTP transport, registration endpoints | not implemented |
| Browser adapter and live browser automation | not implemented — the fixture is read, no browser is driven |
| Ten concurrent slots | not implemented; a capacity target. The runtime uses slot 1 only |
| Real submissions | not implemented — the flow reaches the submit gate and stops |

No supported-site adapter exists yet, so **no site is supported yet**. KIASA
does not claim it can apply to every website, and the design assumes some
applications will always stop for a person.

## 11. Claude Max is not driven by the backend

`claude_max_assisted` means the **candidate** does the reasoning in their own
session and pastes the result back — the same shape as the existing résumé
paste console. The backend holds no Claude credential, drives no Claude
session, and calls no Claude endpoint. There is no private API, no hidden
endpoint, no session-token extraction, no browser-storage access, no credential
replay.

See `docs/AI-MODES.md` for both modes, the routing table, and the closed
extension point for a possible future local capability.
