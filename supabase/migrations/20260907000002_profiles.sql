-- Candidate identity and contact details. Exactly one row per auth user.
--
-- user_id is both the primary key and the foreign key, which enforces the 1:1
-- relationship without a second unique index and gives RLS its index for free.
--
-- Rows are created lazily when the user starts onboarding (no auth.users
-- trigger): a failing trigger would break sign-up itself, and sign-up is
-- already working in production.
--
-- auth.users.user_metadata.full_name is NOT authoritative here. It is set by
-- the user at sign-up and is user-writable, so it may only prefill the
-- onboarding form; the legal name columns below are what the agent may rely on.

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- Legal name, split because application forms ask for the parts separately.
  legal_first_name   text,
  legal_middle_name  text,
  legal_last_name    text,
  legal_suffix       text,
  preferred_name     text,

  -- Contact. Kept separate from the login email: people routinely apply with a
  -- different address than the one they signed up with.
  contact_email text
    constraint profiles_contact_email_format
    check (contact_email is null or contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  -- E.164. [0-9] rather than \d so the class cannot be reinterpreted under a
  -- different regex flavour or locale.
  phone_e164 text
    constraint profiles_phone_e164_format
    check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),

  address_line_1 text,
  address_line_2 text,
  city           text,
  state_region   text,
  postal_code    text,

  -- ISO 3166-1 alpha-2, stored uppercase. varchar(2) not char(2): char pads
  -- with spaces, which silently breaks equality comparisons.
  country_code varchar(2)
    constraint profiles_country_code_format
    check (country_code is null or country_code ~ '^[A-Z]{2}$'),

  -- IANA zone ("Europe/London", "UTC"). A CHECK cannot query
  -- pg_timezone_names, so this validates shape only.
  timezone text
    constraint profiles_timezone_format
    check (timezone is null or timezone ~ '^([A-Za-z_+-]+/[A-Za-z_0-9+/-]+|UTC)$'),

  linkedin_url  text constraint profiles_linkedin_url_format  check (linkedin_url  is null or linkedin_url  ~ '^https?://'),
  github_url    text constraint profiles_github_url_format    check (github_url    is null or github_url    ~ '^https?://'),
  portfolio_url text constraint profiles_portfolio_url_format check (portfolio_url is null or portfolio_url ~ '^https?://'),
  website_url   text constraint profiles_website_url_format   check (website_url   is null or website_url   ~ '^https?://'),

  -- Open-ended extras only: [{ "label": "...", "url": "..." }]. Never filtered
  -- on, so JSONB is appropriate here where it would not be for the four above.
  other_links jsonb not null default '[]'::jsonb
    constraint profiles_other_links_is_array check (jsonb_typeof(other_links) = 'array'),

  -- When the user finished onboarding. Deliberately NOT a completion
  -- percentage: a stored percentage goes stale the moment a related row
  -- changes. The application computes completeness from the actual records.
  onboarding_completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Candidate identity. One row per auth user, created lazily at onboarding.';
comment on column public.profiles.other_links is
  'Array of {label,url} for links beyond the four first-class ones.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();
