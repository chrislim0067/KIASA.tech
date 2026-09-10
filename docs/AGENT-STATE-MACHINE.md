# Agent state machine

Fifteen states, one transition table, in `lib/agent/state-machine.ts`.

Written as **data rather than conditionals** because the interesting question
is never "can this one transition happen" but "what is the complete set, and
which are missing". A table can be read, diffed and tested exhaustively.
Conditionals spread across five request handlers cannot.

---

## States

| State | Meaning |
|---|---|
| `received` | A URL arrived. Nothing has been fetched. |
| `validated` | URL is https, public, canonical, owned, idempotent. |
| `snapshot_stored` | Evidence of what the page said, by hash. |
| `normalized` | Structured facts; unreadable parts named. |
| `scored` | Assessed. |
| `rejected` | Assessed **and declined**. Not the same as unevaluated. |
| `queued` | Eligible and worth doing. |
| `leased` | One worker holds it, until one instant, under one fence token. |
| `processing` | Steps are being executed. |
| `manual_review` | A human is required. **Not a failure.** |
| `ready_to_submit` | The last gate before an irreversible act. |
| `submitted` | Sent. **Terminal.** |
| `failed` | Malfunctioned. Retryable or permanent. |
| `duplicate` | Already done under another task. **Terminal.** |
| `cancelled` | The candidate stopped it. **Terminal.** |

## Transition table

```
received         → validated · rejected · duplicate · cancelled
validated        → snapshot_stored · failed · cancelled
snapshot_stored  → normalized · failed · cancelled
normalized       → scored · rejected · failed · cancelled
scored           → queued · rejected · cancelled
queued           → leased · cancelled · duplicate
leased           → processing · queued · failed · cancelled
processing       → manual_review · ready_to_submit · failed · queued · cancelled
manual_review    → ready_to_submit · cancelled · failed
ready_to_submit  → submitted · manual_review · failed · cancelled
failed           → queued · manual_review · cancelled
rejected         → (none)
submitted        → (none)
duplicate        → (none)
cancelled        → (none)
```

## The rules that protect a real person

**Terminal means terminal.** Nothing leaves `submitted`, `cancelled` or
`duplicate`. An application that reached an employer cannot be unsent, so it
must not be re-sent by a retry, a redelivered queue message, or a worker waking
up confused. A "stop" that a stale message can undo is not a stop.

**`failed → submitted` does not exist.** A malfunction never becomes a
submission. The only path to `submitted` is through `ready_to_submit`.

**`leased → queued` is the expiry path.** A lease can lapse without the worker
noticing, which returns the task to the queue. It is the only way a lease ends
other than the worker acting.

**Fails closed.** `canTransition()` answers false for any edge not listed, and
for states it has never heard of. A transition nobody thought about is refused,
not permitted by omission. `transition()` says which of `unknown_state`,
`terminal` or `not_allowed` applies.

## Retries

`isRetryAllowed()` refuses unless **all** hold: not terminal · state is
`failed` · the failure was `retryable` · attempts remain.

A **permanent** failure is never retried however many attempts remain —
retrying a rejected file upload four more times produces four more rejections
and four more charges. Attempts are counted and never reset.

A retry reuses the same `idempotency_key`, so replay is a no-op rather than a
second real application.

## Leases and fencing

`isLeaseValid()` requires a lease that exists, belongs to this worker, carries
the **current** fence token, and has not expired — checked in that order.

The fence token is the point. A worker that stalls **cannot notice its own
lease expiring, because it is not running**. It wakes believing it still holds
the lease. Expiry alone does not stop it. Every lease of a task increases the
token, and only the current token is accepted, so the decision is made by the
control plane rather than by the worker's opinion of its own state.

`canSubmit()` requires a valid current lease **and** `ready_to_submit`, in that
order. It is the last thing checked before the irreversible act, and it is
tested against a stale token, an expired lease, the wrong worker, no lease, a
malformed expiry, the wrong state, and an already-submitted task.
