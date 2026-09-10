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
