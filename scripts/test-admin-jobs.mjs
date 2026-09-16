/**
 * The administrator job board — what crosses the boundary out of a database
 * this repository does not own.
 *
 *   npm run test:jobs:board
 *
 * WHAT THIS IS FOR
 *
 * `/admin/jobs` reads `saved_jobs` from a SECOND Supabase project, with that
 * project's secret key, on behalf of an administrator who holds no session
 * there. Three things follow, and this file exists to hold all three in place:
 *
 *   * The schema belongs to another repository and can change without this one
 *     being told. Every row therefore passes through one projection that names
 *     its fields, and a row of any shape — a status outside the CHECK, a
 *     numeric that arrived as a string, a null where an array was promised —
 *     must produce a safe summary rather than a blank page.
 *   * A private note is the owner's own scratch about an employer. Its
 *     EXISTENCE reaches the list; its TEXT must not, and only a job somebody
 *     deliberately opened may show it.
 *   * KIASA does not own this data. Nothing here writes, and no credential for
 *     that project may reach a browser — not through a client component, and
 *     not through the live stream.
 *
 * Entirely offline. There is no local stack for the job board project, no
 * migration in this tree that creates `saved_jobs`, and none is needed: the
 * question is what the projection does with a row, and a stub can hand it the
 * malformed row a healthy database never would. See
 * `scripts/lib/jobboard-supabase-stub.mjs`.
 */
import { registerHooks } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const url = (...parts) => pathToFileURL(path.join(ROOT, ...parts)).href;
const STUB = url('scripts', 'lib', 'jobboard-supabase-stub.mjs');

/**
 * The job board's Supabase client is resolved to the stub, and that has to
 * happen before anything imports `lib/jobboard/queries.ts`.
 *
 * Synchronous hooks in this thread rather than a second `register()` on the
 * loader thread: the stub must be the same module instance the checks below
 * configure, and registering it here keeps that obvious.
 * `scripts/lib/node-hooks.mjs` is deliberately left alone — every other suite
 * shares it, and none of them should lose the real client because this one
 * stubs it.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@supabase/supabase-js') return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

let passed = 0;
let failed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(label, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');
/** Source with its comments removed, so no check can pass on prose. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');

/**
 * A distinctive secret. Nothing this suite prints or throws may contain it, and
 * the configuration checks assert exactly that.
 */
const SECRET = 'sb_secret_TESTONLY_dGhpcy1tdXN0LW5ldmVyLWJlLXByaW50ZWQ';
const BOARD_URL = 'https://jobboard.test.supabase.co';

process.env.JOBBOARD_SUPABASE_URL = BOARD_URL;
process.env.JOBBOARD_SUPABASE_SECRET_KEY = SECRET;

const stub = await import(STUB);
const { listSavedJobs, getSavedJob } = await import(url('lib', 'jobboard', 'queries.ts'));
const { JOB_STATUSES, JOB_STATUS_LABELS, JOB_SUMMARY_COLUMNS, JOB_DETAIL_COLUMNS, isJobStatus } =
  await import(url('lib', 'jobboard', 'types.ts'));
const { formatSalary, formatExperience, relativeDate, formatDate, hostOf, seniorityOf, humanise } =
  await import(url('lib', 'jobboard', 'format.ts'));
const { missingJobBoardEnv, isJobBoardConfigured, requireJobBoardEnv, JobBoardConfigError } =
  await import(url('lib', 'jobboard', 'env.ts'));

/** A row with something wrong in every field the projection has to survive. */
const HOSTILE_ROW = {
  /* A bigint identity arrives as a number, not the string the UI keys on. */
  id: 7,
  user_id: 'owner-1',
  fingerprint: null,
  url: null,
  domain: null,
  /* Present but empty is absence, not an empty string. */
  provider: '',
  provider_job_id: '',
  title: 'Staff Engineer',
  company: 'Acme',
  company_logo_url: null,
  location: 'Singapore',
  /* A valid workplace in the wrong case is not a valid workplace. */
  workplace_type: 'REMOTE',
  employment_type: 'full_time',
  /* A numeric that came back as a string. */
  salary_min: '120000',
  salary_max: null,
  salary_currency: 'USD',
  salary_period: 'year',
  experience_min_years: 'about five',
  experience_max_years: 'Infinity',
  /* Null where an array was promised. */
  skills: null,
  sponsorship_available: 'yes',
  security_clearance_required: false,
  extraction_confidence: '0.82',
  /* Outside the CHECK constraint this repository cannot see. */
  status: 'ghosted',
  saved_at: undefined,
  updated_at: undefined,
  notes: '  Recruiter said comp is negotiable  ',
};

