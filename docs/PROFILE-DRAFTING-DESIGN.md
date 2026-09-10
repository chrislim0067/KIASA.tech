# Candidate profile drafting — storage design, for decision

Milestone 2E says: *"Do not add a new table if the existing task result can
safely hold a bounded validated draft. If a new draft table is genuinely
required, stop and document the design before implementing it."*

It is required. This is that document. Nothing has been implemented.

## What already exists, and must be reused rather than rebuilt

The survey found far more standing than expected. None of the following needs
inventing, and this milestone should not add a second version of any of it:

| Need | Already exists |
|---|---|
| Provider routing for this exact capability | `lib/agent/ai-mode.ts` — `candidate_profile_drafting` is already in `AI_CAPABILITIES` **and** `LOCAL_CLAUDE_CAPABILITIES`; `routingTable()` already sends it to local Claude in `claude_max_assisted` and to OpenRouter in `openrouter_only` |
| OpenRouter gateway | `lib/ai/openrouter.ts`; `candidate_profile_drafting` is already in `PROVIDER_OPERATIONS` |
| Local Claude CLI adapter | `lib/local-claude/cli.ts`, `transport.ts` — consent gate, no shell, argv/stdin only |
| Résumé extraction | `lib/resume/extract.ts` + `ResumeExtraction` in `lib/resume/schema.ts` |
| Résumé fact storage | `resume_imports.extracted jsonb`, lifecycle `uploaded → parsing → parsed → confirmed` |
| Candidate review and confirmation | `lib/resume/actions.ts` + `applyExtraction()` in `lib/resume/apply.ts` — runs under **the candidate's own session and RLS**, adds rather than overwrites, dedupes, and returns display-safe errors |
| Provenance and timestamps assigned by the database | migration 9, `timestamp_and_provenance_guards` |
| Worker claim / renew / report, leases, fencing, events | migrations 22, 26, 27, 28 |

So Phase 5's confirmation flow is essentially built: `parsed` already means *"a
draft is waiting for the person to review"*, and `confirmed` already means
*"the person accepted it; the profile tables were written"*.

## Why the existing task table cannot hold this

`automation_tasks` cannot carry a `candidate_profile_drafting` task, for three
independent reasons:

1. **`job_id uuid not null references public.jobs`.** A profile-drafting task
   has no job. Satisfying this would mean inventing a placeholder job row,
   which is a lie in a table the candidate can read.
2. **There is no payload column and no result column.** The table has
   `status`, `mode`, `idempotency_key`, `correlation_id`, `attempt`,
   `max_attempts`, `fence_token`, `outcome` — and nowhere to put the bounded
   input the worker needs, or the validated draft it returns.
3. **`worker_claim_task` has no notion of task kind.** It claims the oldest
   `queued` task for the candidate and returns ids only. A profile task sitting
   in that table would be handed to a worker expecting a job application, which
   would then have nothing it could do with it.

A fourth point is about meaning rather than mechanism: the transition table in
migration 22 is a *job application* state machine. `snapshot_stored`,
`normalized`, `scored`, `ready_to_submit` and `submitted` have no reading for a
profile draft. Half of that machine would become dead states for this kind, and
`submitted` — the status this project has spent three milestones making
unreachable — would become a status a profile task nominally *could* enter.

## Three designs

### A — extend `automation_tasks`

Make `job_id` nullable, add `kind`, add bounded `input`/`result` jsonb, and add
a kind filter to `worker_claim_task`.

*For:* one state machine, one lease and fence model, one set of boundary
functions, no new RLS surface.

*Against:* relaxes a `NOT NULL` on a merged table; changes the signature of a
merged, generated-typed boundary function (so every worker in the field must
be updated in lockstep); and puts a profile draft inside the job-application
state machine, where `submitted` becomes nominally reachable for it. That last
point is the one I would not want to argue for later.

### B — a dedicated `profile_draft_tasks` table with its own lifecycle

Own statuses (`queued → leased → drafted → confirmed | rejected | expired`),
candidate ownership, forced RLS, bounded jsonb with size CHECKs, and its own
narrow definer functions mirroring migrations 26–28.

*For:* the job-application machine is untouched, and `submitted` stays
unreachable **by construction** — a profile task cannot enter that machine at
all. Payload bounds are stated where the payload lives.

*Against:* `task_leases.task_id references public.automation_tasks(id)`, so
leases cannot be reused. Leasing, fencing and expiry would have to be modelled
a second time — which is exactly the duplication the milestone warns against,
and the part of this system that took the longest to get right.

### C — task in `automation_tasks`, draft in its own table  ← recommended

