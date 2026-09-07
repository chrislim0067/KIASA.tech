-- Job intake: jobs, immutable fetch snapshots, extracted facts, event log.
--
-- Four new user-owned tables. RLS, policies, grants and the immutability and
-- transition triggers arrive in migration 13, mirroring how migrations 2-6
-- declare tables and migration 7 secures them.
--
-- Ownership is keyed directly to auth.users on every table, including the three
-- that also carry job_id. Chaining ownership through jobs would make each RLS
-- predicate a join, which is both slower and easier to get wrong; carrying
-- user_id everywhere keeps every policy the same one-line comparison used by
-- the existing eleven tables. The foreign key to jobs is still present, so a
-- deleted job takes its snapshots, facts and events with it.
--
-- Nothing here stores credentials, cookies or authentication material for a
-- third-party site. A snapshot is the public response body and nothing else.

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- The URL exactly as submitted, kept byte-for-byte so the user can always see
  -- what they actually gave us, and the canonical form used for deduplication.
  submitted_url text not null
    constraint jobs_submitted_url_scheme check (submitted_url ~ '^https?://'),
  canonical_url text not null
    constraint jobs_canonical_url_scheme check (canonical_url ~ '^https?://'),

  -- Dedupe key. GENERATED, so a client cannot submit a fingerprint that
  -- disagrees with the URL it claims to describe.
  --
  -- md5 is used as a fixed-width dedupe key, NOT as a security primitive: it
  -- keeps the unique index small and independent of URL length, and a collision
  -- would only ever affect one user's own two URLs. Nothing authenticates or
  -- authorises on this value.
  url_fingerprint text generated always as (md5(canonical_url)) stored,

  -- Where the link came from. A constrained vocabulary rather than free text so
  -- a scheduler can filter on it without parsing prose.
  source text not null
    constraint jobs_source_allowed
    check (source in ('user_link', 'user_paste', 'agent_discovered', 'imported')),

  -- Derived deterministically from the URL when the host is recognised, NULL
  -- otherwise. Never guessed: an unrecognised host leaves both columns NULL.
  ats_vendor text
    constraint jobs_ats_vendor_allowed
    check (ats_vendor is null or ats_vendor in (
      'greenhouse', 'lever', 'workday', 'ashby', 'smartrecruiters',
      'workable', 'recruitee', 'personio', 'teamtailor', 'bamboohr',
      'jobvite', 'icims', 'taleo', 'successfactors', 'linkedin', 'indeed'
    )),
  external_job_id text,

  -- Pipeline state. The legal transitions between these values are enforced by
  -- a trigger in migration 13; this CHECK only constrains the vocabulary.
  status text not null default 'received'
    constraint jobs_status_allowed
    check (status in (
      'received', 'fetching', 'fetched', 'fetch_failed',
      'extracting', 'extracted', 'extraction_incomplete', 'archived'
    )),

  -- Machine-readable reason for the current status. Same vocabulary the fetcher
  -- and extractor emit, so a scheduler branches on a value rather than text.
  status_reason text
    constraint jobs_status_reason_allowed
    check (status_reason is null or status_reason in (
      'gone', 'access_blocked', 'login_required', 'rate_limited',
      'render_required', 'too_large', 'unsupported_content_type',
      'timeout', 'transport', 'refused_by_policy',
      'no_structured_data', 'malformed_structured_data', 'archived_by_user'
    )),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One job per user per canonical URL. Submitting the same posting twice
  -- returns the existing row instead of creating a second one.
  constraint jobs_one_per_canonical_url unique (user_id, url_fingerprint),

  constraint jobs_text_lengths check (
    length(submitted_url) <= 2048
    and length(canonical_url) <= 2048
    and coalesce(length(external_job_id), 0) <= 200
  ),
  -- An external id that is present must actually say something.
  constraint jobs_external_id_not_blank
    check (external_job_id is null or not public.is_blank_or_invisible(external_job_id))
);

create index jobs_user_id_idx on public.jobs (user_id);
-- The scheduler's main query: "what does this user have that needs work".
create index jobs_user_status_idx on public.jobs (user_id, status);
create index jobs_user_created_idx on public.jobs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- job_snapshots  (immutable evidence)
-- ---------------------------------------------------------------------------
-- One row per fetch ATTEMPT, including failed ones: a failure is evidence too,
-- and keeping it means a retry can be justified rather than guessed at.
create table public.job_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,

  fetched_at timestamptz not null default now(),

  -- NULL when the attempt never produced a response (DNS refusal, timeout,
  -- policy refusal). NULL means "no response", never "status 0".
  http_status integer
    constraint job_snapshots_http_status_range
    check (http_status is null or (http_status >= 100 and http_status <= 599)),

  -- The URL actually retrieved, after redirects. Differs from jobs.canonical_url
  -- whenever the host redirected.
  final_url text
    constraint job_snapshots_final_url_scheme
    check (final_url is null or final_url ~ '^https?://'),

  content_type text,
  byte_size integer not null
    constraint job_snapshots_byte_size_range check (byte_size >= 0 and byte_size <= 5242880),

  -- SHA-256 hex of the body, computed by the fetcher. Lets a re-fetch be
  -- recognised as identical without comparing megabytes.
  content_hash text
    constraint job_snapshots_content_hash_format
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),

  -- NULL when nothing was retrieved. The 5 MiB ceiling is enforced at fetch
  -- time by aborting the stream; this constraint is the backstop.
  body text
    constraint job_snapshots_body_size check (body is null or octet_length(body) <= 5242880),

  outcome text not null
    constraint job_snapshots_outcome_allowed
    check (outcome in (
      'ok', 'gone', 'access_blocked', 'login_required', 'rate_limited',
      'render_required', 'too_large', 'unsupported_content_type',
      'timeout', 'transport', 'refused_by_policy'
    )),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint job_snapshots_text_lengths check (
    coalesce(length(final_url), 0) <= 2048
    and coalesce(length(content_type), 0) <= 200
  ),
  -- A successful fetch must actually carry evidence.
  constraint job_snapshots_ok_has_body
    check (outcome <> 'ok' or (body is not null and content_hash is not null))
);