/* ==================================================================== */
section('1. Configuration is named, never printed');

{
  const savedUrl = process.env.JOBBOARD_SUPABASE_URL;
  const savedSecret = process.env.JOBBOARD_SUPABASE_SECRET_KEY;

  delete process.env.JOBBOARD_SUPABASE_URL;
  delete process.env.JOBBOARD_SUPABASE_SECRET_KEY;

  check(
    'an unconfigured deployment reports both variables',
    missingJobBoardEnv().join(',') === 'JOBBOARD_SUPABASE_URL,JOBBOARD_SUPABASE_SECRET_KEY',
    missingJobBoardEnv().join(',')
  );
  check('  and does not claim to be configured', isJobBoardConfigured() === false);

  let thrown = null;
  try {
    requireJobBoardEnv();
  } catch (error) {
    thrown = error;
  }
  check(
    'requiring it throws a typed error naming what is absent',
    thrown instanceof JobBoardConfigError && thrown.missing.length === 2,
    thrown ? `${thrown.name}: ${thrown.missing?.join(',')}` : 'nothing was thrown'
  );
  check(
    '  and the message says these may never be public',
    /NEXT_PUBLIC_/.test(thrown?.message ?? ''),
    (thrown?.message ?? '').slice(0, 80)
  );

  /*
   * THE POINT OF THIS BLOCK. An error about a missing variable is written into
   * logs and, on a page, onto a screen. It may name the variable that is
   * absent; it may never carry the value of the one that is present.
   */
  process.env.JOBBOARD_SUPABASE_SECRET_KEY = savedSecret;
  let partial = null;
  try {
    requireJobBoardEnv();
  } catch (error) {
    partial = error;
  }
  check(
    'with only the URL missing, only the URL is named',
    partial?.missing?.join(',') === 'JOBBOARD_SUPABASE_URL',
    partial?.missing?.join(',')
  );
  check(
    '  and the secret that IS set never appears in the message',
    !(partial?.message ?? '').includes(SECRET),
    'an error is a log line and a screen'
  );

  process.env.JOBBOARD_SUPABASE_URL = savedUrl;
  check('a configured deployment reports nothing missing', isJobBoardConfigured() === true);
  const resolved = requireJobBoardEnv();
  check(
    '  and hands back exactly what was set',
    resolved.url === BOARD_URL && resolved.secret === SECRET
  );

  /* Neither is public — not in this module, not in the file operators copy. */
  check(
    'neither variable is read from a NEXT_PUBLIC_ name',
    !/NEXT_PUBLIC_JOBBOARD/.test(read('lib', 'jobboard', 'env.ts')),
    'a NEXT_PUBLIC_ value is inlined into the browser bundle at build time'
  );
  check(
    '  and .env.example does not offer one',
    !/NEXT_PUBLIC_JOBBOARD/.test(read('.env.example')) &&
      /^JOBBOARD_SUPABASE_SECRET_KEY=/m.test(read('.env.example'))
  );
}

/* ==================================================================== */
section('2. A row of any shape becomes a summary the UI can render');

