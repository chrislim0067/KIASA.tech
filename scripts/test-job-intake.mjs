/**
 * Job-intake database behaviour: RLS, isolation, dedupe, immutability, the
 * state machine and the audit log.
 *
 *   supabase start && node scripts/test-job-intake.mjs
 *
 * Runs against the LOCAL stack only, through the publishable key as an ordinary
 * signed-in user, exercising the shipped `lib/jobs` layer. No service-role key,
 * no network: the fetch stage is driven by a fixture fetcher.
 *
 * Exits non-zero on any failure.
 */
import { execFileSync } from 'node:child_process';

import { statusEnvRaw } from './lib/supabase-cli.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { jobs, REPO_ROOT } from './support/load-profile-layer.mjs';

const require = createRequire(path.join(REPO_ROOT, 'package.json'));
const { createClient } = require('@supabase/supabase-js');

function localEnv() {
  const raw = statusEnvRaw({ cwd: REPO_ROOT });
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\r]*)"?/);
    if (m) env[m[1]] = m[2];
  }
  const url = env.API_URL;
  const key = env.PUBLISHABLE_KEY || env.ANON_KEY;
  if (!url || !key) throw new Error('Local Supabase is not running (supabase start).');
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    throw new Error(`Refusing to run against a non-local API URL: ${url}`);
  }
  return { url, key };
}

const { url: API_URL, key: PUBLISHABLE_KEY } = localEnv();
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';
const sql = (statement) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement],
    { encoding: 'utf8' }).trim();

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function checkError(name, result, category, code) {
  const got = result.ok ? '(succeeded)' : `${result.error.category}/${result.error.code}`;
  const want = code ? `${category}/${code}` : category;
  const ok = !result.ok && result.error.category === category && (!code || result.error.code === code);
  check(name, ok, ok ? want : `expected ${want}, got ${got}`);
}

