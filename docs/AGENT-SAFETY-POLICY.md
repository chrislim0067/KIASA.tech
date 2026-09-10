# Agent safety policy

`lib/agent/safety.ts`. Pure: an object in, a decision out. No database, no
network, no clock of its own — which is what makes it exhaustively testable,
and being exhaustively testable is the only reason to trust it. This is the
component that decides whether a machine fills in a legal attestation on a real
person's behalf.

---

## No rule may fail open

Every rule is written so that **missing information stops**. Not "if we saw a
CAPTCHA, stop" but "unless we positively established there was no CAPTCHA,
stop".

```ts
const hazard    = (t: Tri) => t !== 'no';   // 'yes' stops, 'unknown' stops
const confirmed = (t: Tri) => t === 'yes';  // only an explicit yes proceeds
```

The distinction is not pedantry. The input comes from a page parser that will
sometimes fail to describe a page. A field it could not read becomes `unknown`,
and `unknown` must never be treated as `no`. This is why the contracts use
tri-states rather than booleans: a boolean forces the parser to invent an
answer, and by the time it reaches here the invention is invisible.

Both branches are tested for every hazard — `yes` stops, and `unknown` **also**
stops.

## The twenty-two stops

**Page hazards** (stop on `yes` *and* `unknown`)
`captcha` · `mfa_required` · `legal_attestation` ·
`protected_demographic_question` · `application_fee` ·
`external_contact_requested` · `anti_bot_warning` ·
`sensitive_information_requested`

`sensitive_information_requested` — a government id number, a bank account, a
date of birth, immigration documents. There is no configuration that turns this
into an answer a machine may type. The harm of being wrong is not a bad
application; it is a person's identity documents in a form they never saw.

**Capabilities** (must be positively confirmed)
`unsupported_ats_control` · `ambiguous_submission_state` · `unknown_page` ·
`unsupported_site`

**Sessions** (must be positively confirmed)
`employer_authentication_required` — **a login page is not a form.** It is the
single most dangerous page to misread: it renders inputs, labels and a submit
button, and a worker that types into it puts the candidate's details into a
login attempt. `unknown` stops.

`claude_authentication_required` — reachable **only** in `claude_max_assisted`
mode. Raising it under `openrouter_only` would ask a candidate to fix something
with no bearing on the work, so the rule is gated on the mode and the gate is
tested in both directions. See `docs/AI-MODES.md` §4.

**Candidate facts**
`unknown_candidate_fact` — a question we cannot answer from a **verified** fact
is not one to guess at; the answer would be asserted to an employer as the
candidate's own.
`compensation_not_configured` — pay is only ever answered from an explicit
configuration, never improvised.

**Prerequisites**
`missing_resume` · `profile_incomplete`

**Limits**
`kill_switch` · `daily_quota_exceeded` · `monthly_quota_exceeded` ·
`budget_exceeded`

## Quotas use `>=`

Reaching a quota means it is used up, not that one more fits. Tested at the
boundary in both directions: 50-of-50 stops, 49-of-50 proceeds; $25.00 of a $25
budget stops, $24.99 proceeds.

## A stop is not a failure

It is the system noticing that a human is required. It is never retried
automatically, and the state machine sends it to `manual_review` rather than
`failed` — so the failure rate keeps meaning what it says, and nobody
investigates a "failure" that was the safety policy working.

Every reason is collected, not just the first. A candidate looking at a stopped
application should see everything that stopped it, rather than discovering the
next problem after fixing the first.

## What proceeding requires

`SAFE_BASELINE` is exported so tests can start from "everything is fine" and
break one thing at a time — the only way to prove each rule fires on its own
rather than being masked by another.

Note what it takes: every hazard explicitly `'no'`, every capability explicitly
`'yes'`, quotas and budget genuinely under, résumé present, profile complete.
That is intentionally demanding. The default posture of this system is to stop.