{
  stub.reset({ rows: [HOSTILE_ROW], users: [{ id: 'owner-1', email: 'owner@example.test' }] });
  const { jobs, error, truncated } = await listSavedJobs();
  const job = jobs[0];

  check('the hostile row was read at all', error === null && jobs.length === 1, String(error));
  check('  and nothing was reported as truncated', truncated === false);

  check('a numeric id becomes the string the UI keys on', job.id === '7', JSON.stringify(job.id));
  check(
    'an unrecognised status degrades to saved rather than crashing the list',
    job.status === 'saved' && isJobStatus(job.status),
    String(job.status)
  );
  check(
    'a workplace in the wrong case is not a workplace',
    job.workplace_type === null,
    String(job.workplace_type)
  );
  check(
    'a numeric that arrived as a string becomes a number',
    job.salary_min === 120000,
    JSON.stringify(job.salary_min)
  );
  check(
    '  and one that is not a number becomes null',
    job.experience_min_years === null,
    JSON.stringify(job.experience_min_years)
  );
  check(
    '  and Infinity does not get through either',
    job.experience_max_years === null,
    JSON.stringify(job.experience_max_years)
  );
  check(
    'a decimal confidence survives as a number',
    job.extraction_confidence === 0.82,
    JSON.stringify(job.extraction_confidence)
  );
  check(
    'null where an array was promised becomes an empty array',
    Array.isArray(job.skills) && job.skills.length === 0,
    JSON.stringify(job.skills)
  );
  check(
    'a non-boolean is not read as a boolean',
    job.sponsorship_available === null,
    JSON.stringify(job.sponsorship_available)
  );
  check(
    '  but a real false stays false',
    job.security_clearance_required === false,
    JSON.stringify(job.security_clearance_required)
  );
  check(
    'an empty string is absence, not an empty value',
    job.provider === null && job.provider_job_id === null,
    `${JSON.stringify(job.provider)} / ${JSON.stringify(job.provider_job_id)}`
  );
  check(
    'a missing timestamp gets a sortable one rather than undefined',
    job.saved_at === new Date(0).toISOString() && job.updated_at === job.saved_at,
    String(job.saved_at)
  );
  check(
    'the owner is resolved to an email',
    job.owner_email === 'owner@example.test',
    String(job.owner_email)
  );

  /* Zero is a value. A salary of 0 is not a missing salary. */
  stub.reset({ rows: [{ ...HOSTILE_ROW, salary_min: 0, extraction_confidence: 0 }] });
  const zeroed = (await listSavedJobs()).jobs[0];
  check(
    'zero survives as zero rather than collapsing to null',
    zeroed.salary_min === 0 && zeroed.extraction_confidence === 0,
    `${JSON.stringify(zeroed.salary_min)} / ${JSON.stringify(zeroed.extraction_confidence)}`
  );

  /* A mixed array keeps the strings and drops the rest. */
  stub.reset({ rows: [{ ...HOSTILE_ROW, skills: ['Go', 42, null, 'Postgres', { a: 1 }] }] });
  const mixed = (await listSavedJobs()).jobs[0];
  check(
    'a mixed skills array keeps only its strings',
    JSON.stringify(mixed.skills) === '["Go","Postgres"]',
    JSON.stringify(mixed.skills)
  );

  /* Every lowercase workplace the UI filters on is accepted. */
  for (const workplace of ['remote', 'hybrid', 'onsite']) {
    stub.reset({ rows: [{ ...HOSTILE_ROW, workplace_type: workplace }] });
    const row = (await listSavedJobs()).jobs[0];
    check(`  ${workplace} is read as itself`, row.workplace_type === workplace, String(row.workplace_type));
  }

  /* And every status in the CHECK constraint survives as itself. */
  for (const status of JOB_STATUSES) {
    stub.reset({ rows: [{ ...HOSTILE_ROW, status }] });
    const row = (await listSavedJobs()).jobs[0];
    check(`  the status ${status} survives as itself`, row.status === status, String(row.status));
  }
  check(
    'every status has a label for its board column',
    JOB_STATUSES.every((s) => typeof JOB_STATUS_LABELS[s] === 'string')
  );
  check('  and the label table cannot be edited at runtime', Object.isFrozen(JOB_STATUS_LABELS));
  check(
    'a status outside the list is rejected by the guard',
    !isJobStatus('ghosted') && !isJobStatus(null) && !isJobStatus(7) && isJobStatus('offer')
  );
}

/* ==================================================================== */
section('3. The projection names its fields, and the select matches it');