Extend `automation_tasks` minimally (nullable `job_id`, plus `kind` defaulting
to the job-application meaning), and put the bounded input and validated result
in a separate `profile_drafts` table keyed to the task.

*For:* leases, fencing, events, and all five boundary functions are reused
**unchanged** — no merged function signature moves. The draft payload gets its
own home with its own bounded CHECKs, its own RLS, and its own retention, so a
résumé-shaped blob never widens the task table. `worker_claim_task` still needs
a kind filter, but as an added *predicate*, not a changed contract, if the
worker's capability is read from its slot rather than passed in.

*Against:* still relaxes `job_id`'s `NOT NULL`, and adds one table.

## What C would need, concretely

- Migration 29:
  - `alter table public.automation_tasks alter column job_id drop not null`
    plus a CHECK tying `kind` to whether `job_id` is present, so a job task
    still cannot exist without a job.
  - `kind text not null default 'job_application'` with a bounded CHECK.
  - `create table public.profile_drafts` — `user_id` (FK, cascade), `task_id`,
    `resume_import_id`, `profile_version`, `input jsonb`, `result jsonb`,
    both with `jsonb_typeof = 'object'` and a length bound, `status`,
    `created_at`, `reviewed_at`; RLS enabled **and forced**; candidate SELECT
    plus a narrow UPDATE for review columns only; **no service-role grant**.
  - `worker_claim_task` gains `and kind = <the slot's capability>` as a
    predicate. Signature unchanged.
  - Self-verification in the migration's own style.
- Generated types regenerate (one CI round trip, as usual).
- The worker's `candidate_profile_drafting` handler, using the existing local
  Claude adapter and consent gate.
- Confirmation reuses `applyExtraction()`, which already writes under the
  candidate's own session and already refuses to overwrite.

## The decision I need

Which design, and specifically: **is relaxing `automation_tasks.job_id` to
nullable acceptable?** Every option except B requires it, and B pays for
avoiding it by duplicating the lease and fence machinery — the single most
security-sensitive part of the worker protocol.

I have implemented nothing pending that answer.

---

# FINAL DESIGN — Option C, approved

Approved with the invariants below. This section supersedes the comparison
above; A and B are kept as the record of why C was chosen.

## 1. Task-model extension (migration 29)

`automation_tasks` gains a `kind`, and `job_id` becomes conditionally nullable.

```sql
kind text not null default 'job_application'
  check (kind in ('job_application', 'candidate_profile_drafting'))

-- A job application still cannot exist without a job, and a profile draft
-- cannot carry one. The invariant is TIGHTER than before, not looser:
-- previously nothing stopped a task pointing at a job it had no use for.
constraint automation_tasks_job_iff_job_application
  check ((kind = 'job_application') = (job_id is not null))
```

`default 'job_application'` means every existing row and every existing insert
keeps its exact meaning. **No existing job-task behaviour changes.**

### Profile tasks can never reach a submission state

Two independent layers, because this is the invariant the last three
milestones were for:

1. **A CHECK**, so it holds for every writer including a superuser:
   ```sql
   constraint automation_tasks_profile_never_submits
     check (kind <> 'candidate_profile_drafting'
            or status not in ('ready_to_submit', 'submitted'))
   ```
2. **The transition guard**, extended to refuse the move explicitly, so the
   error names the reason rather than surfacing as a constraint violation.

A profile task's reachable states are therefore:

```
queued ──claim──▶ leased ──▶ processing ──▶ manual_review ──▶ (candidate)
   ▲                                    └──▶ failed
   └──────────── release ───────────────────┘
```

`ready_to_submit` and `submitted` are not merely unused — they are refused.

## 2. `profile_drafts` (migration 29)

| Column | Purpose |
|---|---|
| `id uuid pk` | |
| `user_id uuid not null → auth.users on delete cascade` | candidate ownership, server-derived |
| `task_id uuid not null → automation_tasks on delete cascade` | linkage to the lease/fence machinery |
| `resume_import_id uuid → resume_imports on delete set null` | which facts it was drafted from |
| `profile_version timestamptz not null` | `profiles.updated_at` at creation — the optimistic-concurrency guard |
| `status text not null default 'pending'` | `pending → drafted → confirmed \| rejected \| expired` |
| `input jsonb not null` | bounded facts + profile snapshot the worker receives |
| `result jsonb` | the validated draft; null until drafted |
| `created_at`, `updated_at`, `reviewed_at`, `expires_at` | lifecycle and cleanup |

Bounds and guards:

