# Local Claude mode

**The integration gate passed, and the integration is real.** Milestone 2B
established that the candidate's machine exposes an officially supported,
documented interface that a local KIASA worker may use, built an adapter for
it, and ran a complete one-slot flow through it.

This document records what was tested, what is genuinely operational, what is
still manual, and the one question a working probe did not answer.

---

## 1. What was tested, and what it showed

All on the candidate's own Windows machine, 2026-09-09.

| Probe | Result |
|---|---|
| Interface present | `claude` CLI, version **2.1.267** |
| Non-interactive mode | `-p/--print` with `--output-format json` — documented, exists for exactly this |
| Auth state | `claude auth status` → `{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}` |
| Structured round-trip | Real request → validated JSON matching the contract, **5.3s** |
| Tool restriction | `--permission-prompts none` plus `--disallowedTools`: `permission_denials: []`, one turn |
| Full slice | Ordinary form filled from verified facts, answer drafted and validated, `uncertain: false` |

The candidate is signed in through the **official** `claude.ai` login flow on a
**Max** subscription. The interface owns its credential and manages its own
login.

## 2. Why this is a supported path and not a workaround

The adapter (`lib/local-claude/cli.ts`) spawns the official command-line
interface as a child process and reads its documented machine-readable output.
That is all it does.

**It never reads, stores, forwards or observes a credential.** No cookie
access, no browser storage, no session token, no undocumented endpoint, no
traffic interception, nothing pretending to be a person. If any of those were
required, the honest answer would have been that no supported path exists.

Two implementation choices carry most of the safety:

- **No shell.** Arguments go as an array, the prompt goes over stdin. The
  prompt contains employer-controlled text from a job posting, and a shell
  turns quotes, backticks and semicolons in that text into command execution on
  the candidate's own computer. `resolveClaudeExecutable()` exists precisely so
  that the Windows `.cmd` shim can be resolved to the real binary *without*
  reaching for `shell: true`.
- **Every tool denied.** This is a text-generation task with no business
  reading files, running commands or reaching the network — and the candidate's
  machine is where their documents live, not a sandbox. A job posting can
  contain any instruction it likes; `--permission-prompts none` plus an
  explicit deny list is what stops a prompt-injected instruction becoming an
  action.

## 3. Is local mode operational, or still manual?

**Operational.** The `resume_tailoring`, `application_answer_generation` and
`candidate_profile_drafting` capabilities run unattended against the
candidate's own Claude, on their own machine, and the result is schema-validated
before anything uses it. `npm run probe:local` runs the whole slice against the
real interface.

**The manual paste console remains, and is not a fallback in name only.** When
the probe reports `unsupported` or `manual_required`, those three capabilities
route to `candidate_claude_max_paste`, the task is marked
`candidate_assisted: true`, and it stops for the person. That flag exists so a
completion rate can never count hand-done work as unattended automation.

An adapter that could not say "I have nothing behind me" is how a mock becomes
a claim, which is why `unsupported` and `manual_required` are separate states
with their own tests.

## 4. The question that is still open

**Whether the candidate's subscription terms permit programmatic use at the
volume this product envisages.**

This is not a technical question. It was not answered by the probe working, and
it is not ours to answer — it belongs to the account holder. It is tracked as
`LOCAL_INTEGRATION_REQUIREMENTS.account_terms_reviewed_by_candidate: 'open'`,
and asserted still-open by test.

Its enforcement point is `consented`. `probeLocalClaude()` checks it **first,
before executing anything at all** — running the interface to find out whether
it works would already be the use that was not consented to. Without recorded
consent the probe returns `manual_required` and the paste console is used.

There is also a `daily_local_cap_reached` reason, so a cap can be applied
without touching the adapter. Note the shape of the risk: at one application an
hour this is a person using their own tool; at the product's stated target of
500–1,000 a day it is something a reasonable person would want to have checked
first.

| Requirement | Status |
|---|---|
| Official, documented interface | met |
| Runs only on the candidate's machine | met |
| Server holds no Claude credential | met |
| **Account terms reviewed by the candidate** | **open** |

## 5. Model selection

The candidate chooses. `resolveLocalModel()` accepts the documented aliases
(`haiku`, `sonnet`, `opus`, `fable`) or a full model name, and rejects anything
else — the value becomes a command-line argument to a local process, so
"reject what we do not recognise" is the only safe posture.

**There is deliberately no default model constant, and a test asserts its
absence.** Their subscription, their quota, their preference; picking the most
expensive model on someone's behalf is not ours to do. An unset or
unrecognised value reports `unsupported`, which is a configuration error worth
surfacing rather than papering over.

## 6. What the model is allowed to decide

Nothing that reaches an employer unchecked.

- Output is parsed, schema-validated, length-bounded and scanned against a
  credential denylist before any caller sees it.
- `uncertain: true` sends the answer to a human. A model asked to write an
  answer it lacks the facts for will write a plausible one; that flag is the
  clearest available signal it would be a guess, and a guess typed into a form
  is asserted as the candidate's own.
- `used_fact_keys` is checked against the facts actually supplied. An answer
  citing a key we never gave it did not come from the candidate's data, and is
  treated as a drafting failure rather than a lower-confidence answer.
- **Eligibility is never routed to a model, in any mode.** See
  `docs/AI-MODES.md` §3.

## 7. The boundary that did not move

A supported path being found is not a reason any of these became acceptable.
They are the alternatives it exists to avoid, they are listed in
`PERMANENTLY_OUT_OF_SCOPE`, and each is asserted by test:

browser storage access · session-token extraction · credential replay ·
private-endpoint calls · undocumented API calls · automation disguise ·
CAPTCHA bypass · MFA bypass

## 8. Running it

```
npm run test:local     offline logic, mocked transport — this is what CI runs
npm run demo:slice     the one-slot flow, deterministic transport
npm run probe:local    the same flow against the REAL local interface
```

`probe:local` is deliberately **not** in CI. A runner is not the candidate's
machine and has no subscription, so a green check there would say nothing true.
It spends a small amount of the candidate's own quota and is theirs to run.