{
  stub.reset({ rows: [HOSTILE_ROW] });
  const job = (await listSavedJobs()).jobs[0];

  const selected = JOB_SUMMARY_COLUMNS.split(',');
  const projected = Object.keys(job);
  /* Derived on the server rather than selected: neither is a column. */
  const derived = ['has_notes', 'owner_email'];

  check(
    'the list asked for exactly the summary columns',
    stub.seen.queries[0].columns === JOB_SUMMARY_COLUMNS,
    String(stub.seen.queries[0].columns).slice(0, 60)
  );
  check(
    '  from saved_jobs and nothing else',
    stub.seen.queries.every((q) => q.table === 'saved_jobs'),
    stub.seen.queries.map((q) => q.table).join(',')
  );

  /*
   * THE DRIFT GUARD. A field added to the projection without being selected
   * renders as undefined; a column selected without being projected is a column
   * nobody decided to show. The one column allowed to be selected and not
   * projected is `notes`, which exists solely so `has_notes` can be derived.
   */
  const unselected = projected.filter((k) => !derived.includes(k) && !selected.includes(k));
  check(
    'every projected field is a column the query actually selects',
    unselected.length === 0,
    unselected.join(',') || 'none'
  );

  const unprojected = selected.filter((c) => !projected.includes(c));
  check(
    '  and the only column selected but not projected is the note',
    unprojected.join(',') === 'notes',
    unprojected.join(',') || 'none'
  );

  check(
    'the detail query adds the long-form columns to the same set',
    JOB_DETAIL_COLUMNS.startsWith(JOB_SUMMARY_COLUMNS) &&
      [
        'description',
        'responsibilities',
        'required_qualifications',
        'preferred_qualifications',
        'applied_at',
      ].every((c) => JOB_DETAIL_COLUMNS.split(',').includes(c))
  );
  check(
    '  while the list does NOT ask for the description',
    !selected.includes('description'),
    'several kilobytes a row, for text the list never shows'
  );
}

/* ==================================================================== */
section("4. A note's existence crosses to the browser; its text does not");

{
  const NOTE = 'Recruiter said comp is negotiable';

  stub.reset({ rows: [HOSTILE_ROW] });
  const { jobs } = await listSavedJobs();

  check('a job with a note reports that it has one', jobs[0].has_notes === true);
  check(
    '  and the summary carries no notes field at all',
    !('notes' in jobs[0]),
    Object.keys(jobs[0]).filter((k) => /note/i.test(k)).join(',') || 'none'
  );
  check(
    '  and the text appears nowhere in what reaches the client',
    !JSON.stringify(jobs).includes(NOTE),
    'the list is scanned in bulk; a note is the owner’s private scratch'
  );

  for (const [label, notes] of [
    ['no note', null],
    ['whitespace only', '   \n\t '],
    ['an empty string', ''],
    ['a non-string', 42],
  ]) {
    stub.reset({ rows: [{ ...HOSTILE_ROW, notes }] });
    const row = (await listSavedJobs()).jobs[0];
    check(`  ${label} is not a note`, row.has_notes === false, String(row.has_notes));
  }

  /* Opening one job is a deliberate act, and that is where the text lives. */
  stub.reset({ rows: [HOSTILE_ROW] });
  const detail = await getSavedJob('7');
  check(
    'opening a single job DOES show the note',
    detail?.notes === HOSTILE_ROW.notes,
    JSON.stringify(detail?.notes)
  );
  const queries = code(read('lib', 'jobboard', 'queries.ts'));
  const lines = queries.split('\n');
  const readsNotes = lines.map((l, i) => [l, i]).filter(([l]) => /row\.notes/.test(l));
  check(
    '  and the column is read on exactly two lines of the query module',
    readsNotes.length === 2,
    `${readsNotes.length} line(s)`
  );

  /*
   * One of those two lines derives the boolean; the other returns the text, and
   * it must live inside `getSavedJob` — the function that answers about a
   * single job somebody opened, never the one that answers about all of them.
   */
  const detailAt = lines.findIndex((l) => /export async function getSavedJob/.test(l));
  const returnsText = readsNotes.filter(([l]) => /^\s*notes:/.test(l));
  check(
    '  and the one that returns the text sits inside getSavedJob',
    detailAt > 0 && returnsText.length === 1 && returnsText[0][1] > detailAt,
    `notes text at line ${returnsText[0]?.[1]}, getSavedJob at ${detailAt}`
  );
}

/* ==================================================================== */
section('5. The list is bounded, ordered, and admits when it is cut');

