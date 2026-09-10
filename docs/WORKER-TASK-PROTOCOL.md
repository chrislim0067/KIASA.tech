# The one-slot worker task protocol

What a paired worker may do to a task, what it may never do, and where each
rule is enforced. Every vocabulary below already existed — in migration 22's
CHECK constraints and in `lib/agent/contracts.ts` — and this note maps them
rather than adding a second state machine beside them.

## The one rule everything else serves

**A worker cannot cause an application to be submitted.**

`automation_tasks` has a `submitted` status and a `ready_to_submit` status
before it. No function reachable by a worker credential can write either one.
The furthest a worker can move a task is `manual_review`, which means *a person
must look at this*. `ready_to_submit → submitted` stays a candidate-authorised
transition with no implementation at all, in this milestone or the last.

This is not a policy in a comment. `worker_report_task` accepts three
dispositions and maps each to a fixed status; neither of the two submission
statuses is among them, and `scripts/test-worker-tasks.mjs` asserts that the
migration text contains no worker path to either.

## Task states, and which are reachable from a worker

Migration 22 owns the full transition table and mirrors
`lib/agent/state-machine.ts`; `check-migrations-offline.mjs` asserts the two
match. Of fifteen statuses, a worker can cause exactly four transitions:

| From | To | Caused by | Notes |
|---|---|---|---|
| `queued` | `leased` | `worker_claim_task` | the approval gate: only `queued` is claimable |
| `leased` | `processing` | `worker_claim_task` | same transaction — see below |
| `processing` | `manual_review` | `worker_report_task('completed')` | a person continues |
| `processing` | `failed` | `worker_report_task('failed')` | bounded reason recorded |
| `processing` | `queued` | `worker_report_task('released')` | back to the queue, lease released |

Everything before `queued` is the intake and eligibility pipeline and is not a
worker concern. Everything after `manual_review` is the candidate's.

**Why claim passes through `leased` into `processing` in one transaction.**
`leased` exists for a scheduler that hands work to a slot before the slot picks
it up. This milestone runs one slot with no scheduler: the claim *is* the
start. Both transitions are legal and both happen under the same lock, so the
task is never observably `leased` with nobody working it. When a multi-slot
scheduler arrives, `leased` becomes a state a task can rest in and the two
transitions separate.

## Leases and fencing

`task_leases` carries `fence_token bigint not null check (fence_token >= 1)`,
fixed at acquisition by `guard_lease_release_final`. `automation_tasks` carries
its own `fence_token`, monotonic by `guard_fence_token_monotonic`.

Claiming increments the task's fence and copies the new value onto the lease.
Every later operation must present that number: a worker holding fence 4 after
the task has been re-leased at fence 5 is stale, and its renew, release,
completion and failure are all refused with `stale_fence`. The fence is the
only thing a worker sends that is not derived from its credential, and it is
deliberately a number it cannot usefully guess forward — guessing higher is
refused as loudly as guessing lower, because the check is equality.

Two partial unique indexes do the heavy lifting, both `where released_at is
null`: one active lease per task, one per slot. An **expired but unreleased**
lease therefore still occupies both. `worker_claim_task` reclaims one before
claiming: it releases the stale lease with `release_reason = 'expired'`,
records `lease_expired`, and returns its task to `queued`. Without that a
crashed worker would wedge its own slot until a human intervened.

`task_leases_bounded_life` caps `expires_at` at `acquired_at + 1 hour`, so
renewal extends a lease but can never carry it past an hour from acquisition.
A task needing longer must be released and re-claimed, which is the point:
an hour of silence is not a worker that is still working.

`guard_lease_release_final` refuses to renew a lease that has already expired,
refuses to reopen a released one, refuses to move its fence, and refuses to
reassign it. Those are triggers, not application logic, so they hold for any
caller.

## Readiness, pause and stop — the contradiction, resolved

Migration 22 constrains `worker_slots` with two "iff" rules that were in
conflict with the heartbeat contract:

- `worker_slots_pause_reason_iff_paused` — `readiness = 'paused'` **if and only
  if** `pause_reason is not null`.
- `worker_slots_stop_reason_iff_stopping` — `readiness in ('stopping',
  'stopped')` **if and only if** `stop_reason is not null`.

The heartbeat carried no reason field. Migration 26 refused `paused` outright
and *invented* `supervisor_shutdown` for `stopped`. Inventing a reason puts a
fiction in an audit trail, so migration 27 removes that: the heartbeat now
carries the reason, and the rules become explicit.