create index job_snapshots_user_id_idx on public.job_snapshots (user_id);
create index job_snapshots_job_idx on public.job_snapshots (job_id, fetched_at desc);
create index job_snapshots_user_job_idx on public.job_snapshots (user_id, job_id);

-- ---------------------------------------------------------------------------
-- job_facts  (deterministic extraction output)
-- ---------------------------------------------------------------------------
-- Every column is NULLABLE on purpose. A field the page does not publish is
-- NULL. It is never defaulted, inferred from prose, or guessed from the title:
-- that is the same "absence means UNKNOWN" rule the candidate schema enforces.
create table public.job_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,

  -- Every fact is traceable to the immutable snapshot it came from.
  snapshot_id uuid not null references public.job_snapshots (id) on delete cascade,

  title text,
  company_name text,
  location_raw text,
  employment_type text,
  date_posted date,
  valid_through timestamptz,
  salary_min numeric(12, 2),
  salary_max numeric(12, 2),
  salary_currency varchar(3)
    constraint job_facts_currency_format
    check (salary_currency is null or salary_currency ~ '^[A-Z]{3}$'),
  salary_period text
    constraint job_facts_salary_period_allowed
    check (salary_period is null or salary_period in ('hourly', 'daily', 'weekly', 'monthly', 'annual')),
  remote_type text
    constraint job_facts_remote_type_allowed
    check (remote_type is null or remote_type in ('remote', 'hybrid', 'onsite')),
  description_text text,
  apply_url text
    constraint job_facts_apply_url_scheme check (apply_url is null or apply_url ~ '^https?://'),
  identifier text,

  -- { "title": "json_ld", "company_name": "microdata", ... }
  -- One entry per field actually extracted, naming the method that produced it.
  -- No confidence score: the source either stated the field or it did not.
  field_provenance jsonb not null default '{}'::jsonb
    constraint job_facts_provenance_is_object check (jsonb_typeof(field_provenance) = 'object')
    constraint job_facts_provenance_size check (pg_column_size(field_provenance) <= 8192),

  extraction_status text not null
    constraint job_facts_extraction_status_allowed
    check (extraction_status in ('extracted', 'extraction_incomplete')),
  extraction_reason text
    constraint job_facts_extraction_reason_allowed
    check (extraction_reason is null or extraction_reason in (
      'no_structured_data', 'malformed_structured_data', 'partial_structured_data'
    )),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Re-extracting the same snapshot updates the row rather than adding one, so
  -- extraction is idempotent.
  constraint job_facts_one_per_snapshot unique (user_id, snapshot_id),

  constraint job_facts_text_lengths check (
    coalesce(length(title), 0) <= 500
    and coalesce(length(company_name), 0) <= 300
    and coalesce(length(location_raw), 0) <= 500
    and coalesce(length(employment_type), 0) <= 100
    and coalesce(length(description_text), 0) <= 200000
    and coalesce(length(apply_url), 0) <= 2048
    and coalesce(length(identifier), 0) <= 200
  ),

  -- A stated field must actually state something. These route through the same
  -- centralised helper the candidate tables use, so published text that is
  -- blank or invisible-only is rejected here exactly as it is there.
  constraint job_facts_title_not_blank
    check (title is null or not public.is_blank_or_invisible(title)),
  constraint job_facts_company_not_blank
    check (company_name is null or not public.is_blank_or_invisible(company_name)),
  constraint job_facts_location_not_blank
    check (location_raw is null or not public.is_blank_or_invisible(location_raw)),
  constraint job_facts_employment_type_not_blank
    check (employment_type is null or not public.is_blank_or_invisible(employment_type)),
  constraint job_facts_description_not_blank
    check (description_text is null or not public.is_blank_or_invisible(description_text)),
  constraint job_facts_identifier_not_blank
    check (identifier is null or not public.is_blank_or_invisible(identifier)),

  -- Salary bounds must be coherent when both are present.
  constraint job_facts_salary_order
    check (salary_min is null or salary_max is null or salary_max >= salary_min)
);