{
  const many = (count) =>
    Array.from({ length: count }, (_, i) => ({ ...HOSTILE_ROW, id: i, notes: null }));

  stub.reset({ rows: many(501) });
  const over = await listSavedJobs();
  check('501 rows are cut to 500', over.jobs.length === 500, String(over.jobs.length));
  check('  and the page is told it was cut', over.truncated === true);
  check(
    '  which was learned from one extra row, not a second count query',
    stub.seen.queries[0].limit === 501 && stub.seen.queries.length === 1,
    `limit ${stub.seen.queries[0].limit}, ${stub.seen.queries.length} query/queries`
  );

  stub.reset({ rows: many(500) });
  const exact = await listSavedJobs();
  check(
    'exactly 500 rows is not a truncation',
    exact.jobs.length === 500 && exact.truncated === false,
    String(exact.truncated)
  );

  stub.reset({ rows: [] });
  const none = await listSavedJobs();
  check(
    'an empty board is an empty list, not an error',
    none.jobs.length === 0 && none.error === null && none.truncated === false
  );

  stub.reset({ rows: many(3) });
  const three = await listSavedJobs();
  check(
    'the database decides the order, not the projection',
    three.jobs.map((j) => j.id).join(',') === '0,1,2',
    three.jobs.map((j) => j.id).join(',')
  );
  check(
    '  and it was asked for newest first',
    stub.seen.queries[0].order?.column === 'saved_at' &&
      stub.seen.queries[0].order?.ascending === false,
    JSON.stringify(stub.seen.queries[0].order)
  );
}

/* ==================================================================== */
section('6. Failure degrades; it does not blank the page');

{
  stub.reset({ error: 'permission denied for table saved_jobs' });
  const denied = await listSavedJobs();
  check(
    'a query failure returns no rows and says why',
    denied.jobs.length === 0 && denied.error === 'permission denied for table saved_jobs',
    String(denied.error)
  );
  check('  and does not claim a truncation on top of it', denied.truncated === false);

  stub.reset({ throwAt: 'createClient' });
  const unreachable = await listSavedJobs();
  check(
    'an unreachable project is caught rather than thrown at the page',
    unreachable.jobs.length === 0 && typeof unreachable.error === 'string',
    String(unreachable.error)
  );

  /*
   * THE DIRECTORY IS NOT THE BOARD. Owner emails come from the auth admin API,
   * a separate call to a separate service. When it fails the board still
   * renders — a name nobody could look up is worth less than the list of jobs
   * the page exists to show.
   */
  stub.reset({ rows: [HOSTILE_ROW], usersError: 'service unavailable' });
  const noDirectory = await listSavedJobs();
  check(
    'a failed owner lookup still renders the jobs',
    noDirectory.jobs.length === 1 && noDirectory.error === null
  );
  check(
    '  with the owner simply unknown',
    noDirectory.jobs[0].owner_email === null,
    String(noDirectory.jobs[0].owner_email)
  );

  stub.reset({ rows: [HOSTILE_ROW], throwAt: 'listUsers' });
  const threwDirectory = await listSavedJobs();
  check(
    'a thrown owner lookup does the same',
    threwDirectory.jobs.length === 1 && threwDirectory.jobs[0].owner_email === null
  );

  stub.reset({ rows: [HOSTILE_ROW], users: [{ id: 'someone-else', email: 'other@example.test' }] });
  const stranger = await listSavedJobs();
  check(
    'an owner missing from the directory is not given somebody else’s email',
    stranger.jobs[0].owner_email === null,
    String(stranger.jobs[0].owner_email)
  );

  stub.reset({
    rows: [HOSTILE_ROW],
    users: [
      { id: 'owner-1', email: null },
      { id: null, email: 'x@example.test' },
    ],
  });
  const halfRow = await listSavedJobs();
  check(
    '  nor is a directory entry that has no email',
    halfRow.jobs[0].owner_email === null,
    String(halfRow.jobs[0].owner_email)
  );
}

/* ==================================================================== */
section('7. One job, fetched by an id that cannot steer the query');

