/**
 * The résumé import boundary.
 *
 *   node scripts/test-resume-import.mjs
 *
 * Runs against the LOCAL stack only, and refuses to run anywhere else. Every
 * credential is read from `supabase status` at runtime, every user it creates
 * is a throwaway it deletes afterwards, and it exits non-zero on any failure.
 *
 * WHAT THIS IS FOR
 *
 * The import feature's security rests on four claims, and each is a claim about
 * the database rather than about the application code — which is precisely why
 * they are tested here and not with mocks:
 *
 *   1. A candidate cannot create an import. Creating one is the server's
 *      decision, because it commits us to a paid model call.
 *   2. A candidate cannot mark an import confirmed. "Confirmed" asserts that
 *      rows were written to the profile tables; only the code that wrote them
 *      can say so.
 *   3. A candidate cannot reach another candidate's import, or another
 *      candidate's résumé file.
 *   4. The résumé bucket is private.
 *
 * It also checks `ResumeImportRow` against the real table. That type is now
 * projected from the generated schema, so this guards the three columns narrowed
 * past what the generator can express (source_kind, status, failure_class).
 */
import { execFileSync } from 'node:child_process';

import { statusEnvRaw } from './lib/supabase-cli.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function localEnv() {
  const raw = statusEnvRaw();
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\r]*)"?/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.API_URL || !/127\.0\.0\.1|localhost/.test(env.API_URL)) {
    throw new Error('Local Supabase is not running, or the API URL is not local.');
  }
  return {
    url: env.API_URL,
    key: env.PUBLISHABLE_KEY || env.ANON_KEY,
    secret: env.SECRET_KEY || env.SERVICE_ROLE_KEY,
  };
}

const { url: API_URL, key: PUBLISHABLE_KEY, secret: SECRET_KEY } = localEnv();
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';

const sql = (s) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-qtAc', s], {
    encoding: 'utf8',
  }).trim();

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const created = [];

async function makeUser() {
  const email = `res_${randomUUID().slice(0, 8)}@example.com`;
  const password = `${randomBytes(18).toString('base64url')}Aa1!`;
  const plain = createClient(API_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await plain.auth.signUp({ email, password });
  if (error) throw new Error(`signUp failed: ${error.message}`);
  created.push(data.user.id);

  // Approved out of band, the only way the system allows.
  sql(
    `insert into public.user_access (user_id, status, decided_at)
     values ('${data.user.id}', 'approved', now())
     on conflict (user_id) do update set status = 'approved', decided_at = now()`
  );

  const { data: session, error: signInError } = await plain.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);

  const client = createClient(API_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await client.auth.setSession({
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
  });

  return { id: data.user.id, client };
}

/** A tiny but structurally real PDF, so a storage upload exercises the MIME rule. */
const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8'
);

/**
 * The columns `lib/resume/imports.ts` declares by hand. Kept in this file
 * deliberately: if the two drift, the test fails rather than the application
 * silently reading a column that is no longer there.
 */
const DECLARED_COLUMNS = [
  'id',
  'user_id',
  'source_kind',
  'storage_path',
  'file_name',
  'file_size_bytes',
  'status',
  'failure_class',
  'failure_code',
  /**
   * The exact provider outcome, added by migration 30. Distinct from
   * `failure_code`, which carries the candidate-facing taxonomy in which five
   * different provider outcomes all share `no_structured_output`.
   */
  'provider_failure_code',
  /** Field paths that failed validation, added by migration 31. */
  'provider_failure_detail',
  'extracted',
  'model',
  'parsed_at',
  'confirmed_at',
  'created_at',
  'updated_at',
];