const cp = (n) => String.fromCodePoint(n);
const newClient = () => createClient(API_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function makeUser(label) {
  const client = newClient();
  const { data, error } = await client.auth.signUp({
    email: `ji-${label}-${randomUUID()}@example.test`,
    password: randomBytes(18).toString('base64url'),
  });
  if (error) throw new Error(`signUp failed for ${label}: ${error.message}`);
  if (!data.session) throw new Error('No session returned; local confirmations must be off.');
  return { client, id: data.user.id, actor: { type: 'human', id: data.user.id } };
}

const A = await makeUser('a');
const B = await makeUser('b');
const anon = newClient();

/** A fetcher that returns canned pages. Never touches the network. */
const fixtureFetcher = (pages) => ({
  async fetch(url) {
    const entry = pages[url];
    if (!entry) {
      return { outcome: 'gone', httpStatus: 404, finalUrl: url, contentType: null,
        byteSize: 0, contentHash: null, body: null, reason: 'http_404' };
    }
    const body = entry.body ?? null;
    return {
      outcome: entry.outcome ?? 'ok',
      httpStatus: entry.status ?? 200,
      finalUrl: url,
      // Honoured from the fixture so a JSON payload is not described as HTML.
      contentType: entry.contentType ?? 'text/html',
      byteSize: body ? Buffer.byteLength(body, 'utf8') : 0,
      contentHash: body ? require('node:crypto').createHash('sha256').update(body).digest('hex') : null,
      body,
      reason: entry.reason ?? null,
    };
  },
});

const POSTING = {
  '@context': 'https://schema.org', '@type': 'JobPosting',
  title: 'Senior Software Engineer',
  hiringOrganization: { '@type': 'Organization', name: 'Acme Corporation' },
  description: 'Build things.',
  employmentType: 'FULL_TIME',
};
const GOOD_PAGE = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(POSTING)}</script></head><body></body></html>`;
const JOB_URL = 'https://boards.greenhouse.io/acme/jobs/4711';

/* ------------------------------------------------------ 1. submission */

section('1. Submission and deduplication');
let jobId = null;
{
  const first = await jobs.submitJob(A.client, A.id, { url: JOB_URL }, A.actor);
  check('a job can be submitted', first.ok, first.ok ? '' : first.error.message);
  check('  it is not reported as a duplicate', first.ok && first.data.deduplicated === false);
  check('  status starts at received', first.ok && first.data.job.status === 'received');
  check('  the ATS vendor is derived from the URL', first.ok && first.data.job.ats_vendor === 'greenhouse');
  check('  the external id is derived from the URL', first.ok && first.data.job.external_job_id === '4711');
  check('  the submitted URL is stored verbatim', first.ok && first.data.job.submitted_url === JOB_URL);
  jobId = first.ok ? first.data.job.id : null;

  // Trivially different forms that canonicalise identically must not create a
  // second job.
  const variants = [
    ['tracking parameters', `${JOB_URL}?utm_source=newsletter&utm_medium=email`],
    ['a fragment', `${JOB_URL}#apply-now`],
    ['host casing', 'https://BOARDS.GREENHOUSE.IO/acme/jobs/4711'],
    ['a trailing slash', `${JOB_URL}/`],
    ['the default port', 'https://boards.greenhouse.io:443/acme/jobs/4711'],
  ];
  for (const [label, variant] of variants) {
    const again = await jobs.submitJob(A.client, A.id, { url: variant }, A.actor);
    check(`re-submitting with ${label} is deduplicated`,
      again.ok && again.data.deduplicated === true && again.data.job.id === jobId,
      again.ok ? `${again.data.deduplicated}` : again.error.message);
  }
  check('only one job row exists',
    sql(`select count(*) from public.jobs where user_id='${A.id}'`) === '1',
    sql(`select count(*) from public.jobs where user_id='${A.id}'`));

  // A genuinely different posting must NOT be merged into the first.
  const other = await jobs.submitJob(A.client, A.id, { url: 'https://boards.greenhouse.io/acme/jobs/4712' }, A.actor);
  check('a different job id creates a separate row', other.ok && other.data.deduplicated === false
    && other.data.job.id !== jobId);
  check('now two job rows exist', sql(`select count(*) from public.jobs where user_id='${A.id}'`) === '2');

  // Concurrent submissions of the same URL must converge on one row.
  const C = await makeUser('c');
  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () => jobs.submitJob(C.client, C.id, { url: JOB_URL }, C.actor)),
  );
  check('6 concurrent submissions all succeed', concurrent.every((r) => r.ok),
    `${concurrent.filter((r) => !r.ok).length} failed`);
  check('  and produce exactly one row',
    sql(`select count(*) from public.jobs where user_id='${C.id}'`) === '1',
    sql(`select count(*) from public.jobs where user_id='${C.id}'`));
  check('  all agree on the same job id',
    new Set(concurrent.filter((r) => r.ok).map((r) => r.data.job.id)).size === 1);
  sql(`delete from auth.users where id='${C.id}'`);

  // Bad URLs are refused before anything is stored.
  for (const [label, url, code] of [
    ['a non-http scheme', 'ftp://example.com/j', 'url_unsupported_scheme'],
    ['a javascript: URL', 'javascript:alert(1)', 'url_unsupported_scheme'],
    ['nonsense', 'not a url', 'url_not_a_url'],
    ['credentials in the URL', 'https://u:p@example.com/j', 'url_credentials_in_url'],
  ]) {
    const r = await jobs.submitJob(A.client, A.id, { url }, A.actor);
    checkError(`refuses ${label}`, r, 'invalid_input', code);
  }
}

/* --------------------------------------------------- 2. the audit log */