{
  stub.reset({
    rows: [
      {
        ...HOSTILE_ROW,
        description: 'Build things.',
        responsibilities: ['Ship', 7, null],
        required_qualifications: null,
        preferred_qualifications: ['Postgres'],
        applied_at: '2026-09-01T00:00:00.000Z',
      },
    ],
    users: [{ id: 'owner-1', email: 'owner@example.test' }],
  });

  const detail = await getSavedJob('7');
  check(
    'the detail carries the summary through unchanged',
    detail?.id === '7' && detail?.status === 'saved' && detail?.owner_email === 'owner@example.test'
  );
  check('  plus the long-form text', detail?.description === 'Build things.');
  check(
    '  with list fields coerced the same way',
    JSON.stringify(detail?.responsibilities) === '["Ship"]' &&
      JSON.stringify(detail?.required_qualifications) === '[]',
    `${JSON.stringify(detail?.responsibilities)} / ${JSON.stringify(detail?.required_qualifications)}`
  );
  check('  and asked for the detail columns', stub.seen.queries[0].columns === JOB_DETAIL_COLUMNS);

  /*
   * An id comes off the URL. It is handed to `.eq()`, which PostgREST binds as
   * a parameter rather than interpolating — so the crafted value below must
   * arrive at the boundary untouched, and must never appear inside the query it
   * was used in.
   */
  const CRAFTED = "7' or '1'='1";
  stub.reset({ rows: [] });
  await getSavedJob(CRAFTED);
  const query = stub.seen.queries[0];
  check(
    'a crafted id is passed as a bound value, not spliced into the query',
    query.eq.length === 1 && query.eq[0][0] === 'id' && query.eq[0][1] === CRAFTED,
    JSON.stringify(query.eq)
  );
  check(
    '  and nothing of it reaches the column list',
    !String(query.columns).includes("'"),
    String(query.columns).slice(0, 40)
  );
  check('  and it is read as at most one row', query.single === true);

  stub.reset({ rows: [] });
  check(
    'an id that matches nothing is null, for the page to turn into a 404',
    (await getSavedJob('missing')) === null
  );

  stub.reset({ error: 'permission denied' });
  check('  as is a failed read', (await getSavedJob('7')) === null);

  stub.reset({ throwAt: 'createClient' });
  check('  as is an unreachable project', (await getSavedJob('7')) === null);
}

/* ==================================================================== */
section('8. Read-only, and server-side, by construction');

