-- Resume import: the parsed draft that sits between "uploaded" and "confirmed".
--
-- WHY A TABLE AND NOT A DIRECT WRITE
--
-- The product decision is parse -> review -> confirm, not parse -> autofill.
-- That needs somewhere to hold what a model read while the person checks it,
-- and it must NOT be the candidate tables: writing straight into `profiles` and
-- `work_experiences` would make a machine's reading indistinguishable from a
-- fact the person stated, which is the one thing this schema has consistently
-- refused to allow.
--
-- WHERE PROVENANCE ACTUALLY LIVES
--
-- Only `verified_answers` carries a `source` column (migration 6), and
-- migration 9 reserves 'imported_from_resume' there for non-API roles. The
-- profile tables — profiles, work_experiences, education_entries, skills — have
-- no provenance column at all, so there is nowhere on those rows to record that
-- a PDF suggested them.
--
-- That is the right outcome, not a gap to paper over. Under parse -> review ->
-- confirm, nothing reaches those tables until a person has seen each field and
-- pressed confirm; at that point the data IS user-entered, because a human
-- asserted it. What a model proposed and what a human accepted stay separable
-- anyway: this table keeps the draft, the file it came from, the model that
-- read it, and the instant of confirmation. The audit trail is the import, not
-- a label smuggled onto every row.
--
-- Consequently the confirm step writes with the CANDIDATE'S OWN SESSION through
-- the ordinary data layer, under the same RLS as the profile forms. It needs no
-- elevated role, so the resume feature adds no new path for the secret key to
-- touch candidate data.
--
-- THE DRAFT IS NOT EVIDENCE
--
-- `extracted` holds a model's reading of a document. It is a proposal, and this
-- table treats it as one: editable by the owner only while it is under review,
-- frozen once confirmed or discarded. The uploaded file is the evidence, and it
-- lives in Storage.

create table public.resume_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- HOW THE DRAFT GOT HERE.
  --
  -- 'upload' is a PDF in the private bucket, read by a model server-side.
  -- 'pasted' is a draft the candidate produced in Claude themselves and pasted
  -- in — the same review and the same confirmation, with no API key and no cost
  -- per résumé. Recorded rather than inferred from a null path, because "where
  -- did this come from" is a question worth being able to answer directly.
  source_kind text not null default 'upload'
    constraint resume_imports_source_kind_allowed check (source_kind in ('upload', 'pasted')),

  -- Where the original sits in the private `resumes` bucket. Kept so a review
  -- can be reopened against the source, and so deletion can clean up the file.
  -- Null for a pasted draft: there is no file, and inventing a path for one
  -- would make the delete path lie about what it removed.
  storage_path text
    constraint resume_imports_storage_path_length check (storage_path is null or length(storage_path) between 1 and 500),
  file_name text
    constraint resume_imports_file_name_length check (file_name is null or length(file_name) <= 300),
  file_size_bytes integer
    constraint resume_imports_file_size_positive check (file_size_bytes is null or file_size_bytes > 0),

  status text not null default 'uploaded'
    constraint resume_imports_status_allowed
    check (status in (
      'uploaded',   -- stored, not yet read
      'parsing',    -- a model is reading it
      'parsed',     -- a draft is waiting for the person to review
      'confirmed',  -- the person accepted it; the profile tables were written
      'discarded',  -- the person rejected it
      'failed'      -- parsing did not produce a usable draft
    )),

  -- Machine-readable reason when status = 'failed'. Same split as the rest of
  -- the codebase: a class a caller can branch on, plus a specific code.
  failure_class text
    constraint resume_imports_failure_class_allowed
    check (failure_class is null or failure_class in ('unreadable', 'too_large', 'model_error', 'timeout')),
  failure_code text
    constraint resume_imports_failure_code_length
    check (failure_code is null or length(failure_code) <= 100),

  -- What the model read. NULL until parsed. A proposal, never a fact.
  extracted jsonb
    constraint resume_imports_extracted_is_object
    check (extracted is null or jsonb_typeof(extracted) = 'object')
    constraint resume_imports_extracted_size
    check (extracted is null or pg_column_size(extracted) <= 262144),

  -- Which model produced it, so a bad extraction can be traced to a version
  -- rather than guessed at.
  model text
    constraint resume_imports_model_length check (model is null or length(model) <= 100),

  parsed_at timestamptz,
  confirmed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An upload has a file; a pasted draft does not. Written as a biconditional
  -- so neither half can drift: no fileless upload, and no orphan path left
  -- behind on a paste for a delete to trip over.
  constraint resume_imports_upload_has_file
    check ((source_kind = 'upload') = (storage_path is not null)),
  -- A failure says why; anything else does not pretend to have failed.
  constraint resume_imports_failure_has_class
    check ((status = 'failed') = (failure_class is not null)),
  -- A row under review or already accepted must actually hold a draft.
  constraint resume_imports_parsed_has_extraction
    check (status not in ('parsed', 'confirmed') or extracted is not null),
  constraint resume_imports_confirmed_has_timestamp
    check ((status = 'confirmed') = (confirmed_at is not null))
);

comment on table public.resume_imports is
  'A parsed resume awaiting review. The draft is a model proposal, never a fact: '
  'nothing reaches the profile tables until the candidate confirms it, and the '
  'confirmation writes under their own session.';

comment on column public.resume_imports.extracted is
  'What a model read from the PDF. A proposal for the candidate to correct, not evidence.';