section('2. Every action writes exactly one attributable event');
{
  const events = await jobs.listEvents(A.client, A.id, jobId);
  check('events can be read', events.ok, events.ok ? '' : events.error.message);
  const list = events.ok ? events.data : [];
  check('the first event is the submission', list[0]?.event_type === 'submitted', list[0]?.event_type);
  check('  attributed to a human', list[0]?.actor_type === 'human', list[0]?.actor_type);
  check('  carrying the acting user id', list[0]?.actor_id === A.id);
  check('the five deduplications were recorded',
    list.filter((e) => e.event_type === 'deduplicated').length === 5,
    `${list.filter((e) => e.event_type === 'deduplicated').length}`);

  // An event may not claim to be a different human.
  const forged = await jobs.submitJob(A.client, A.id, { url: 'https://example.com/x' },
    { type: 'human', id: B.id });
  checkError('an actor claiming another human is refused', forged, 'forbidden', 'actor_mismatch');
  const anonymousHuman = await jobs.submitJob(A.client, A.id, { url: 'https://example.com/y' },
    { type: 'human' });
  checkError('a human actor without an id is refused', anonymousHuman, 'invalid_input', 'actor_id_required');
}

/* ------------------------------------------------- 3. the state machine */

section('3. State machine: legal transitions, illegal ones fail loudly');
{
  const legal = await jobs.transitionJob(A.client, A.id, jobId, 'fetching', A.actor);
  check('received -> fetching succeeds', legal.ok && legal.data.status === 'fetching',
    legal.ok ? legal.data.status : legal.error.message);

  const before = (await jobs.listEvents(A.client, A.id, jobId)).data.length;
  const noop = await jobs.transitionJob(A.client, A.id, jobId, 'fetching', A.actor);
  check('a no-op transition succeeds (resumable)', noop.ok);
  const after = (await jobs.listEvents(A.client, A.id, jobId)).data.length;
  check('  and writes NO event', after === before, `${before} -> ${after}`);

  for (const [from, to] of [['fetching', 'extracted'], ['fetching', 'received'], ['fetching', 'archived']]) {
    const bad = await jobs.transitionJob(A.client, A.id, jobId, to, A.actor);
    checkError(`illegal ${from} -> ${to} is refused`, bad, 'constraint_violation', 'illegal_transition');
  }
  check('the status is unchanged after the illegal attempts',
    sql(`select status from public.jobs where id='${jobId}'`) === 'fetching');

  // The DATABASE, not just the layer, must refuse — a client can PATCH directly.
  const direct = await A.client.from('jobs').update({ status: 'extracted' }).eq('id', jobId).select();
  check('a direct PostgREST PATCH of an illegal transition is refused by the trigger',
    Boolean(direct.error), direct.error ? `${direct.error.code}` : 'NOT REFUSED');
  check('  and the status is still unchanged',
    sql(`select status from public.jobs where id='${jobId}'`) === 'fetching');

  const settle = await jobs.transitionJob(A.client, A.id, jobId, 'fetched', A.actor);
  check('fetching -> fetched succeeds', settle.ok && settle.data.status === 'fetched');
  const events = await jobs.listEvents(A.client, A.id, jobId);
  const changes = events.data.filter((e) => e.event_type === 'status_changed');
  check('each real transition wrote exactly one status_changed event', changes.length === 2, `${changes.length}`);
  check('  recording from and to', changes[1].from_status === 'fetching' && changes[1].to_status === 'fetched',
    `${changes[1].from_status}->${changes[1].to_status}`);
}

/* ------------------------------------------- 4. fetch and extract stages */

