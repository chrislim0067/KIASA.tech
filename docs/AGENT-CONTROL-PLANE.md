# The agent control plane

What each part of the system is responsible for, and where the boundaries are.

**Nothing in this milestone executes an application.** There is no fetcher, no
browser, no queue runner and no worker. This is the contract layer, built first
on purpose: a boundary discovered after the fact is discovered by an
application that has already been sent to a real employer on someone's behalf.

Implemented in `lib/agent/` and `lib/ai/`, covered by 312 offline checks in
`scripts/test-agent-control-plane.mjs` and 202 in
`scripts/test-worker-protocol.mjs`.

---

## 1. Who does what

```text
KIASA web application
        ↓
Vercel control plane
        ↓
Supabase database and task queue
        ↓
Candidate's local supervisor          ← one process, on their own machine
        ├── slot 1 … slot N           ← isolated browser contexts, up to 10
        ↓
Supported employer application website
```

| Component | Owns | Must never |
|---|---|---|
| **Vercel** (Next.js) | Candidate UI, auth, server actions, contract validation, OpenRouter calls, writing usage rows | Run a browser; hold a Claude credential; execute worker steps |
| **Supabase** | Identity, candidate profile, jobs, tasks, leases, attempts, `provider_usage`, RLS | Be reachable by a worker except through the API with the candidate's own session |
| **Local supervisor** (future) | One process on the candidate's machine, managing slots and their lifecycles | Hold a service-role key; decide eligibility or safety; carry a task id of its own |
| **Slot** (future) | One isolated browser context running one task under one lease | Submit without a current lease; act while paused, stopping or crashed |
| **OpenRouter** | The only backend AI API: résumé extraction, analysis, scoring, tailoring, answer drafting | Receive a résumé PDF, a credential, or anything not bounded text |
| **Claude Max** | The candidate's own capability, on their own machine, in their own session | Be reached by the backend in any way — see §2 |

## 2. The Claude Max boundary

`claude_max_assisted` does **not** mean the backend calls Claude. It means the
**candidate** does part of the work themselves, in their own session, and
pastes the result back — exactly as the existing résumé paste console already
works: a link they click and a box they paste into.

The backend therefore never holds a Claude credential, never drives a Claude
session, and never sees one. Specifically forbidden, and asserted by test:
`@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`, `api.anthropic.com`, cookies,
browser storage, session-token extraction, private endpoints.

This is a licensing and consent boundary as much as a technical one. A Claude
Max subscription is a person's own account. Automating it from a server would
be using their credential as though it were ours.

Both modes, the full routing table, and the closed extension point for a
possible future local capability are in `docs/AI-MODES.md`. Two facts from it
belong here: **the OpenRouter key never leaves the server environment**, and
**eligibility is decided by deterministic rules in both modes**, never by a
model.

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

A lease grants **one slot** the right to work on one task until one instant. It
carries a **fence token** that increases every time the task is leased, and the
control plane accepts a completion only from the current token.

The lease is keyed to the slot, not the supervisor: one supervisor runs up to
ten slots, and a supervisor-scoped lease would let slot 3 complete the task
slot 7 holds.

This is the single most important rule in the system. A worker that stalls — a
GC pause, a suspended laptop, a hung network call — **cannot notice its own
lease expiring, because it is not running**. It wakes believing it still holds
the lease and tries to submit. Expiry alone does not stop it; a fence token
does, because the decision is made by the control plane rather than by the
worker's opinion of its own state.

`canSubmit()` therefore requires a valid, current lease **and** the
`ready_to_submit` state, checked in that order, before the irreversible act —
and `canSlotSubmit()` adds the two checks that lease alone cannot make: the
supervisor must be `running` and the slot must be `working`. A slot can hold a
perfect lease while paused on a challenge, shutting down, or freshly restarted
into a context that never saw the form.

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

`lib/agent/safety.ts` is pure and exhaustively tested. Twenty-two stop reasons,
and **no rule may fail open**: every hazard stops on `yes` *and* on `unknown`,
every capability must be positively confirmed. Missing information stops.

Five were added in Milestone 2A so the control plane can name what a worker
will actually meet: `employer_authentication_required`,
`claude_authentication_required` (assisted mode only),
`sensitive_information_requested`, `unknown_page`, `unsupported_site`.

