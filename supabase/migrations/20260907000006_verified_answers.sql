-- The decision memory: answers the candidate has personally approved.
--
-- This is what stops the future agent inventing things. It looks a question up
-- by its normalized key; if there is no verified row, it must stop and ask
-- rather than generate an answer.
--
-- Protected categories (demographic/EEO, disability, veteran status, criminal
-- history, legal attestations) may NEVER be inferred, generated or
-- auto-answered. requires_human_approval encodes that rule in the database
-- itself so it holds even if application code is wrong or is bypassed.

create table public.verified_answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- Normalized identity of the question, e.g. 'years_of_python'. Lowercase
  -- snake_case is enforced so the same question cannot arrive under two keys.
  question_key text not null
    constraint verified_answers_question_key_format check (question_key ~ '^[a-z0-9_]{1,120}$'),

  -- The question as the site actually worded it, kept for audit.
  question_text     text,
  question_category text,

  answer_text       text,
  -- For reuse where a form needs a typed value rather than prose.
  answer_structured jsonb,

  answer_type text not null default 'text'
    constraint verified_answers_answer_type_allowed
    check (answer_type in ('text', 'boolean', 'number', 'date', 'single_choice', 'multi_choice')),

  source text not null
    constraint verified_answers_source_allowed
    check (source in ('user_entered', 'imported_from_resume', 'agent_drafted_user_approved')),

  is_verified boolean not null default false,
  verified_at timestamptz,
  is_locked   boolean not null default false,

  sensitivity text not null default 'normal'
    constraint verified_answers_sensitivity_allowed
    check (sensitivity in (
      'normal',
      'sensitive',
      'legal_attestation',
      'demographic_eeo',
      'disability',
      'veteran_status',
      'criminal_history',
      'requires_approval'
    )),

  -- The safety rule as data, not as code. True whenever the answer is
  -- unverified OR touches anything other than an ordinary question, so a
  -- consumer can filter on it and can never "forget" the policy.
  requires_human_approval boolean
    generated always as (is_verified = false or sensitivity <> 'normal') stored,

  times_used   integer not null default 0
    constraint verified_answers_times_used_nonneg check (times_used >= 0),
  last_used_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint verified_answers_one_per_key unique (user_id, question_key),

  -- Consistency: a verified answer records when it was verified...
  constraint verified_answers_verified_has_timestamp
    check (is_verified = false or verified_at is not null),
  -- ...and an unverified one cannot pretend it was.
  constraint verified_answers_unverified_has_no_timestamp
    check (is_verified = true or verified_at is null),
  -- Locking protects an answer from automatic rewriting, which is only
  -- meaningful once a human has confirmed it.
  constraint verified_answers_locked_requires_verified
    check (is_locked = false or is_verified = true),
  -- An answer has to say something.
  constraint verified_answers_has_content
    check (answer_text is not null or answer_structured is not null)
);

comment on table public.verified_answers is
  'User-approved answers. No verified row means the agent must ask, not guess.';
comment on column public.verified_answers.requires_human_approval is
  'Generated. True if unverified or sensitivity <> normal. Protected categories '
  '(demographic_eeo, disability, veteran_status, criminal_history, '
  'legal_attestation) must never be auto-answered.';

create index verified_answers_user_id_idx on public.verified_answers (user_id);

-- The agent's hot path: "do I have an approved, ordinary answer for this?"
create index verified_answers_ready_idx
  on public.verified_answers (user_id, question_key)
  where requires_human_approval = false;

create trigger verified_answers_set_updated_at
  before update on public.verified_answers
  for each row execute function public.set_updated_at();