create index job_facts_user_id_idx on public.job_facts (user_id);
create index job_facts_job_idx on public.job_facts (job_id);
create index job_facts_snapshot_idx on public.job_facts (snapshot_id);

-- ---------------------------------------------------------------------------
-- job_events  (append-only audit)
-- ---------------------------------------------------------------------------
-- The foundation for attributing every decision to an actor. The owner decision
-- on record is that escalations will later be routed to a resolver AGENT with
-- the human as fallback, so actor_type must distinguish them from the start
-- even though nothing yet writes 'agent'.
create table public.job_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_id uuid not null references public.jobs (id) on delete cascade,

  occurred_at timestamptz not null default now(),

  event_type text not null
    constraint job_events_type_allowed
    check (event_type in (
      'submitted', 'deduplicated', 'status_changed',
      'fetch_started', 'fetch_succeeded', 'fetch_failed', 'fetch_refused',
      'extraction_started', 'extraction_succeeded', 'extraction_incomplete',
      'archived'
    )),

  -- NULL on events that are not transitions (a fetch refusal, for instance).
  from_status text
    constraint job_events_from_status_allowed
    check (from_status is null or from_status in (
      'received', 'fetching', 'fetched', 'fetch_failed',
      'extracting', 'extracted', 'extraction_incomplete', 'archived'
    )),
  to_status text
    constraint job_events_to_status_allowed
    check (to_status is null or to_status in (
      'received', 'fetching', 'fetched', 'fetch_failed',
      'extracting', 'extracted', 'extraction_incomplete', 'archived'
    )),

  -- Who caused this. 'system' is for unattended pipeline work; 'agent' is
  -- reserved for the resolver agent that arrives in a later step.
  actor_type text not null
    constraint job_events_actor_type_allowed
    check (actor_type in ('human', 'agent', 'system')),
  -- The acting identity when there is one. For 'human' this is the auth.users
  -- id; for 'agent' it will be the agent's own identifier.
  actor_id uuid,

  error_category text
    constraint job_events_error_category_length
    check (error_category is null or length(error_category) <= 100),
  error_code text
    constraint job_events_error_code_length
    check (error_code is null or length(error_code) <= 100),

  detail jsonb not null default '{}'::jsonb
    constraint job_events_detail_is_object check (jsonb_typeof(detail) = 'object')
    constraint job_events_detail_size check (pg_column_size(detail) <= 8192),

  created_at timestamptz not null default now(),

  -- A human actor must be identified; system events need no id.
  constraint job_events_human_has_actor
    check (actor_type <> 'human' or actor_id is not null)
);

create index job_events_user_id_idx on public.job_events (user_id);
create index job_events_job_idx on public.job_events (job_id, occurred_at desc);
create index job_events_user_job_idx on public.job_events (user_id, job_id);

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  expected_tables text[] := array['jobs', 'job_snapshots', 'job_facts', 'job_events'];
  target text;
  missing text;
begin
  foreach target in array expected_tables loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = target and c.relkind = 'r'
    ) then
      raise exception 'table public.% was not created', target;
    end if;

    -- Every new table must own its user_id directly, not inherit it by join.
    if not exists (
      select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = target
        and a.attname = 'user_id' and a.attnotnull and a.attnum > 0
    ) then
      raise exception '%.user_id is missing or nullable', target;
    end if;

    -- and cascade from auth.users, so account deletion really removes it.
    if not exists (
      select 1 from pg_constraint fk
      join pg_class c on c.oid = fk.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = target and fk.contype = 'f'
        and fk.confdeltype = 'c'
        and fk.conkey = (select array_agg(a.attnum) from pg_attribute a
                         where a.attrelid = c.oid and a.attname = 'user_id')
    ) then
      raise exception '%.user_id does not cascade from auth.users', target;
    end if;

    if not exists (
      select 1 from pg_index i join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = target
        and (select array_agg(x) from unnest(i.indkey::int[]) x) @> array[
          (select a.attnum::int from pg_attribute a where a.attrelid = c.oid and a.attname = 'user_id')]
    ) then
      raise exception '%.user_id is not indexed', target;
    end if;
  end loop;

  -- The dedupe key must be generated, not client-supplied.
  if not exists (
    select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'jobs'
      and a.attname = 'url_fingerprint' and a.attgenerated <> ''
  ) then
    raise exception 'jobs.url_fingerprint must be a generated column';
  end if;

  -- The blank/invisible rule must be inherited, not reimplemented.
  select string_agg(c.conname, ', ') into missing
  from pg_constraint c join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and t.relname = 'job_facts'
    and c.conname like '%_not_blank'
    and pg_get_constraintdef(c.oid) not like '%is_blank_or_invisible%';
  if missing is not null then
    raise exception 'job_facts blankness constraints not routed through the helper: %', missing;
  end if;

  if (select count(*) from pg_constraint c join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = 'job_facts'
        and pg_get_constraintdef(c.oid) like '%is_blank_or_invisible%') <> 6 then
    raise exception 'expected 6 job_facts blankness constraints';
  end if;

  raise notice 'Job intake tables created: jobs, job_snapshots, job_facts, job_events.';
end;
$$;