- `jsonb_typeof(input) = 'object'`, `length(input::text) <= 16000`
- `jsonb_typeof(result) = 'object'`, `length(result::text) <= 16000`
- `(status = 'drafted' or status = 'confirmed') = (result is not null)` — a
  drafted row must have a draft, and a pending one must not
- `(status in ('confirmed','rejected')) = (reviewed_at is not null)`
- `expires_at` defaults to `created_at + 7 days`; one live draft per task via a
  partial unique index on `task_id where status in ('pending','drafted')`
- RLS **enabled and forced**

**What it must never hold:** raw prompts, raw model responses, API keys,
cookies, or unbounded résumé text. `input` carries validated facts already
stored in `resume_imports.extracted` plus a snapshot of the profile fields the
draft may touch — nothing else.

## 3. Privilege matrix

| Actor | `automation_tasks` | `profile_drafts` | Functions |
|---|---|---|---|
| `authenticated` (candidate) | existing SELECT/INSERT/UPDATE/DELETE under RLS | SELECT own; INSERT own; UPDATE **`status`, `reviewed_at` only** | `worker_revoke_supervisor()` |
| `service_role` | **none** (unchanged) | **none** | the five worker operations |
| `anon` / PUBLIC | none | none | none |
| worker (via definer) | through boundary functions only | `result` written by one narrow function | — |

**No new service-role table grant.** The worker reaches `profile_drafts`
through `worker_submit_profile_draft` and nothing else.

### One new definer function

```
worker_submit_profile_draft(p_credential_id uuid, p_token_hash text,
                            p_fence_token bigint, p_draft jsonb)
  → (ok boolean, reason text)
```

`security definer`, `search_path = ''`, no dynamic SQL, granted to
`service_role` alone. In one transaction it: resolves the credential, takes the
lease's row lock, checks the fence by equality, requires the task's `kind` to
be `candidate_profile_drafting`, bounds the draft, writes `result`, sets the
draft `drafted`, moves the task to `manual_review`, releases the lease, and
records `task_completed` + `lease_released`. It cannot write `submitted`,
cannot choose a candidate, and cannot set provenance.

### One changed return, and why

`worker_claim_task` gains **`claimed_kind text`** in its RETURN. Arguments are
unchanged, so no caller signature moves. This is the "genuine type-safe
requirement" the invariants allow: a worker that cannot tell which kind of task
it claimed cannot act on it, and the alternative — a kind *argument* — would
let the caller choose, which is exactly what this boundary refuses everywhere
else.

## 4. Data flow

```
candidate uploads résumé
        │
        ▼
 lib/resume/extract.ts ──▶ OpenRouter (resume_extraction)   [EXISTING]
        │                   strict structured output
        ▼
 resume_imports.extracted  status: parsed                    [EXISTING]
        │
        │  candidate selects claude_max_assisted + gives local consent
        ▼
 POST /api/profile/draft            (candidate session, RLS)
        ├─ automation_tasks  kind=candidate_profile_drafting, job_id NULL,
        │                    status=queued, idempotency_key=import+version
        └─ profile_drafts    status=pending, input={facts, snapshot, version}
        │
        ▼
 worker_claim_task  ──▶ claimed_kind='candidate_profile_drafting'
        │                lease + fence, exactly as for a job task
        ▼
 worker/kiasa-worker.mjs
        └─ lib/local-claude/cli.ts   consent checked immediately before spawn
                argv/stdin only · no shell · no tools · no network
                résumé text fenced as DATA, never as instructions
        │
        ▼
 ProfileDraft schema validation  (strict, extra fields rejected)
        │
        ├─ invalid / timeout / no consent / no CLI
        │       └─▶ worker_report_task(failed, bounded reason)   NO FALLBACK
        ▼
 worker_submit_profile_draft ──▶ profile_drafts.result, task → manual_review
        │
        ▼
 candidate reviews field by field, edits, accepts or rejects
        │
        ▼
 POST /api/profile/draft/confirm    (candidate session)
        ├─ re-check ownership, re-check profile_version, re-validate every field
        └─ applyExtraction()  ──▶ profile tables   [EXISTING: adds, never overwrites]
                                   triggers assign provenance + timestamps
```

**No arrow from local Claude to OpenRouter exists.** A local failure is a
failure.

---

# 5. The candidate-facing screens (Milestone 2E.1)

Milestone 2E built the contract, the schema, the routes and the worker path.
This section describes the screens that make it reachable by a person rather
than by an HTTP client, and — more usefully — the decisions embedded in them.

## Where they live