section('4. Fetch and extraction stages');
let snapshotId = null;
{
  /*
   * A NEUTRAL HOST, BECAUSE THIS SECTION IS ABOUT THE HTML PATH.
   *
   * A Greenhouse URL is now read through the board's own public JSON endpoint
   * — see lib/jobs/vendor-api.ts — so using one here would exercise the API
   * path and none of the JSON-LD assertions below would apply. The API path has
   * its own block immediately after this one.
   */
  const PAGE_URL = 'https://careers.example.test/roles/9001';
  const fresh = await jobs.submitJob(A.client, A.id, { url: PAGE_URL }, A.actor);
  const id = fresh.data.job.id;
  const fetcher = fixtureFetcher({ [PAGE_URL]: { body: GOOD_PAGE } });

  const fetched = await jobs.fetchJob(A.client, A.id, id, fetcher, A.actor);
  check('fetchJob succeeds', fetched.ok, fetched.ok ? '' : fetched.error.message);
  check('  the job reaches fetched', fetched.ok && fetched.data.job.status === 'fetched');
  check('  a snapshot was stored', fetched.ok && fetched.data.snapshot.outcome === 'ok');
  check('  the body is stored byte-for-byte', fetched.ok && fetched.data.snapshot.body === GOOD_PAGE);
  check('  with a content hash', fetched.ok && /^[0-9a-f]{64}$/.test(fetched.data.snapshot.content_hash ?? ''));
  snapshotId = fetched.ok ? fetched.data.snapshot.id : null;

  const extracted = await jobs.extractJob(A.client, A.id, id, snapshotId, A.actor);
  check('extractJob succeeds', extracted.ok, extracted.ok ? '' : extracted.error.message);
  check('  the job reaches extracted', extracted.ok && extracted.data.job.status === 'extracted');
  check('  the title was extracted', extracted.ok && extracted.data.facts.title === 'Senior Software Engineer');
  check('  the company was extracted', extracted.ok && extracted.data.facts.company_name === 'Acme Corporation');
  check('  unstated salary is NULL', extracted.ok && extracted.data.facts.salary_min === null);
  check('  provenance names the method', extracted.ok
    && extracted.data.facts.field_provenance.title === 'json_ld',
    JSON.stringify(extracted.ok ? extracted.data.facts.field_provenance : {}).slice(0, 60));
  check('  the facts point at the snapshot', extracted.ok && extracted.data.facts.snapshot_id === snapshotId);

  // Re-extraction is idempotent: same row, same content, no duplicates.
  const again = await jobs.extractJob(A.client, A.id, id, snapshotId, A.actor);
  check('re-extraction succeeds', again.ok, again.ok ? '' : again.error.message);
  check('  and does not create a second facts row',
    sql(`select count(*) from public.job_facts where snapshot_id='${snapshotId}'`) === '1');
  check('  producing identical facts', again.ok && extracted.ok
    && again.data.facts.title === extracted.data.facts.title
    && again.data.facts.company_name === extracted.data.facts.company_name);

  /*
   * THE BOARD API PATH, END TO END.
   *
   * The fixture is keyed ONLY on the derived endpoint. If `fetchJob` asked for
   * the page URL instead, there would be no fixture entry and the fetch would
   * fail — so this passing is itself the proof that the derivation happened.
   */
  {
    const apiJob = await jobs.submitJob(
      A.client, A.id, { url: 'https://boards.greenhouse.io/acme/jobs/8800' }, A.actor);
    const apiId = apiJob.data.job.id;

    const payload = JSON.stringify({
      id: 8800,
      title: 'Staff Platform Engineer',
      location: { name: 'Singapore' },
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/8800',
      content: '&lt;p&gt;Build and run the platform.&lt;/p&gt;',
    });

    const apiFetcher = fixtureFetcher({
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs/8800': {
        body: payload, contentType: 'application/json',
      },
    });

    const apiFetched = await jobs.fetchJob(A.client, A.id, apiId, apiFetcher, A.actor);
    check('a Greenhouse job is fetched from the board API, not the page',
      apiFetched.ok, apiFetched.ok ? '' : apiFetched.error.message);
    check('  and the snapshot records the API as the final URL',
      apiFetched.ok && (apiFetched.data.snapshot.final_url ?? '').includes('boards-api.greenhouse.io'),
      apiFetched.ok ? String(apiFetched.data.snapshot.final_url) : '');

    if (apiFetched.ok) {
      const apiExtracted = await jobs.extractJob(
        A.client, A.id, apiId, apiFetched.data.snapshot.id, A.actor);
      check('  the JSON payload extracts', apiExtracted.ok,
        apiExtracted.ok ? '' : apiExtracted.error.message);
      check('  the title comes from the API',
        apiExtracted.ok && apiExtracted.data.facts.title === 'Staff Platform Engineer',
        apiExtracted.ok ? String(apiExtracted.data.facts.title) : '');
      check('  the description is decoded to text',
        apiExtracted.ok &&
          (apiExtracted.data.facts.description_text ?? '').includes('Build and run the platform'),
        apiExtracted.ok ? String(apiExtracted.data.facts.description_text) : '');
      /*
       * The endpoint does not state a company, and the board token is a slug
       * rather than a name. Null is the honest answer.
       */
      check('  and the company stays NULL rather than the board token',
        apiExtracted.ok && apiExtracted.data.facts.company_name === null,
        apiExtracted.ok ? String(apiExtracted.data.facts.company_name) : '');
    }
  }

  // A failed fetch still records evidence and parks the job.
  const bad = await jobs.submitJob(A.client, A.id, { url: 'https://boards.greenhouse.io/acme/jobs/9002' }, A.actor);
  const badFetch = await jobs.fetchJob(A.client, A.id, bad.data.job.id, fixtureFetcher({}), A.actor);
  check('a failed fetch is still a success at the layer', badFetch.ok, badFetch.ok ? '' : badFetch.error.message);
  check('  the job is parked at fetch_failed', badFetch.ok && badFetch.data.job.status === 'fetch_failed');
  check('  a snapshot records the failure', badFetch.ok && badFetch.data.snapshot.outcome === 'gone');
  check('  with no body', badFetch.ok && badFetch.data.snapshot.body === null);
  check('  and the status reason is machine-readable',
    badFetch.ok && badFetch.data.job.status_reason === 'gone', badFetch.ok ? String(badFetch.data.job.status_reason) : '');

  // Resumability: re-fetching an already-fetched job is safe.
  const snapsBefore = Number(sql(`select count(*) from public.job_snapshots where job_id='${id}'`));
  const refetch = await jobs.fetchJob(A.client, A.id, id, fetcher, A.actor);
  check('re-fetching an extracted job is safe', refetch.ok, refetch.ok ? '' : refetch.error.message);
  const snapsAfter = Number(sql(`select count(*) from public.job_snapshots where job_id='${id}'`));
  check('  it adds exactly one new snapshot', snapsAfter === snapsBefore + 1, `${snapsBefore} -> ${snapsAfter}`);
  check('  the earlier snapshot is still present',
    sql(`select count(*) from public.job_snapshots where id='${snapshotId}'`) === '1');
}

