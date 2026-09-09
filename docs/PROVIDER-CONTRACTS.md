# AI provider contracts

What the code does, not what it should one day do. Every claim here is
implemented in `lib/ai/` and covered by `scripts/test-resume-provider.mjs`
(159 offline checks) and `scripts/test-provider-usage.mjs` (database).

---

## 1. The boundary

**OpenRouter is the only AI API this application may call.** One provider, one
credential, one adapter:

```
lib/ai/config.ts       which provider, which credential, which model
lib/ai/openrouter.ts   the only module that performs a provider request
lib/ai/json-schema.ts  makes a Zod schema acceptable to strict output mode
lib/ai/usage.ts        what a call may record about itself
```

There is deliberately **no multi-provider abstraction**. A second provider is a
second thing to secure, a second billing surface, and a second set of failure
modes that appear only when the first is already having a bad day. When one is
genuinely needed it earns its own review — see §9.

**Claude Max is not reachable from the backend and must never be.** It stays a
capability the user drives on their own machine under their own account. The
résumé paste console (`components/resume/ImportConsole.tsx`) is exactly that: a
link the user clicks and a box they paste into. No key, no endpoint, no session
extraction, no cookie reading. Direct Anthropic API use is intentionally
unsupported.

## 2. Credentials

| Variable | Required | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | — |
| `OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` |
| `OPENROUTER_RESUME_MODEL` | no | `google/gemini-2.5-flash` |

**Server-only, always.** The key is read in exactly one module, which begins
`import 'server-only'`, so a client component importing it is a build failure
rather than a published credential. A `NEXT_PUBLIC_` provider variable is
compiled into the JavaScript every visitor downloads and must never exist; a
test asserts none does.

Configuration is validated, not trusted:

* a missing or whitespace-only key → `missing_api_key`;
* a `base_url` that is not a URL → `invalid_base_url`;
* plain `http` to anything but loopback → `insecure_base_url` (loopback is
  allowed so a developer can point at a local mock);
* a model that is not `vendor/model` or `vendor/model:variant` →
  `invalid_model`.

Every accessor returns a discriminated result. Nothing throws, nothing falls
back to a default credential, and a misconfigured deployment produces one clear
message instead of a provider error three layers down.

## 3. Model configuration

`google/gemini-2.5-flash` is a **default, not a hardcoded choice**. Model
availability on OpenRouter changes faster than this repository does, so
`OPENROUTER_RESUME_MODEL` overrides it without a deploy. Whatever is chosen, the
reply is validated against this project's own Zod schema, so a model that
ignores the schema fails cleanly instead of writing a plausible, wrong profile.

The model id is resolved at call time. A constant captured at import time would
be a lie the moment the environment changed.

## 4. The request

`completeStructured()` sends one chat completion with `temperature: 0` —
transcription, not composition — and `response_format: json_schema` with
`strict: true`.

### The schema sent is sanitised, and this is load-bearing

Strict structured output accepts a small subset of JSON Schema, and rejects
requests containing anything else with a 400. `z.toJSONSchema()` faithfully
emits everything the schema expresses; measured on the real résumé schema that
is **43 occurrences of unsupported keywords** — 21 `maxLength`, 12 `pattern`,
4 `maxItems`, 4 `minLength`, `minimum`, `maximum` and `$schema`.

Sent unaltered, **every real résumé import would fail at the provider** while
the build, the types and the mocked tests all passed.

`lib/ai/json-schema.ts` strips them and keeps types, properties, `required`,
`enum`, `anyOf`, nesting, nullability and every `description`. This loses
nothing: the schema sent to a model is a **hint** about the shape to produce;
the **guarantee** is the Zod validation applied to whatever comes back, which
still enforces every length, pattern and bound in full. A model returning a
500-character job title still fails — on our side, where the rule lives.

## 5. Timeouts, retries, and failure classification

| Policy | Value | Why |
|---|---|---|
| Request timeout | 90 s | Below the route's `maxDuration = 300`, so a slow provider fails cleanly first |
| Attempts | 2 (one retry) | More multiplies the wait a candidate is watching |
| Backoff | 250 ms × attempt | Enough to clear a transient blip, not enough to be noticed |
| PDF parse timeout | 20 s | Separate budget, before any provider call |

