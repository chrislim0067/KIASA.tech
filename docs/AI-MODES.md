# The two AI modes

A candidate chooses one. Both are recorded in `AiModeConfig`, and
`lib/agent/ai-mode.ts` holds the complete routing table for each — pure, with
no network and no key, so "where does this reasoning happen" is a table that
can be read and tested rather than a decision made separately at each call
site.

`AutomationMode` has **exactly two members**, and a test asserts that.

---

## 1. `openrouter_only`

OpenRouter is the backend AI provider. It serves:

| Capability | Notes |
|---|---|
| `resume_extraction` | PDF text is extracted **locally** (`unpdf`); only bounded text is sent |
| `resume_analysis` | over already-extracted text |
| `job_scanning`, `job_analysis` | structures what a posting says; decides nothing |
| `job_scoring` | a ranking signal, never the sole gate |
| `resume_tailoring` | the candidate reviews the result before it is used |
| `application_answer_generation` | drafts only — an unverified answer still stops |
| `candidate_profile_drafting` | proposals the candidate confirms field by field |
| `structured_task_creation` | produces steps from the closed action vocabulary, revalidated on return |

`eligibility_evaluation` is the exception in this mode too: deterministic rules,
never a model. See §3.

**The credential stays server-side.** `OPENROUTER_API_KEY` is read from the
server environment by `lib/ai/config.ts`. It is never:

- sent to the browser,
- sent to a local supervisor or slot,
- written into a database row,
- included in a heartbeat, an event or a log line,
- stored per candidate — `AiModeConfig` has no credential field, and a test
  asserts its key set.

`provider_usage` records metadata only. See `docs/PROVIDER-CONTRACTS.md` §7 for
the three mechanisms that enforce that.

## 2. `claude_max_assisted`

**The work is split.** OpenRouter does the mechanical reading; the candidate's
own Claude does the writing.

| Capability | Destination |
|---|---|
| `resume_extraction`, `resume_analysis` | OpenRouter |
| `job_scanning`, `job_analysis`, `job_scoring` | OpenRouter |
| `structured_task_creation` | OpenRouter |
| `eligibility_evaluation` | deterministic rules |
| **`resume_tailoring`** | **the candidate's own Claude** |
| **`application_answer_generation`** | **the candidate's own Claude** |
| **`candidate_profile_drafting`** | **the candidate's own Claude** |

### Why that split, and not the other one

The three on the right produce **the candidate's own words, submitted to an
employer under their name**. Doing that on their own subscription, on their own
machine, matches who the output belongs to. Parsing a job posting has no such
character and belongs on the server, where it can be cached, batched and paid
for centrally.

### A change from Milestone 2A, recorded rather than drifted

2A routed *every* model capability in assisted mode to the paste console and
asserted the mode used no server-held credential at all. That assertion is now
false by design, and the test that made it has been **replaced rather than
deleted** — silently dropping it would have left the strongest claim in the
file untested. What still holds, and is still asserted: **the backend never
holds a Claude credential.**

### How the local capability is reached

Two destinations, deliberately kept apart:

- `local_claude` — unattended, through the official local interface. See
  `docs/LOCAL-CLAUDE.md`.
- `candidate_claude_max_paste` — a person opens Claude, runs the prompt and
  pastes the result back. `attended: true`, and the task is marked
  `candidate_assisted`.

Routing depends on a **probe**, not on configuration: `routingTable()` takes a
`LocalClaudeAvailability`, and only `status: 'supported'` — which requires an
adapter, a version and a model reported by the interface itself — sends work to
`local_claude`. An omitted probe defaults to not-supported, and a test asserts
that. "The candidate ticked a box" and "the interface answered" are different
facts.

### What the backend still never does

Hold a Claude credential, drive a Claude session, or see one. The local
adapter spawns an official interface on the candidate's machine; that interface
owns its own login. Specifically forbidden, and asserted by test against the
`lib/agent` and `lib/local-claude` sources: `@anthropic-ai/sdk`,
`ANTHROPIC_API_KEY`, direct Anthropic API calls, private or undocumented Claude
endpoints, cookies, browser storage, session-token extraction.

**This is a consent and licensing boundary before it is a technical one.** A
Claude Max subscription is a person's own account, which is why `consented` is
checked before the interface is executed at all, and why the account-terms
question in §5 is recorded as open rather than assumed answered.

### What each route costs, honestly

`local_claude` is unattended and fast — measured at roughly five seconds for
one drafted answer. `candidate_claude_max_paste` is not unattended at any
speed: a person opens Claude, runs the prompt and pastes the result for every
task. It does not apply to a thousand jobs a day, and nothing in the product
should imply it does. Tasks completed that way carry `candidate_assisted:
true` so a completion rate cannot quietly claim otherwise.

## 3. Eligibility is never decided by a model

In **both** modes, `eligibility_evaluation` routes to `deterministic_rules`.

This diverges from a literal reading of the Milestone 2A brief, which lists
eligibility among the OpenRouter responsibilities. It is recorded here rather
than changed silently.

`EligibilityDecision.evaluator` is a `z.literal('deterministic_rules')` — the
contract cannot express a model having decided. Eligibility gates whether an
application is sent to a real employer in a real person's name, and it must be
reproducible, explainable afterwards, and identical on two runs of the same
inputs. A model is none of those.

What a model **may** do is produce the structured facts the rules then evaluate.
That is `job_analysis`, and it routes to a provider. The verdict does not.

## 4. Which mode needs a Claude session

Only `claude_max_assisted`. This is why `claude_authentication_required` is a
legitimate pause reason in one mode and meaningless in the other: raising it
under `openrouter_only` would ask a candidate to fix something with no bearing
on the work.

The contract enforces it. `SlotAuthenticationState.claude_max_session` must be
`not_applicable` in `openrouter_only` and a real value
(`authenticated` / `not_authenticated` / `unknown`) in `claude_max_assisted`.
Both directions are rejected if violated.

`requiredPauseReasons()` fails closed in the same shape as the safety
evaluator: a session counts as established only when it says `authenticated`.
`unknown` pauses.

## 5. The local capability — now built

Milestone 2A recorded this as a closed extension point pending review.
Milestone 2B did the review, found an officially supported interface, and
built it. Full evidence, including exactly what was probed and what it
returned, is in `docs/LOCAL-CLAUDE.md`.

Three of the four requirements are met:

| Requirement | Status |
|---|---|
| Official, documented interface | met |
| Runs only on the candidate's machine | met |
| Server holds no Claude credential | met |
| **Account terms reviewed by the candidate** | **open** |

**The fourth is not a technical question**, was not answered by the probe
working, and belongs to the account holder. Its enforcement point is
`consented`, checked *before anything is executed* — running the interface to
find out whether it works would already be the use that was not consented to.

Permanently out of scope, whatever that review concludes, and each asserted by
test: browser-storage access, session-token extraction, credential replay,
private-endpoint calls, undocumented API calls, disguising automated traffic,
CAPTCHA bypass, MFA bypass. These are not implementation details of the
supported path — they are the alternatives it exists to avoid.

`AutomationMode` still has exactly two members, and a test asserts it.
