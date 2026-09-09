# The agent control plane

What each part of the system is responsible for, and where the boundaries are.

**Nothing in this milestone executes an application.** There is no fetcher, no
browser, no queue runner and no worker. This is the contract layer, built first
on purpose: a boundary discovered after the fact is discovered by an
application that has already been sent to a real employer on someone's behalf.

Implemented in `lib/agent/` and `lib/ai/`, covered by 294 offline checks in
`scripts/test-agent-control-plane.mjs`.

---

## 1. Who does what

| Component | Owns | Must never |
|---|---|---|
| **Vercel** (Next.js) | Candidate UI, auth, server actions, contract validation, OpenRouter calls, writing usage rows | Run a browser; hold a Claude credential; execute worker steps |
| **Supabase** | Identity, candidate profile, jobs, tasks, leases, attempts, `provider_usage`, RLS | Be reachable by a worker except through the API with the candidate's own session |
| **Local worker** (future) | Driving a browser on the candidate's machine, one task at a time under a lease | Decide eligibility, decide safety, or submit without a current lease |
| **OpenRouter** | The only backend AI API: résumé extraction, later job scoring | Receive a résumé PDF, a credential, or anything not bounded text |
| **Claude Max** | The candidate's own capability, on their own machine, in their own session | Be reached by the backend in any way — see §2 |

## 2. The Claude Max boundary

`claude_max_assisted` does **not** mean the backend calls Claude. It means the
**candidate** does part of the work themselves, in their own session, and
pastes the result back — exactly as the existing résumé paste console already
works: a link they click and a box they paste into.

The backend therefore never holds a Claude credential, never drives a Claude
session, and never sees one. Specifically forbidden, and asserted by test:
`@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`, `api.anthropic.com`, cookies,
`localStorage`, session-token extraction, private endpoints.

This is a licensing and consent boundary as much as a technical one. A Claude
Max subscription is a person's own account. Automating it from a server would
be using their credential as though it were ours.

## 3. Candidate ownership

Every contract carries `candidate_id`. Jobs, tasks, leases, attempts, events
and usage rows all belong to exactly one candidate, and RLS is the enforcement
— schema validation is not authorization. A worker is registered **to a
candidate** and may only ever lease that candidate's tasks.

## 4. The pipeline

```
candidate pastes a URL
  → received       validate the URL (lib/agent/job-url.ts) — no fetch yet
  → validated      canonical, https, public destination, ownership, idempotency key
  → snapshot_stored  evidence of what the page said, by hash
  → normalized     structured job facts; unreadable parts are NAMED
  → scored         OpenRouter, deterministic eligibility first
  → queued         eligible and worth doing
  → leased         one worker, one task, one expiry, one fence token
  → processing     steps from a CLOSED action vocabulary
  → manual_review | ready_to_submit
  → submitted      terminal
```

`rejected`, `failed`, `duplicate` and `cancelled` are the other exits. The full
table is `docs/AGENT-STATE-MACHINE.md`.

## 5. Queue, leases and idempotency

A lease grants the right to work on one task until one instant. It carries a
**fence token** that increases every time the task is leased, and the control
plane accepts a completion only from the current token.

This is the single most important rule in the system. A worker that stalls — a
GC pause, a suspended laptop, a hung network call — **cannot notice its own
lease expiring, because it is not running**. It wakes believing it still holds
the lease and tries to submit. Expiry alone does not stop it; a fence token
does, because the decision is made by the control plane rather than by the
worker's opinion of its own state.

`canSubmit()` therefore requires a valid, current lease **and** the
`ready_to_submit` state, checked in that order, before the irreversible act.

Every task carries an `idempotency_key`. A retry reuses it, so a redelivered
queue message is a no-op rather than a second real application. Retries never
reset the attempt counter, and a *permanent* failure is never retried however
many attempts remain.

## 6. Cost accounting

Every provider call produces a `ProviderUsageRecord`, written by
`lib/ai/usage-writer.ts` into `provider_usage`. Metadata only — see
`docs/PROVIDER-CONTRACTS.md` §7 for the three mechanisms that enforce that.

The budget is a **safety stop**, not a report: `budget_exceeded` and the quota
reasons stop automation before a call, not after the invoice.

## 7. Safety stops

`lib/agent/safety.ts` is pure and exhaustively tested. Seventeen stop reasons,
and **no rule may fail open**: every hazard stops on `yes` *and* on `unknown`,
every capability must be positively confirmed. Missing information stops.

This is why the contracts use tri-states rather than booleans. A boolean forces
the page parser to invent an answer, and by the time it reaches the evaluator
the invention is invisible. See `docs/AGENT-SAFETY-POLICY.md`.

## 8. A known limit: DNS rebinding

`validateJobUrl()` rejects literal private addresses, but **a hostname is not
an address**. `evil.example.com` may resolve to `127.0.0.1`, and validation
here happens before DNS.

The fetcher — when it is built — **must** resolve the hostname and validate the
**resolved address** immediately before connecting, and must re-validate every
redirect hop the same way. That is a requirement of the fetcher, recorded here
because it cannot be enforced from this layer, and it is the reason the fetcher
is a separately reviewed piece rather than part of this milestone.

## 9. Why high volume is not enabled

The target is 500–1,000 applications a day. This milestone deliberately builds
none of it, because volume multiplies the cost of every unfixed boundary. At
one application an hour a wrong answer is an embarrassment; at a thousand a day
it is a thousand wrong answers sent in someone's name, to employers they may
later want to work for.

The order is: contracts, then safety, then a single supervised worker, then
concurrency, then volume — and each step is reviewed before the next. Ten
worker slots is the ceiling the design targets, and `WorkerRegistration.slot`
already bounds it. See `docs/WORKER-PROTOCOL.md`.
