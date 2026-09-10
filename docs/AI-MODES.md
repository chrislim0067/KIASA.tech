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
| `job_analysis` | structures what a posting says; decides nothing |
| `job_scoring` | a ranking signal, never the sole gate |
| `resume_tailoring` | the candidate reviews the result before it is used |
| `application_answer_generation` | drafts only — an unverified answer still stops |
| `structured_task_creation` | produces steps from the closed action vocabulary, revalidated on return |

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

The **candidate** does the reasoning, in their own session, on their own
machine:

1. KIASA prepares a structured prompt.
2. The candidate runs it in Claude Max themselves.
3. The candidate pastes the result back into KIASA, which validates it against
   the same contract the provider path returns.

Every model capability routes to `candidate_claude_max_paste`. **No capability
in this mode reaches a backend provider at all** — `usesServerHeldCredential()`
returns `false`, and a test asserts no destination is `openrouter`.

The backend therefore holds no Claude credential, drives no Claude session, and
never sees one. Specifically forbidden, and asserted by test against the
`lib/agent` sources: `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`, direct Anthropic
API calls, private or undocumented Claude endpoints, cookies, browser storage,
session-token extraction.

**This is a consent and licensing boundary before it is a technical one.** A
Claude Max subscription is a person's own account. Automating it from a server
would be using their credential as though it were ours.

### What this mode costs, honestly

A mode where a person pastes each result is not an unattended mode. It does not
apply to a thousand jobs a day, and nothing in the product should imply it
does.

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

## 5. A future local capability — not implemented

`CLAUDE_MAX_LOCAL_CAPABILITY` in `lib/agent/ai-mode.ts` records a possible
future: the supervisor on the candidate's own machine driving their own Claude
session locally, instead of the candidate pasting each result by hand.

It is **closed, not merely unbuilt**. `status: 'not_implemented'`, and adding
code is not what unblocks it. Blocked on:

1. **Account terms.** Whether driving a personal subscription programmatically
   is permitted at all, and at what rate. This is the blocking question, and it
   is not technical.
2. **Explicit candidate consent**, per run, revocable.
3. **Local-only execution design.** It could only ever run on the candidate's
   machine, under their own already-open session, initiated by them, with the
   backend still holding and seeing nothing.
4. **Security review** of the local surface it would open.

Permanently out of scope whatever those answers turn out to be: browser-storage
access, session-token extraction, credential replay, private-endpoint calls,
disguising automated traffic as human. Those are not implementation details of
the extension point — they are why it is gated.

`AutomationMode` still has two members, and the tests assert both that fact and
each of the exclusions above, so this cannot become real by accident.