Retried: `timeout`, `connection_failed`, `rate_limited` (429), `server_error`
(5xx). **Not retried:** `auth_failed` (401/403), `bad_request` (4xx),
`malformed_json`, `invalid_structure`, `no_content` — repeating them changes
nothing and costs money.

Provider failures map onto the vocabulary `resume_imports.failure_class`
already uses (`unreadable`, `too_large`, `model_error`, `timeout`), so an
import row and a usage row describe the same event in the same words. **No
migration was needed for any of it.**

## 6. Privacy boundary

**The original PDF never leaves this server.**

```
upload → private bucket → local text extraction → bounded text → OpenRouter
```

`lib/resume/pdf-text.ts` extracts the text layer with `unpdf` (2 MB, zero
dependencies, no native module, no worker thread). The provider therefore never
receives the file, the embedded photograph, or the producer metadata a PDF
quietly carries about the machine that made it.

Bounded before anything is sent: **10 MB** file · **30** pages · **80 000**
characters · **20 s** parse · a **200-character floor** below which the document
is treated as a scan.

A scanned or image-only résumé has no text layer, so it becomes **manual
review** with `manualReview: true`, not an empty prompt. An empty prompt is how
a model invents a career history.

Nothing in `lib/ai/` or `lib/resume/pdf-text.ts` logs anything at all — asserted
by test, not by intention.

### Prompt injection

Extracted text is untrusted input. It is delimited by explicit markers, the
system prompt states that the content is data rather than instruction, and —
the part that actually holds — **the Zod schema is the boundary**. A model that
obeys an injected instruction still cannot produce a value the database would
reject. Tested.

## 7. Usage metadata

Every call returns a `ProviderUsageRecord`, persisted to `public.provider_usage`
(migration 21).

Recorded: provider · model · operation · status · failure class and code ·
latency · attempts · prompt/completion/total tokens · cost · provider request id
· correlation id · timestamp.

**Never recorded: prompts, completions, résumé text, candidate facts, API keys,
authorization headers, or raw provider responses.**

That rule is enforced by construction, in three places rather than by good
intentions:

1. `ProviderUsageRecord` is a `.strict()` Zod object — a caller adding `prompt`
   gets a validation failure, not a row containing employment history.
2. The table has **no free-text column, no jsonb column, and no `detail`
   field**. There is nowhere to put one.
3. Migration 21 queries `information_schema` and **aborts** if a
   content-bearing or json column ever appears.

Tokens and cost are recorded **only when the provider reports them**. A locally
estimated cost is a guess that looks like an invoice, and someone will
eventually reconcile against it.

The table is append-only: `authenticated` holds `SELECT` on its own rows only,
`service_role` holds `SELECT` and `INSERT`, and a trigger refuses `UPDATE` and
`DELETE` for **every** role including the owner — a grant cannot bind a table
owner, and a cost record that can be edited is not a cost record. `user_id` is
`ON DELETE SET NULL`: deleting an account must not delete the accounting.

## 8. Failure vocabulary

| Code | Class | Retryable | Meaning |
|---|---|---|---|
| `not_configured` | `model_error` | no | No usable provider configuration |
| `timeout` | `timeout` | yes | Request exceeded its budget |
| `rate_limited` | `model_error` | yes | 429 |
| `auth_failed` | `model_error` | no | 401/403 — a deployment problem |
| `bad_request` | `model_error` | no | 4xx |
| `server_error` | `model_error` | yes | 5xx |
| `connection_failed` | `model_error` | yes | Network failure |
| `no_content` | `unreadable` | no | Empty completion |
| `malformed_json` | `unreadable` | no | Reply was not JSON |
| `invalid_structure` | `unreadable` | no | JSON, but not the schema |

## 9. Adding a model or an operation

**A model:** set `OPENROUTER_RESUME_MODEL`. It must support structured JSON
output; if it does not, calls fail as `invalid_structure` rather than producing
bad data. No code change.

**An operation:** add it to `PROVIDER_OPERATIONS` in `lib/ai/usage.ts` *and* to
the `provider_usage_operation_allowed` CHECK constraint. Both, deliberately —
the constraint is what stops an operation being recorded that nobody reviewed.

**A provider:** not without a review that answers, at minimum: where is the
second credential read, what is the disclosure surface, how is cost attributed,
and what happens when the two providers disagree. Until then, `provider` is a
one-value CHECK constraint in the database and a `z.literal` in the schema, and
both must change together.