A login wall, an unrecognised page and an unsupported site are the three things
most easily mistaken for an ordinary application form — the page renders, there
are inputs, there is a submit button. Each has its own name so the reason a
candidate sees is the true one and the fix is actionable.

The worker reports observations (`WORKER_PAUSE_REASONS`); the control plane
decides (`SAFETY_STOP_REASONS`). `PAUSE_REASON_TO_SAFETY` is the total map
between them. **No pause reason means "work around it"**: no challenge solving,
no MFA interception, no anti-bot evasion, no automation fingerprint masking.

This is why the contracts use tri-states rather than booleans. A boolean forces
the page parser to invent an answer, and by the time it reaches the evaluator
the invention is invisible. See `docs/AGENT-SAFETY-POLICY.md`.

## 8. A known limit of this layer: DNS rebinding

`validateJobUrl()` rejects literal private addresses, but **a hostname is not
an address**. `evil.example.com` may resolve to `127.0.0.1`, and validation
here happens before DNS. It cannot be defended from this layer.

**It is defended at fetch time, and that code already exists.**
`lib/jobs/fetcher.ts` resolves the hostname and refuses if **any** resolved
address is non-public — every address, not just the first, because a host that
resolves to both a public and a private address would otherwise pass — and
re-checks per redirect hop with `redirect: 'manual'`.

An earlier version of this document described the fetcher as unbuilt and
recorded resolve-then-validate as a future requirement. That was wrong: the
requirement was already met. Corrected in Milestone 2A.

`lib/agent/job-url.ts` and `lib/jobs/url.ts` currently overlap and canonicalise
differently — see §10.

## 9. Why high volume is not enabled

The target is 500–1,000 applications a day. This milestone deliberately builds
none of it, because volume multiplies the cost of every unfixed boundary. At
one application an hour a wrong answer is an embarrassment; at a thousand a day
it is a thousand wrong answers sent in someone's name, to employers they may
later want to work for.

The order is: contracts, then safety, then a single supervised slot, then
concurrency, then volume — and each step is reviewed before the next. Ten slots
per supervisor is the ceiling the design targets, and `SlotRegistration`
already bounds `slot_index` to 1–10. **None run.** See
`docs/WORKER-PROTOCOL.md`.

KIASA does not claim it can apply to every website, and the design assumes some
applications will always stop for a person. No supported-site adapter exists
yet, so no site is supported yet.

## 10. Resolved in Milestone 2B: one normalizer, one state machine

`lib/jobs/` on `main` is an existing, tested job-intake layer — `submitJob`,
`fetchJob`, `extractJob`, four tables, and the SSRF-safe fetcher in §8. Nothing
currently calls it from a route.

**The URL divergence is fixed.** `lib/agent/job-url.ts` had its own
canonicaliser and its own tracking-parameter list; both are **deleted**, not
moved. It now decides only WHETHER a destination is allowed — HTTPS, public,
port 443, no credentials — and delegates WHAT THE URL IS to
`canonicaliseUrl()` in `lib/jobs/url.ts`, which is the one the database's
`md5(canonical_url)` uniqueness constraint is built on.

Both questions still need answering, and they are different questions:
`lib/jobs/url.ts` answers "which posting is this" and accepts plenty the agent
layer must refuse. `npm run test:dedupe` asserts every equivalence through
**both** entry points — a test that checked only one is how the divergence
survived two milestones.

**The state machines are now reconciled too.** There are still three, because
each answers a different question about a different row — a job (has it been
fetched?), a task (how far has this work got?), an application (what happened
with the employer?). What was missing was a stated relationship, and
`lib/agent/state-translation.ts` supplies it: total over every agent state,
returning `null` for "no corresponding row yet" rather than a nearest guess.
Nothing maps to `confirmed` — an employer confirms an application; the system
does not confirm its own work.

`automation_tasks.status` in migration 22 mirrors `lib/agent/state-machine.ts`,
and `npm run test:state-parity` parses the SQL and asserts the two are
identical in both directions. That is one state machine expressed twice, with a
test welding them together — not a second one.