{
  const sources = new Map(
    readdirSync(path.join(ROOT, 'lib', 'jobboard')).map((f) => [f, code(read('lib', 'jobboard', f))])
  );

  /*
   * KIASA does not own these rows: the extension writes them and their owner
   * controls them. A write appearing anywhere in this directory is a product
   * decision about acting on someone else's pipeline, not a refactor, and it
   * should fail here first.
   */
  for (const [file, source] of sources) {
    check(
      `${file} contains no write`,
      !/\.(?:insert|update|upsert|delete)\s*\(/.test(source) && !/\.rpc\s*\(/.test(source),
      'reading is the whole contract with this project'
    );
  }

  check(
    'the privileged client is server-only',
    /^import 'server-only';/m.test(read('lib', 'jobboard', 'client.ts')),
    'a build failure, not a convention'
  );
  check(
    '  and so is every query that uses it',
    /^import 'server-only';/m.test(read('lib', 'jobboard', 'queries.ts'))
  );
  check(
    '  while the display helpers deliberately are not',
    !/server-only/.test(sources.get('format.ts')),
    'the list, the board and the detail page all render these'
  );

  /*
   * The prose in env.ts names NEXT_PUBLIC_ on purpose, to say these may never
   * carry it. What must not exist is a READ of one, which is what would be
   * inlined into the browser bundle at build time.
   */
  check(
    'nothing in lib/jobboard reads a NEXT_PUBLIC_ variable',
    [...sources.values()].every((s) => !/process\.env\.NEXT_PUBLIC_/.test(s))
  );

  /*
   * And no client component may reach the credential, even transitively. Naming
   * a variable in help text is fine — the empty board does exactly that, to say
   * which project the extension should be writing to. Importing the module that
   * reads it, or reading it directly, is not.
   */
  for (const file of readdirSync(path.join(ROOT, 'components', 'admin', 'jobs'))) {
    const source = code(read('components', 'admin', 'jobs', file));
    check(
      `components/admin/jobs/${file} reaches no privileged module`,
      !/@\/lib\/jobboard\/(?:client|queries|env)/.test(source) &&
        !/process\.env\.JOBBOARD/.test(source) &&
        !/JOBBOARD_SUPABASE_SECRET_KEY/.test(source),
      'types and format only'
    );
  }

  const client = code(read('lib', 'jobboard', 'client.ts'));
  check(
    'the client is built per call, not held at module scope',
    /export function createJobBoardClient\(\)/.test(client) &&
      !/^const \w+ = createSupabaseClient\(/m.test(client),
    'a module-level client throws during prerender wherever the key is absent'
  );
  check(
    '  and the secret key is never persisted as a session',
    /persistSession: false/.test(client) && /autoRefreshToken: false/.test(client)
  );

  /* What the stub actually observed: the secret went to the server-side client. */
  stub.reset({ rows: [] });
  await listSavedJobs();
  check(
    'the client was handed the configured project and key',
    stub.seen.clients.length > 0 &&
      stub.seen.clients.every((c) => c.url === BOARD_URL && c.key === SECRET),
    `${stub.seen.clients.length} client(s)`
  );
}

/* ==================================================================== */
section('9. The live stream carries an operation, never a row');

{
  const route = code(read('app', 'api', 'admin', 'jobs', 'stream', 'route.ts'));

  check(
    'the guard runs before the credential is built',
    route.indexOf('guardApi(') !== -1 &&
      route.indexOf('guardApi(') < route.indexOf('createJobBoardClient('),
    'authorization is not something the stream gets to do later'
  );
  check(
    '  and a failed guard returns before anything else happens',
    /if \(!guard\.ok\) return guard\.response;/.test(route)
  );
  check(
    '  with configuration checked only after authorization',
    route.indexOf('guardApi(') < route.indexOf('isJobBoardConfigured('),
    'an anonymous caller learns nothing about this deployment'
  );

  /*
   * THE PROPERTY THE WHOLE RELAY EXISTS FOR. A connection is held open for
   * hours. If a row crossed it, that stream would be a slow leak of other
   * people's postings into browser memory, proxy buffers and logs. The only
   * thing read off a change payload is which operation it was.
   */
  const payloadReads = [...route.matchAll(/payload\.(\w+)/g)].map((m) => m[1]);
  check(
    'nothing is read off a change payload but the operation',
    payloadReads.length > 0 && payloadReads.every((field) => field === 'eventType'),
    payloadReads.join(',') || 'none'
  );
  check('  so no row, new or old, is on the wire', !/payload\.(?:new|old|record|errors)/.test(route));

  check(
    'the stream is never stored on the way to the browser',
    /'Cache-Control': 'no-store/.test(route) && /'X-Accel-Buffering': 'no'/.test(route)
  );
  check('it runs on Node, where a WebSocket client exists', /export const runtime = 'nodejs';/.test(route));
  check(
    '  and is neither cached nor statically rendered',
    /export const dynamic = 'force-dynamic';/.test(route)
  );
  check(
    'it tells EventSource how soon to come back',
    /retry: 3000/.test(route),
    'a recycled stream is the reconnection strategy'
  );
  check(
    'the relay subscribes and never queries',
    !/\.(?:insert|update|upsert|delete)\s*\(/.test(route) && !/\.from\(/.test(route),
    'the page does the reading, under its own guard'
  );

  /*
   * And the browser end cannot be taught to trust a payload that is not there.
   * `router.refresh()` re-runs the same authorized server query that painted
   * the page, so one code path decides what a job looks like.
   */
  const live = code(read('components', 'admin', 'jobs', 'JobsLive.tsx'));
  check(
    'the client parses nothing off the event',
    !/JSON\.parse\(/.test(live) && /addEventListener\('change', \(\) =>/.test(live),
    'the change listener takes no event argument at all'
  );
  check('  and reacts by re-running the server query', /routerRef\.current\.refresh\(\)/.test(live));

  /*
   * THE RECONNECT LOOP THIS PREVENTS. `router.refresh()` updates the router
   * context, so an effect that closed over `router` would tear the EventSource
   * down and rebuild it on every refresh — refresh, reconnect, flap, refresh.
   */
  check(
    'the subscription effect closes over nothing that changes on render',
    !/\brouter\.refresh\(\)/.test(live) && /\}, \[\]\);/.test(live),
    'everything mutable is reached through a ref'
  );

  const onerror = live.match(/source\.onerror = \(\)[\s\S]*?\n\s*\};/);
  check(
    '  and an error does not permanently close a stream the server merely recycled',
    onerror !== null && !/close\(/.test(onerror[0]),
    onerror ? 'handler found' : 'the onerror handler could not be located'
  );
}

/* ==================================================================== */
section('10. Display: absent stays absent');

{
  const salary = (min, max, currency, period) =>
    formatSalary({
      salary_min: min,
      salary_max: max,
      salary_currency: currency,
      salary_period: period,
    });

  check(
    'no salary prints nothing, not a placeholder',
    salary(null, null, 'USD', 'year') === null,
    String(salary(null, null, 'USD', 'year'))
  );
  check(
    'a single figure is compact and suffixed',
    salary(120000, null, 'USD', 'year') === '$120k/yr',
    String(salary(120000, null, 'USD', 'year'))
  );
  check(
    'a range reads as a range',
    salary(80000, 120000, 'EUR', 'year') === 'EUR 80k–120k/yr',
    String(salary(80000, 120000, 'EUR', 'year'))
  );
  check(
    'equal ends are one figure, not a range',
    salary(90000, 90000, 'USD', 'year') === '$90k/yr',
    String(salary(90000, 90000, 'USD', 'year'))
  );
  check(
    'small numbers are not forced into thousands',
    salary(50, null, 'USD', 'hour') === '$50/hr',
    String(salary(50, null, 'USD', 'hour'))
  );
  check(
    'a period nobody has a suffix for is simply omitted',
    salary(120000, null, 'USD', 'fortnight') === '$120k',
    String(salary(120000, null, 'USD', 'fortnight'))
  );
  check(
    '  as is a currency that was never stated',
    salary(120000, null, null, null) === '120k',
    String(salary(120000, null, null, null))
  );

  const exp = (min, max) => formatExperience({ experience_min_years: min, experience_max_years: max });
  check('no experience prints nothing', exp(null, null) === null, String(exp(null, null)));
  check('a floor reads as a floor', exp(5, null) === '5+ years', String(exp(5, null)));
  check('a band reads as a band', exp(3, 5) === '3–5 years', String(exp(3, 5)));

  const ago = (ms) => relativeDate(new Date(Date.now() - ms).toISOString());
  check('today is today', ago(60_000) === 'today', ago(60_000));
  check('yesterday is named, not counted', ago(26 * 3_600_000) === 'yesterday', ago(26 * 3_600_000));
  check('a few days are days', ago(3 * 86_400_000) === '3 days ago', ago(3 * 86_400_000));
  check('a fortnight is weeks', ago(14 * 86_400_000) === '2w ago', ago(14 * 86_400_000));
  check('a year is years', ago(400 * 86_400_000) === '1y ago', ago(400 * 86_400_000));
  check(
    'an unreadable date prints nothing at all',
    relativeDate('not a date') === '',
    JSON.stringify(relativeDate('not a date'))
  );

  check('an absent date is an em dash', formatDate(null) === '—', formatDate(null));
  check('  as is an unreadable one', formatDate('not a date') === '—', formatDate('not a date'));
  check(
    'a real date is written out',
    /^\d{2} \w{3} \d{4}$/.test(formatDate('2026-09-01T00:00:00.000Z')),
    formatDate('2026-09-01T00:00:00.000Z')
  );

  check(
    'a host drops www',
    hostOf('https://www.example.test/jobs/1') === 'example.test',
    hostOf('https://www.example.test/jobs/1')
  );
  check('  and nonsense is not a host', hostOf('not a url') === '', JSON.stringify(hostOf('not a url')));

  /*
   * Seniority is DERIVED from the title, so it may only ever report a word the
   * title actually contains — never a level the posting did not claim.
   */
  check('a stated seniority is read', seniorityOf('Senior Software Engineer') === 'Senior');
  check(
    '  and the strongest word wins',
    seniorityOf('Principal Staff Engineer') === 'Principal',
    String(seniorityOf('Principal Staff Engineer'))
  );
  check(
    'a title that states no level asserts none',
    seniorityOf('Software Engineer') === null,
    String(seniorityOf('Software Engineer'))
  );
  check(
    '  and a word that merely contains one does not count',
    seniorityOf('Seniority Programme Lead') === 'Lead',
    '"Lead" is in the title; "Seniority" is not "Senior"'
  );
  check('  nor does an absent title', seniorityOf(null) === null);

  check('an enum reads as words', humanise('full_time') === 'full time', String(humanise('full_time')));
  check('  and nothing stays nothing', humanise(null) === null);
}

console.log(`\n${'='.repeat(56)}`);
if (failed === 0) {
  console.log(`ALL ${passed} ADMIN-JOB-BOARD CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