| Path | What it is |
| --- | --- |
| `/profile/resume` | Upload a PDF, or see the manual route. Unchanged, plus a link onward. |
| `/profile/resume/[importId]` | Review the extracted facts. Unchanged. |
| `/profile/draft` | **New.** Ask for a draft, then review it field by field. |

The rules those screens apply are not in the screens. They are in
`lib/resume/upload.ts` and `lib/profile/review.ts`, both free of `server-only`,
both pure, and both exercised directly by `npm run test:draft:ui`. A rule that
can only be tested by rendering a component tends not to be tested.

## Two gates, and why they are different

`/profile/resume` is gated on `isResumeParsingConfigured() && isAdminConfigured()`
— that is, on `OPENROUTER_API_KEY` and `SUPABASE_SECRET_KEY`. Reading a PDF is a
hosted model call, and it stays behind the key that pays for it.

`/profile/draft` is **not** gated on `OPENROUTER_API_KEY`, deliberately.
Drafting runs on the candidate's own machine through `lib/local-claude/`, and
`lib/profile/drafting.ts` contains no provider path at all. Gating a local
feature on a remote provider's key would tie the two together for no reason and
would imply a fallback that must not exist. What it is gated on is having
résumé facts to draft from — which can arrive either from the PDF upload (needs
the key) or from the paste console on `/profile` (needs only
`SUPABASE_SECRET_KEY`). So the drafting flow is fully usable in an environment
with no OpenRouter key at all, which is what makes it testable in preview.

A test asserts both halves of this, including that the page imports nothing
provider-shaped.

## What starts ticked, and what never does

`components/resume/ReviewForm.tsx` arrives with everything ticked, and is right
to: those are facts read off the candidate's own document, being added to an
empty list. The draft review is different in two ways — the values are a model's
proposals rather than an extraction, and several of them would REPLACE something
the candidate has already written.

So `startsTicked()` ticks a box only when accepting it cannot lose anything:

* the résumé answered the field, **and**
* the field is empty on the profile today, **and**
* it is not identity — `EXPLICIT_CONFIRMATION_FIELDS`: legal names, contact
  email, phone, country — **and**
* the proposal carries no warning of its own, because a warning is the model
  saying it is unsure, which is exactly a thing to read.

Everything else starts unticked and has to be chosen. There is no "accept all"
control that can reach an identity field.

## What the review screen may send

`buildConfirmBody()` guarantees two things the route would otherwise have to
trust a browser about:

* **A rejection accepts nothing.** `ConfirmRequest` refuses a rejection carrying
  accepted fields, so any other shape could only ever be refused.
* **An untouched proposal is sent as a bare field name.** The server then writes
  the value *it* validated against the stored facts, rather than a value a
  browser echoed back at it. `edited_value` appears only when a person actually
  typed something different — and from that point it is treated as their own
  words, needing no fact to support it, but still bounded by the column.

## Worker states, all of them named

`describeWorker()` maps the status view onto a sentence and a yes/no. Every
branch fails closed: `ready` is true only for `online` + `ready`/`working`.
`not_paired`, `stale`, `revoked`, `expired`, `paused`, `stopping`, `stopped`,
`crashed`, `initializing`, a readiness never reported, a readiness outside the
vocabulary, and a status object the outbound schema refused all leave the button
unavailable with an explanation. `claude_authentication_required` is spelled out
in words, because it is the one a candidate can actually fix.

No branch reaches for another provider. A candidate whose laptop is asleep is
told their laptop is asleep.

## What a refusal is allowed to say

Both routes answer with a short code from a closed list. `refusalText()` looks
the code up in a map of **our** sentences and falls through to a neutral line;
the code itself, the HTTP status, and every other field in the body — a SQL
error, a prompt, a cookie — are never rendered. A test feeds it a body carrying
all four and asserts none of them reaches the screen.

## A bug this milestone found and fixed

`WorkerStatusView` was `.strict()` and named six fields. The status route had
been building nine — `slot_readiness`, `pause_reason` and `stop_reason` were
added for the pairing panel — so `safeParse` failed and **`GET
/api/worker/status` returned `invalid_view` (500) on every call.**

The fix widens the schema to name the three, each as the same closed enum the
database holds as a CHECK constraint; removing `.strict()` would have been the
bug. The reading moved to `lib/worker/status.ts` so the drafting page can call
it directly instead of fetching its own API, and section 12 of
`test-worker-pairing.mjs` now compares the schema's keys to that module's own
object literal — the check that was missing, since the old test built its own
six-key fixture and could not notice the disagreement.

`npm run test:pairing` and `npm run test:endpoints` also **were not running in
CI**. They are now. A suite that does not run is a suite that does not hold.