section('5. Extraction of a page with no structured data');
{
  const plain = await jobs.submitJob(A.client, A.id, { url: 'https://boards.greenhouse.io/acme/jobs/9003' }, A.actor);
  const id = plain.data.job.id;
  const fetched = await jobs.fetchJob(A.client, A.id, id,
    fixtureFetcher({ 'https://boards.greenhouse.io/acme/jobs/9003': { body: '<html><body>nothing</body></html>' } }), A.actor);
  const extracted = await jobs.extractJob(A.client, A.id, id, fetched.data.snapshot.id, A.actor);
  check('extraction completes without throwing', extracted.ok, extracted.ok ? '' : extracted.error.message);
  check('  the job is parked at extraction_incomplete',
    extracted.ok && extracted.data.job.status === 'extraction_incomplete');
  check('  with a machine-readable reason',
    extracted.ok && extracted.data.facts.extraction_reason === 'no_structured_data',
    extracted.ok ? String(extracted.data.facts.extraction_reason) : '');
  check('  and every fact NULL', extracted.ok && extracted.data.facts.title === null
    && extracted.data.facts.company_name === null);
}

/* ---------------------------------------------------- 6. immutability */

section('6. Snapshots and events are immutable');
{
  const update = await A.client.from('job_snapshots').update({ body: 'tampered' }).eq('id', snapshotId).select();
  check('updating a snapshot is refused', Boolean(update.error), update.error ? update.error.code : 'NOT REFUSED');
  check('  the body is unchanged',
    sql(`select left(body, 9) from public.job_snapshots where id='${snapshotId}'`) === '<!doctype');

  const events = await jobs.listEvents(A.client, A.id, jobId);
  const eventId = events.data[0].id;
  const eventUpdate = await A.client.from('job_events').update({ actor_type: 'system' }).eq('id', eventId).select();
  check('updating an event is refused', Boolean(eventUpdate.error), eventUpdate.error ? eventUpdate.error.code : 'NOT REFUSED');
  check('  the actor is unchanged',
    sql(`select actor_type from public.job_events where id='${eventId}'`) === 'human');

  const eventDelete = await A.client.from('job_events').delete().eq('id', eventId).select();
  const deleted = (eventDelete.data ?? []).length;
  check('deleting an event removes nothing', deleted === 0 || Boolean(eventDelete.error),
    eventDelete.error ? eventDelete.error.code : `${deleted} row(s)`);
  check('  the event still exists', sql(`select count(*) from public.job_events where id='${eventId}'`) === '1');

  // The immutability trigger holds even for a role that bypasses RLS.
  let ownerUpdateRefused = false;
  try {
    sql(`update public.job_snapshots set body='tampered' where id='${snapshotId}'`);
  } catch {
    ownerUpdateRefused = true;
  }
  check('even the table owner cannot update a snapshot', ownerUpdateRefused);
  check('  the body is still intact',
    sql(`select left(body, 9) from public.job_snapshots where id='${snapshotId}'`) === '<!doctype');
}

