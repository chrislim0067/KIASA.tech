-- Candidate history: the raw material a resume is tailored FROM.
--
-- Six separate 1:N tables rather than one JSON document, because the future
-- tailoring step has to select a subset — "the three most relevant roles", "the
-- skills this posting names" — and you cannot index, order or filter inside a
-- blob. Descriptions and achievements are captured here; no resume documents
-- are produced in this step.
--
-- Shared shape: uuid id, user_id, sort_order for user-controlled ordering,
-- date-order checks, timestamps.

-- ------------------------------------------------------------ work experience
create table public.work_experiences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  company_name text not null
    constraint work_experiences_company_not_blank check (btrim(company_name) <> ''),
  job_title text not null
    constraint work_experiences_title_not_blank check (btrim(job_title) <> ''),

  employment_type text
    constraint work_experiences_employment_type_allowed
    check (employment_type is null or employment_type in
      ('full_time', 'part_time', 'contract', 'internship', 'temporary', 'freelance')),
  work_mode text
    constraint work_experiences_work_mode_allowed
    check (work_mode is null or work_mode in ('remote', 'hybrid', 'onsite')),

  location_city text,
  location_country_code varchar(2)
    constraint work_experiences_country_format check (location_country_code is null or location_country_code ~ '^[A-Z]{2}$'),

  start_date date,
  end_date   date,
  is_current boolean not null default false,

  description  text,
  achievements text[] not null default '{}'
    constraint work_experiences_achievements_no_blanks check (public.text_array_no_blanks(achievements)),

  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint work_experiences_date_order check (end_date is null or start_date is null or end_date >= start_date),
  -- A role cannot be current and also have ended.
  constraint work_experiences_current_has_no_end check (is_current = false or end_date is null)
);

create index work_experiences_user_id_idx on public.work_experiences (user_id);
create trigger work_experiences_set_updated_at before update on public.work_experiences
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------- education
create table public.education_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  institution_name text not null
    constraint education_entries_institution_not_blank check (btrim(institution_name) <> ''),
  degree          text,
  field_of_study  text,

  location_city text,
  location_country_code varchar(2)
    constraint education_entries_country_format check (location_country_code is null or location_country_code ~ '^[A-Z]{2}$'),

  start_date date,
  end_date   date,
  is_current boolean not null default false,

  -- Free text, not a number: grading scales differ by country and a numeric GPA
  -- would force a lossy conversion.
  grade text,

  description  text,
  achievements text[] not null default '{}'
    constraint education_entries_achievements_no_blanks check (public.text_array_no_blanks(achievements)),

  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint education_entries_date_order check (end_date is null or start_date is null or end_date >= start_date),
  constraint education_entries_current_has_no_end check (is_current = false or end_date is null)
);

create index education_entries_user_id_idx on public.education_entries (user_id);
create trigger education_entries_set_updated_at before update on public.education_entries
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------- skills
create table public.skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null
    constraint skills_name_not_blank check (btrim(name) <> ''),
  category text,

  proficiency text
    constraint skills_proficiency_allowed
    check (proficiency is null or proficiency in ('beginner', 'intermediate', 'advanced', 'expert')),

  years_experience numeric(4, 1)
    constraint skills_years_range check (years_experience is null or (years_experience >= 0 and years_experience <= 70)),
  last_used_year int
    constraint skills_last_used_year_range check (last_used_year is null or (last_used_year between 1950 and 2100)),

  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Case-insensitive: "Python" and "python" are one skill, so the agent cannot
-- report two different proficiencies for the same thing.
create unique index skills_user_name_unique on public.skills (user_id, lower(name));
create index skills_user_id_idx on public.skills (user_id);
create trigger skills_set_updated_at before update on public.skills
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------ certifications
create table public.certifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null
    constraint certifications_name_not_blank check (btrim(name) <> ''),
  issuing_organization text,

  issue_date  date,
  expiry_date date,
  does_not_expire boolean not null default false,

  -- The public verification identifier printed on the credential itself (e.g.
  -- an AWS certification number). Not a government or identity document.
  credential_id  text,
  credential_url text
    constraint certifications_credential_url_format check (credential_url is null or credential_url ~ '^https?://'),

  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint certifications_date_order check (expiry_date is null or issue_date is null or expiry_date >= issue_date),
  constraint certifications_no_expiry_conflict check (does_not_expire = false or expiry_date is null)
);

create index certifications_user_id_idx on public.certifications (user_id);
create trigger certifications_set_updated_at before update on public.certifications
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------ projects
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null
    constraint projects_name_not_blank check (btrim(name) <> ''),
  role text,

  url text
    constraint projects_url_format check (url is null or url ~ '^https?://'),
  repository_url text
    constraint projects_repo_url_format check (repository_url is null or repository_url ~ '^https?://'),

  description  text,
  achievements text[] not null default '{}'
    constraint projects_achievements_no_blanks check (public.text_array_no_blanks(achievements)),
  technologies text[] not null default '{}'
    constraint projects_technologies_no_blanks check (public.text_array_no_blanks(technologies)),

  start_date date,
  end_date   date,
  is_ongoing boolean not null default false,

  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint projects_date_order check (end_date is null or start_date is null or end_date >= start_date),
  constraint projects_ongoing_has_no_end check (is_ongoing = false or end_date is null)
);

create index projects_user_id_idx on public.projects (user_id);
create trigger projects_set_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------- languages
create table public.languages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- ISO 639-1 where possible, BCP 47 subtags allowed (e.g. 'pt-BR').
  language_code varchar(8) not null
    constraint languages_code_format check (language_code ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  language_name text,

  -- ILR-style scale, which is what application forms usually mirror.
  proficiency text not null
    constraint languages_proficiency_allowed
    check (proficiency in ('elementary', 'limited_working', 'professional_working', 'full_professional', 'native_bilingual')),

  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint languages_one_per_code unique (user_id, language_code)
);

create index languages_user_id_idx on public.languages (user_id);
create trigger languages_set_updated_at before update on public.languages
  for each row execute function public.set_updated_at();