async function main() {
  /* ------------------------------------------------------------- structure */
  section('The table matches what the code declares');

  const actual = sql(
    `select string_agg(column_name, ',' order by column_name)
     from information_schema.columns
     where table_schema = 'public' and table_name = 'resume_imports'`
  );
  const actualSet = new Set(actual ? actual.split(',') : []);
  const declaredSet = new Set(DECLARED_COLUMNS);

  const missing = [...declaredSet].filter((c) => !actualSet.has(c));
  const extra = [...actualSet].filter((c) => !declaredSet.has(c));

  check('every declared column exists', missing.length === 0, missing.join(', '));
  check('no column exists that the code does not know about', extra.length === 0, extra.join(', '));

  /* ------------------------------------------- the provider failure column */
  section('The exact provider outcome is storable, and free text is not');

  /*
   * WHY THIS IS PROVED HERE RATHER THAN IN THE MIGRATION
   *
   * `resume_imports.user_id` is NOT NULL and references auth.users, so an
   * insert inside migration 30's own DO block would die on the foreign key —
   * and an exception handler broad enough to survive that would swallow a CHECK
   * violation too, leaving a loop that proved nothing. The migration therefore
   * compares the constraint's vocabulary as a set, and the behaviour is proved
   * here, where a real user exists.
   */
  {
    const owner = await makeUser();

    /* Every member of the vocabulary is genuinely storable. */
    const VOCABULARY = [
      'not_configured', 'timeout', 'rate_limited', 'auth_failed', 'bad_request',
      'server_error', 'connection_failed', 'no_content', 'output_truncated',
      'reasoning_only', 'refused', 'malformed_json', 'invalid_structure',
    ];

    const stored = [];
    for (const code of VOCABULARY) {
      const id = sql(
        `insert into public.resume_imports
           (user_id, source_kind, status, failure_class, failure_code, provider_failure_code)
         values
           ('${owner.id}', 'pasted', 'failed', 'unreadable', 'no_structured_output', '${code}')
         returning provider_failure_code`
      );
      stored.push(id);
    }
    check('every provider code the adapter can produce is storable',
      stored.join(',') === VOCABULARY.join(','),
      stored.join(','));

    /*
     * THE FIVE THAT USED TO COLLAPSE ARE NOW DISTINGUISHABLE.
     *
     * This is the whole point of the milestone: five rows that a candidate was
     * shown the same sentence for can now be told apart by an operator.
     */
    const distinct = sql(
      `select count(distinct provider_failure_code)
       from public.resume_imports
       where user_id = '${owner.id}'
         and failure_code = 'no_structured_output'
         and provider_failure_code in
             ('reasoning_only', 'refused', 'no_content', 'malformed_json', 'invalid_structure')`
    );
    check('the five collapsing outcomes are stored distinctly', distinct === '5', distinct);

    /* FREE TEXT IS REFUSED BY THE DATABASE, not filtered by application code. */
    for (const rejected of [
      'the candidate lives at 12 Example Street',
      'ERROR:  duplicate key value violates unique constraint',
      'sk-or-v1-not-a-real-key',
      '',
    ]) {
      const escaped = rejected.replace(/'/g, "''");
      let accepted = true;
      try {
        sql(
          `insert into public.resume_imports
             (user_id, source_kind, status, failure_class, provider_failure_code)
           values ('${owner.id}', 'pasted', 'failed', 'unreadable', '${escaped}')`
        );
      } catch {
        accepted = false;
      }
      check(`  refuses free text (${rejected.slice(0, 28) || 'empty string'}…)`, accepted === false);
    }

    /* A ROW THAT DID NOT FAIL MAY NOT CARRY A PROVIDER FAILURE. */
    let parsedAccepted = true;
    try {
      sql(
        `insert into public.resume_imports
           (user_id, source_kind, status, extracted, model, parsed_at, provider_failure_code)
         values ('${owner.id}', 'pasted', 'parsed', '{}'::jsonb, 'm', now(), 'reasoning_only')`
      );
    } catch {
      parsedAccepted = false;
    }
    check('a parsed import cannot carry a provider failure code', parsedAccepted === false,
      'the two columns would be disagreeing about whether anything went wrong');

    /*
     * A FAILURE DECIDED LOCALLY STORES NULL, NOT A MADE-UP CODE.
     *
     * An empty file or a scan with no text layer never reaches the provider, so
     * there is no provider outcome to report. Writing one anyway would put a
     * provider code on a row whose PDF never left this server, and would send
     * whoever reads it looking in the wrong place.
     */
    const localOnly = sql(
      `insert into public.resume_imports
         (user_id, source_kind, status, failure_class, failure_code)
       values ('${owner.id}', 'pasted', 'failed', 'unreadable', 'scanned_no_text')
       returning coalesce(provider_failure_code, 'null')`
    );
    check('a failure decided locally stores null, not a made-up code',
      localOnly === 'null', localOnly);

    sql(`delete from public.resume_imports where user_id = '${owner.id}'`);
  }

  /* ------------------------------------------------------- RLS and grants */
  section('Row Level Security');

  check(
    'RLS is enabled AND forced',
    sql(
      `select relrowsecurity and relforcerowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'resume_imports'`
    ) === 't'
  );

  const authGrants = sql(
    `select string_agg(distinct privilege_type, ',' order by privilege_type)
     from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'resume_imports' and grantee = 'authenticated'`
  );
  check(
    'authenticated holds SELECT and UPDATE, and nothing else',
    authGrants === 'SELECT,UPDATE',
    `got: ${authGrants || 'none'}`
  );

  const anonGrants = sql(
    `select count(*) from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'resume_imports'
       and grantee in ('anon', 'PUBLIC')`
  );
  check('anon and PUBLIC hold nothing', anonGrants === '0', `grants: ${anonGrants}`);

  /* ---------------------------------------------------------- the bucket */
  section('The résumé bucket');

  check(
    'the bucket exists and is PRIVATE',
    sql(`select not public from storage.buckets where id = 'resumes'`) === 't'
  );
  check(
    'only PDFs are accepted',
    sql(`select allowed_mime_types::text from storage.buckets where id = 'resumes'`) ===
      '{application/pdf}'
  );
  check(
    'all three owner-scoped storage policies exist',
    sql(
      `select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
       and policyname in ('resumes_insert_own', 'resumes_select_own', 'resumes_delete_own')`
    ) === '3'
  );

  /* ------------------------------------------------------------ behaviour */
  const alice = await makeUser();
  const bob = await makeUser();

  section('A candidate cannot create an import');

  const selfInsert = await alice.client
    .from('resume_imports')
    .insert({ user_id: alice.id, storage_path: `${alice.id}/${randomUUID()}.pdf` });
  check(
    'INSERT is refused',
    selfInsert.error !== null,
    selfInsert.error ? `code ${selfInsert.error.code}` : 'INSERT SUCCEEDED'
  );

  // The server creates one, the way the application does.
  const importId = sql(
    `insert into public.resume_imports (user_id, storage_path, status, extracted, model, parsed_at)
     values ('${alice.id}', '${alice.id}/${randomUUID()}.pdf', 'parsed',
             '{"legal_first_name":"Alice","work_experiences":[]}'::jsonb, 'google/gemini-2.5-flash', now())
     returning id`
  );
  check('the server can create one', /^[0-9a-f-]{36}$/.test(importId), importId);

  section('An import is visible only to its owner');

  const own = await alice.client.from('resume_imports').select('id').eq('id', importId);
  check('the owner sees it', own.data?.length === 1, `rows: ${own.data?.length ?? 0}`);

  const other = await bob.client.from('resume_imports').select('id').eq('id', importId);
  check(
    'another candidate sees nothing',
    (other.data?.length ?? 0) === 0,
    `rows: ${other.data?.length ?? 0}`
  );

  const anon = createClient(API_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anonRead = await anon.from('resume_imports').select('id');
  check(
    'an anonymous caller sees nothing',
    anonRead.error !== null || (anonRead.data?.length ?? 0) === 0,
    anonRead.error ? `code ${anonRead.error.code}` : `rows: ${anonRead.data?.length ?? 0}`
  );

  section('The review window');

  const edit = await alice.client
    .from('resume_imports')
    .update({ extracted: { legal_first_name: 'Alicia', work_experiences: [] } })
    .eq('id', importId)
    .select('id');
  check('the owner may correct their own draft', edit.data?.length === 1, edit.error?.code ?? '');

  const stolen = await bob.client
    .from('resume_imports')
    .update({ extracted: { legal_first_name: 'Mallory' } })
    .eq('id', importId)
    .select('id');
  check(
    "another candidate cannot edit it",
    (stolen.data?.length ?? 0) === 0,
    `rows: ${stolen.data?.length ?? 0}`
  );

  section('A candidate cannot confirm their own import');

  const selfConfirm = await alice.client
    .from('resume_imports')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', importId)
    .select('id');
  check(
    'setting status to confirmed is refused',
    selfConfirm.error !== null || (selfConfirm.data?.length ?? 0) === 0,
    selfConfirm.error ? `code ${selfConfirm.error.code}` : `rows: ${selfConfirm.data?.length ?? 0}`
  );
  check(
    'and the row is still parsed',
    sql(`select status from public.resume_imports where id = '${importId}'`) === 'parsed'
  );

  section('The subject and the source file are pinned');

  const donate = await alice.client
    .from('resume_imports')
    .update({ user_id: bob.id })
    .eq('id', importId)
    .select('id');
  check(
    'the owner cannot be reassigned',
    donate.error !== null || (donate.data?.length ?? 0) === 0,
    donate.error ? `code ${donate.error.code}` : 'UPDATE SUCCEEDED'
  );

  const repoint = await alice.client
    .from('resume_imports')
    .update({ storage_path: `${alice.id}/${randomUUID()}.pdf` })
    .eq('id', importId)
    .select('id');
  check(
    'the source file cannot be swapped under a reviewed draft',
    repoint.error !== null || (repoint.data?.length ?? 0) === 0,
    repoint.error ? `code ${repoint.error.code}` : 'UPDATE SUCCEEDED'
  );

  section('Discarding');

  const discard = await alice.client
    .from('resume_imports')
    .update({ status: 'discarded', failure_class: null, failure_code: null })
    .eq('id', importId)
    .select('id');
  check('the owner may discard a draft', discard.data?.length === 1, discard.error?.code ?? '');

  const reopen = await alice.client
    .from('resume_imports')
    .update({ status: 'parsed' })
    .eq('id', importId)
    .select('id');
  check(
    'a discarded import cannot be reopened',
    (reopen.data?.length ?? 0) === 0,
    `rows: ${reopen.data?.length ?? 0}`
  );

  /* -------------------------------------------------------------- storage */
  section('Résumé files');

  const mine = `${alice.id}/${randomUUID()}.pdf`;
  const upMine = await alice.client.storage
    .from('resumes')
    .upload(mine, PDF_BYTES, { contentType: 'application/pdf' });
  check('a candidate can upload into their own folder', !upMine.error, upMine.error?.message ?? '');

  const theirs = `${bob.id}/${randomUUID()}.pdf`;
  const upTheirs = await alice.client.storage
    .from('resumes')
    .upload(theirs, PDF_BYTES, { contentType: 'application/pdf' });
  check(
    "a candidate cannot upload into someone else's folder",
    upTheirs.error !== null,
    upTheirs.error ? 'refused' : 'UPLOAD SUCCEEDED'
  );

  const readMine = await alice.client.storage.from('resumes').download(mine);
  check('the owner can read their own résumé', !readMine.error, readMine.error?.message ?? '');

  const readTheirs = await bob.client.storage.from('resumes').download(mine);
  check(
    "another candidate cannot read it",
    readTheirs.error !== null,
    readTheirs.error ? 'refused' : 'DOWNLOAD SUCCEEDED'
  );

  // A private bucket is the containment control for the file itself, so the
  // public URL is checked over plain HTTP rather than inferred from the flag.
  const publicUrl = alice.client.storage.from('resumes').getPublicUrl(mine).data.publicUrl;
  const publicFetch = await fetch(publicUrl);
  check(
    'the file is NOT readable without a session',
    !publicFetch.ok,
    `HTTP ${publicFetch.status}`
  );

  if (SECRET_KEY) {
    const admin = createClient(API_URL, SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const adminRead = await admin.storage.from('resumes').download(mine);
    check('the server can read it to parse it', !adminRead.error, adminRead.error?.message ?? '');
  }
}

async function cleanup() {
  // Storage objects go through the Storage API: storage-api installs a
  // protect_delete() trigger that refuses a direct DELETE on storage.objects.
  // Each step gets its own try, because failing to remove a file must not take
  // the throwaway auth user's deletion down with it and leak the user.
  const admin = SECRET_KEY
    ? createClient(API_URL, SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

  for (const id of created) {
    if (admin) {
      try {
        const { data } = await admin.storage.from('resumes').list(id);
        const paths = (data ?? []).map((o) => `${id}/${o.name}`);
        if (paths.length > 0) await admin.storage.from('resumes').remove(paths);
      } catch {
        /* best effort */
      }
    }
    try {
      sql(`delete from auth.users where id = '${id}'`);
    } catch {
      /* best effort */
    }
  }
}

main()
  .then(cleanup, async (error) => {
    console.error('\nFATAL:', error.message);
    await cleanup();
    process.exit(1);
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
  });