| Readiness | Reason required | From which vocabulary | Reasons cleared |
|---|---|---|---|
| `initializing` | none | — | both |
| `ready` | none | — | both |
| `working` | none | — | both |
| `paused` | **yes** | `WORKER_PAUSE_REASONS` (10) | stop only |
| `stopping` | **yes** | `WORKER_STOP_REASONS` (7) | pause only |
| `stopped` | **yes** | `WORKER_STOP_REASONS` (7) | pause only |
| `crashed` | none | — | both |

The vocabularies are `lib/agent/contracts.ts`'s `WORKER_PAUSE_REASONS` and
`WORKER_STOP_REASONS`, which are the same lists migration 22's CHECK
constraints hold. **No free text is accepted from a worker anywhere.**

- `paused` vs `stopping` vs `stopped`: paused is *recoverable and waiting on
  something* — a CAPTCHA, an employer login, an MFA prompt, a question nobody
  taught it to answer. Stopping and stopped are *ending*: a kill switch, a
  candidate's request, a crash, a required update. A paused slot expects to be
  resumed; a stopped one expects to be re-paired or restarted.
- **Returning to ready**: a heartbeat reporting `ready`, `working`,
  `initializing` or `crashed` clears both reason columns. There is no separate
  resume operation, and none is needed — the constraint makes a stale reason
  impossible rather than merely untidy.
- **A missing or wrong-vocabulary reason is refused**, with
  `pause_reason_required` or `stop_reason_required`. The worker never invents
  one: `worker/kiasa-worker.mjs` sends `supervisor_shutdown` on its own clean
  shutdown because that is what is happening, and sends nothing else.
- **Shutdown travels through the heartbeat**, not a separate operation. A
  worker that is stopping is still reporting, and a second endpoint would be a
  second thing to get wrong at exactly the moment the process is going away.

## What the candidate sees, and how the states differ

`visibleStatus()` derives what the pairing panel shows, and the five outcomes
mean five different things:

- **not_paired** — no credential exists.
- **revoked** — the credential or supervisor was disowned. Terminal; re-pair.
- **expired** — the credential passed its 30-day life. Terminal; re-pair.
- **stale** — a live credential that has not reported within 90 seconds. The
  worker may be off, asleep, or without a network. Nothing is wrong with the
  pairing.
- **online** — reported within the window.

**paused** is a slot fact, not a pairing fact: an online worker whose slot is
paused is still online and still reporting, and the panel shows the pause
reason alongside. A safety stop cannot become `ready` by anything other than a
heartbeat that says `ready`, which clears the reason atomically with the status
— there is no path that clears a reason while leaving the state stopped, and
none that reports ready while leaving a reason behind.

## Events

`worker_events` allows twenty kinds and bounds `detail` to a 2000-character
JSON object. This milestone writes eight of them, all from inside the operation
that caused them, in the same transaction:

| Event | Written by | `detail` |
|---|---|---|
| `lease_expired` | `worker_claim_task` (reclaim) | `{}` |
| `lease_acquired` | `worker_claim_task` | `{"fence": n}` |
| `task_started` | `worker_claim_task` | `{"fence": n}` |
| `lease_renewed` | `worker_renew_lease` | `{"fence": n}` |
| `lease_released` | `worker_report_task` | `{"fence": n, "disposition": …}` |
| `task_completed` | `worker_report_task('completed')` | `{"fence": n}` |
| `task_failed` | `worker_report_task('failed')` | `{"fence": n, "reason": …}` |
| `slot_paused` / `slot_stopped` / `slot_crashed` | `worker_record_heartbeat` | `{"reason": …}` |

**There is no generic event-writing function.** A worker cannot ask for an
event; it performs an operation and the operation records what happened. Actor
and candidate are read from the credential row, the kind is a literal in the
function body, and `detail` is built with `jsonb_build_object` from bounded
scalars — a fence number and a reason drawn from a CHECK-constrained
vocabulary. No job text, employer text, résumé text, URL, hash or token can
reach it, because no such value is ever in scope.

**Heartbeat events are written on transition only.** A slot beating every
thirty seconds for a day is 2,880 heartbeats and, under this rule, zero event
rows unless something actually changed. That is the bounded-rate strategy:
`worker_record_heartbeat` compares the incoming readiness with the stored one
and writes nothing when they match.

## Who may do what

| Operation | Actor | Enforced by |
|---|---|---|
| create a job, create a task, approve it to `queued` | candidate session | RLS `auth.uid() = user_id` |
| claim, renew, report | worker credential | `security definer`, EXECUTE to `service_role` only |
| pause, stop, resume | worker credential, via heartbeat | same |
| revoke a credential or supervisor | candidate session | RLS + column grants |
| `ready_to_submit`, `submitted` | **nobody, yet** | no code path exists |

A worker names no candidate, no supervisor, no slot, no task and no lease. It
presents a credential id, the hash of the token minted for it, and — where
staleness matters — a fence number. Everything else is read from the row that
pair matches.