/* ------------------------------------------------- 7. isolation */

section('7. Cross-user isolation and anonymous access');
{
  await jobs.submitJob(B.client, B.id, { url: 'https://boards.greenhouse.io/other/jobs/1' }, B.actor);

  const bList = await jobs.listJobs(B.client, B.id);
  check("B's list excludes A's jobs", bList.ok && !bList.data.some((j) => j.id === jobId),
    `${bList.ok ? bList.data.length : '?'} rows`);

  const steal = await jobs.getJob(B.client, B.id, jobId);
  check("B cannot read A's job", steal.ok && steal.data === null, steal.ok ? String(steal.data) : steal.error.category);

  const hijack = await jobs.transitionJob(B.client, B.id, jobId, 'archived', B.actor);
  checkError("B cannot transition A's job", hijack, 'not_found', 'row_not_found');
  check("  A's job status is unchanged",
    sql(`select status from public.jobs where id='${jobId}'`) === 'fetched');

  const rawUpdate = await B.client.from('jobs').update({ status: 'archived' }).eq('id', jobId).select();
  check("a direct PATCH of A's job affects zero rows", (rawUpdate.data ?? []).length === 0,
    `${(rawUpdate.data ?? []).length} row(s)`);

  const rawDelete = await B.client.from('jobs').delete().eq('id', jobId).select();
  check("a direct DELETE of A's job affects zero rows", (rawDelete.data ?? []).length === 0);
  check('  the job still exists', sql(`select count(*) from public.jobs where id='${jobId}'`) === '1');

  for (const table of ['jobs', 'job_snapshots', 'job_facts', 'job_events']) {
    const read = await B.client.from(table).select('id').eq('user_id', A.id);
    check(`B sees no rows of A in ${table}`, (read.data ?? []).length === 0, `${(read.data ?? []).length}`);
  }

  // Row donation: writing another user's user_id.
  const donate = await B.client.from('jobs').insert({
    user_id: A.id, submitted_url: 'https://example.com/x', canonical_url: 'https://example.com/x', source: 'user_link',
  });
  check('row donation is refused', Boolean(donate.error), donate.error ? donate.error.code : 'NOT REFUSED');

  // The layer stamps the authenticated id, so a supplied user_id is ignored.
  const layerDonate = await jobs.submitJob(B.client, B.id, { url: 'https://example.com/donate' }, B.actor);
  check('the layer stamps the authenticated user_id',
    layerDonate.ok && layerDonate.data.job.user_id === B.id, layerDonate.ok ? layerDonate.data.job.user_id : '');

  for (const table of ['jobs', 'job_snapshots', 'job_facts', 'job_events']) {
    const read = await anon.from(table).select('id');
    check(`anon reads nothing from ${table}`, (read.data ?? []).length === 0,
      read.error ? read.error.code : `${(read.data ?? []).length} rows`);
  }
  // Either a hard denial or an empty result is acceptable; what matters is that
  // no data comes back. anon holds NO grant on these tables, so PostgREST
  // returns 42501 rather than filtering to zero rows — a stronger outcome than
  // the profile tables, where `authenticated` has grants and RLS does the work.
  const anonJob = await jobs.getJob(anon, A.id, jobId);
  const anonGotNothing = anonJob.ok ? anonJob.data === null : anonJob.error.category === 'forbidden';
  check('anon gets nothing through the layer', anonGotNothing,
    anonJob.ok ? `ok:${anonJob.data}` : `${anonJob.error.category}/${anonJob.error.code}`);

  const anonList = await jobs.listJobs(anon, A.id);
  const anonListEmpty = anonList.ok ? anonList.data.length === 0 : anonList.error.category === 'forbidden';
  check('anon lists nothing through the layer', anonListEmpty,
    anonList.ok ? `${anonList.data.length} rows` : `${anonList.error.category}`);

  const anonSubmit = await jobs.submitJob(anon, A.id, { url: 'https://example.com/anon' }, { type: 'system' });
  check('anon cannot submit a job', !anonSubmit.ok, anonSubmit.ok ? 'SUBMITTED' : anonSubmit.error.category);
}

