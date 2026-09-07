-- One explicit assertion per country the candidate has told us about.
--
-- THE RULE THAT MATTERS: the absence of a row means UNKNOWN. It never means
-- "not authorized". The agent must refuse to answer a work-authorization
-- question for any country without a row here and ask the user instead.
--
-- That is why all three booleans are NOT NULL: a row is a complete statement or
-- it does not exist. There is no half-answered country, and no nullable boolean
-- that could be read as a tri-state by accident.
--
-- Only the *description* of the basis is stored. Never a visa, passport,
-- permit or national identification number, and never document images — none of
-- that is needed to answer an application question, and storing it would create
-- risk with no benefit.

create table public.work_authorizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  country_code varchar(2) not null
    constraint work_authorizations_country_code_format check (country_code ~ '^[A-Z]{2}$'),

  is_authorized               boolean not null,
  sponsorship_required_now    boolean not null,
  sponsorship_required_future boolean not null,

  -- Free text, e.g. 'citizen', 'permanent resident', 'work visa valid to 2027'.
  basis text
    constraint work_authorizations_basis_length check (basis is null or length(basis) <= 500),

  -- Set when the candidate explicitly confirms this row is current.
  verified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint work_authorizations_one_per_country unique (user_id, country_code)
);

comment on table public.work_authorizations is
  'Per-country authorization. NO ROW MEANS UNKNOWN, never "not authorized".';
comment on column public.work_authorizations.basis is
  'Description only. Never document numbers, identifiers or images.';

create index work_authorizations_user_id_idx on public.work_authorizations (user_id);

create trigger work_authorizations_set_updated_at
  before update on public.work_authorizations
  for each row execute function public.set_updated_at();