create index resume_imports_user_idx on public.resume_imports (user_id, created_at desc);
create index resume_imports_status_idx on public.resume_imports (status);

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
do $$
begin
  alter table public.resume_imports enable row level security;
  alter table public.resume_imports force row level security;

  revoke all on public.resume_imports from anon;
  revoke all on public.resume_imports from public;
  revoke all on public.resume_imports from authenticated;
  revoke all on public.resume_imports from service_role;

  -- The owner may read their imports and correct a draft while reviewing it.
  --
  -- They may NOT insert one. An import row is created by the server after a
  -- file has actually been stored, which keeps a row from claiming a file that
  -- does not exist and — because parsing costs money on every call — keeps the
  -- decision to spend it on the server rather than in the browser.
  grant select, update on public.resume_imports to authenticated;

  create policy resume_imports_select_own on public.resume_imports
    for select to authenticated
    using ((select auth.uid()) = user_id);

  -- The review window, and only the review window. USING restricts editing to a
  -- row that is still the person's to deal with — a draft under review, or a
  -- failed attempt they want to clear away. WITH CHECK restricts where it can go.
  --
  -- 'confirmed' is deliberately absent from both: a client cannot mark itself
  -- confirmed, because confirmation is a claim that rows were written to the
  -- profile tables, and only the server that wrote them can make it truthfully.
  create policy resume_imports_update_own on public.resume_imports
    for update to authenticated
    using ((select auth.uid()) = user_id and status in ('parsed', 'failed'))
    with check ((select auth.uid()) = user_id and status in ('parsed', 'discarded'));

  -- Deleting an import must also delete the stored file, which the route
  -- handler does in one place — hence no DELETE grant to authenticated.
  grant select, insert, update, delete on public.resume_imports to service_role;
end;
$$;

create trigger resume_imports_set_row_timestamps
  before insert or update on public.resume_imports
  for each row execute function public.set_row_timestamps();

-- The subject of an import may never be reassigned, mirroring the guards on
-- user_roles and user_access.
create or replace function public.guard_resume_import_subject()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'resume_imports.user_id is immutable'
      using errcode = 'restrict_violation';
  end if;

  -- The stored file is the evidence the draft was derived from. Repointing a
  -- reviewed import at a different upload would silently change what the person
  -- is confirming.
  if new.storage_path is distinct from old.storage_path then
    raise exception 'resume_imports.storage_path is immutable'
      using errcode = 'restrict_violation';
  end if;

  -- How a draft got here is a fact about the past. Letting a pasted import
  -- relabel itself as an upload would make it claim a file it never had.
  if new.source_kind is distinct from old.source_kind then
    raise exception 'resume_imports.source_kind is immutable'
      using errcode = 'restrict_violation';
  end if;

  -- Belt and braces over the RLS policy above: policies apply to `authenticated`
  -- only, and this says the same thing about `current_user` so a future role
  -- added to the table does not quietly inherit the ability to self-confirm.
  if current_user in ('anon', 'authenticated')
     and new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    raise exception 'an import is confirmed by the server that wrote the profile rows, not by the client'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.guard_resume_import_subject() is
  'BEFORE UPDATE on resume_imports: pins the owner, the source file and how the '
  'draft got here, and refuses client-side self-confirmation.';

create trigger resume_imports_zz_subject_immutable
  before update on public.resume_imports
  for each row execute function public.guard_resume_import_subject();

revoke all on function public.guard_resume_import_subject() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
-- A private bucket. A resume carries a person's full name, contact details,
-- address and employment history in one file; a public bucket would put all of
-- that behind a URL that needs no session at all.
--
-- Files are laid out as `<user_id>/<import_id>.pdf`, so the first path segment
-- IS the owner and every policy below compares against it. That is the standard
-- Supabase pattern, and it means no crafted path reaches another user's folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resumes',
  'resumes',
  false,
  10485760,                       -- 10 MB; the model's own PDF ceiling is far higher
  array['application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  -- Upload into, and read from, your own folder. There is no UPDATE policy: a
  -- resume is replaced by uploading a new one, which keeps every import pinned
  -- to the exact bytes it was parsed from.
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'resumes_insert_own') then
    create policy resumes_insert_own on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'resumes'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'resumes_select_own') then
    create policy resumes_select_own on storage.objects
      for select to authenticated
      using (
        bucket_id = 'resumes'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'resumes_delete_own') then
    create policy resumes_delete_own on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'resumes'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Self-verification
-- ---------------------------------------------------------------------------
do $$
declare
  offending text;
  n integer;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname = 'resume_imports'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'RLS not enabled and forced on resume_imports';
  end if;

  -- The owner may read and correct a draft, never create one.
  select string_agg(privilege_type, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'resume_imports'
    and grantee = 'authenticated' and privilege_type not in ('SELECT', 'UPDATE');
  if offending is not null then
    raise exception 'authenticated holds unexpected privileges on resume_imports: %', offending;
  end if;

  select string_agg(distinct grantee, ', ') into offending
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'resume_imports'
    and grantee in ('anon', 'PUBLIC');
  if offending is not null then
    raise exception 'anon/PUBLIC hold grants on resume_imports: %', offending;
  end if;

  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = 'resume_imports';
  if n <> 2 then
    raise exception 'expected 2 policies on resume_imports, found %', n;
  end if;

  -- THE containment control for the file itself.
  if exists (select 1 from storage.buckets where id = 'resumes' and public) then
    raise exception 'the resumes bucket is PUBLIC; a resume is a full dossier on one person';
  end if;

  select count(*) into n from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname in ('resumes_insert_own', 'resumes_select_own', 'resumes_delete_own');
  if n <> 3 then
    raise exception 'expected 3 storage policies for resumes, found %', n;
  end if;

  raise notice 'resume_imports created; resumes bucket is private and owner-scoped.';
end;
$$;