/* --------------------------------------- 8. constraints on new columns */

section('8. The existing blank/invisible rules apply to the new columns');
{
  // A snapshot that has no facts row yet, so the (user_id, snapshot_id) unique
  // constraint cannot mask the constraint actually under test.
  const s = sql(`select id from public.job_snapshots
                 where user_id='${A.id}'
                   and id not in (select snapshot_id from public.job_facts where user_id='${A.id}')
                 limit 1`);
  const j = sql(`select job_id from public.job_snapshots where id='${s}'`);
  check('a facts-free snapshot was found for these cases', s.length === 36, s);
  for (const [label, value] of [
    ['a tab-only title', cp(0x0009)],
    ['a ZWSP-only title', cp(0x200b)],
    ['a BOM-only title', cp(0xfeff)],
    ['an empty title', ''],
  ]) {
    const r = await A.client.from('job_facts').insert({
      user_id: A.id, job_id: j, snapshot_id: s, title: value, extraction_status: 'extracted',
    });
    check(`job_facts rejects ${label}`, r.error?.code === '23514', r.error ? r.error.code : 'ACCEPTED');
  }
  const good = await A.client.from('job_facts').insert({
    user_id: A.id, job_id: j, snapshot_id: s,
    title: cp(0x00a0) + 'Senior Engineer', extraction_status: 'extracted',
  }).select();
  check('a leading NBSP with visible text is accepted', !good.error, good.error?.message ?? '');
  check('  and stored byte-for-byte',
    good.data?.[0]?.title === cp(0x00a0) + 'Senior Engineer',
    JSON.stringify(good.data?.[0]?.title));

  // Only http(s) URLs may be stored.
  const badUrl = await A.client.from('jobs').insert({
    user_id: A.id, submitted_url: 'javascript:alert(1)', canonical_url: 'javascript:alert(1)', source: 'user_link',
  });
  check('a javascript: URL is refused by the CHECK', badUrl.error?.code === '23514',
    badUrl.error ? badUrl.error.code : 'ACCEPTED');
}

/* --------------------------------------------------------- cleanup */

section('9. Cleanup');
for (const user of [A, B]) sql(`delete from auth.users where id = '${user.id}'`);
const leftover = sql(`select count(*) from public.jobs where user_id in ('${A.id}','${B.id}')`);
check('jobs removed by cascade', leftover === '0', `${leftover} row(s) left`);
const eventsLeft = sql(`select count(*) from public.job_events where user_id in ('${A.id}','${B.id}')`);
check('events removed by cascade (erasure still works)', eventsLeft === '0', `${eventsLeft} row(s) left`);

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0 ? `ALL ${passed} JOB-INTAKE CHECKS PASSED` : `${failed} FAILED of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
