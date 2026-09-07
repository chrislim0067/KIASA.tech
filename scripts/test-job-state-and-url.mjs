/**
 * State-machine parity, status classification and URL canonicalisation.
 *
 *   node scripts/test-job-state-and-url.mjs
 *
 * No database and no network: these are pure functions plus a parse of the
 * migration file. The parity section is the important one — the legal-transition
 * table exists in BOTH `lib/jobs/state.ts` and the migration-13 trigger, and the
 * database is the authority. This asserts the two are identical in both
 * directions, so a change to one without the other fails here rather than
 * letting the layer and the database quietly disagree.
 *
 * Exits non-zero on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { jobs, REPO_ROOT } from './support/load-profile-layer.mjs';

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ------------------------------- 1. transition parity: TypeScript vs SQL */

section('1. Legal transitions match the migration-13 trigger exactly');

const MIGRATION = path.join(REPO_ROOT, 'supabase', 'migrations', '20260907000013_job_intake_rls_and_guards.sql');
const sqlText = fs.readFileSync(MIGRATION, 'utf8');

const block = /legal constant text\[\] := array\[([\s\S]*?)\];/.exec(sqlText);
check('the legal-transition array was found in the migration', block !== null);
if (!block) {
  console.log('\nCannot continue without the SQL transition table.');
  process.exit(1);
}
// Strip SQL comments so a commented-out example can never be read as a rule.
const sqlSet = [...block[1].replace(/--[^\n]*/g, '').matchAll(/'([a-z_]+>[a-z_]+)'/g)].map((m) => m[1]);
const tsSet = [...jobs.LEGAL_TRANSITIONS];

check('SQL declares at least one transition', sqlSet.length > 0, `${sqlSet.length}`);
check('SQL set has no duplicates', new Set(sqlSet).size === sqlSet.length, `${sqlSet.length} entries`);
check('TypeScript set has no duplicates', new Set(tsSet).size === tsSet.length, `${tsSet.length} entries`);
check('the two sets are the same size', sqlSet.length === tsSet.length, `sql=${sqlSet.length} ts=${tsSet.length}`);

const missingInTs = sqlSet.filter((t) => !tsSet.includes(t));
const extraInTs = tsSet.filter((t) => !sqlSet.includes(t));
check('every SQL transition exists in TypeScript', missingInTs.length === 0, missingInTs.join(',') || 'none missing');
check('every TypeScript transition exists in SQL', extraInTs.length === 0, extraInTs.join(',') || 'none extra');

// Both sides must only reference statuses the CHECK constraint allows.
const statuses = [...jobs.JOB_STATUSES];
const unknown = [...new Set(sqlSet.flatMap((t) => t.split('>')))].filter((s) => !statuses.includes(s));
check('every status named in a transition is in the vocabulary', unknown.length === 0, unknown.join(',') || 'none');

section('2. canTransition agrees with the parsed SQL table for every pair');
{
  // Every ordered pair is compared, and the agreements are COUNTED. Reporting a
  // count rather than "no mismatches found" means an empty or unparsed SQL set
  // cannot make this section pass vacuously.
  const disagreements = [];
  let compared = 0;
  for (const from of statuses) {
    for (const to of statuses) {
      compared++;
      const expected = from === to ? true : sqlSet.includes(`${from}>${to}`);
      if (jobs.canTransition(from, to) !== expected) {
        disagreements.push(`${from}>${to} (ts=${jobs.canTransition(from, to)} sql=${expected})`);
      }
    }
  }
  check(`all ${statuses.length}x${statuses.length} status pairs were compared`,
    compared === statuses.length * statuses.length, `${compared}`);
  check('no pair disagrees with SQL', disagreements.length === 0,
    disagreements.slice(0, 4).join('; ') || 'all agree');

  // Independently count the legal non-identity pairs the TypeScript side
  // reports, and require it to equal the SQL table's size.
  let legalPairs = 0;
  for (const from of statuses) {
    for (const to of statuses) if (from !== to && jobs.canTransition(from, to)) legalPairs++;
  }
  check('the number of legal non-identity transitions matches SQL', legalPairs === sqlSet.length,
    `ts=${legalPairs} sql=${sqlSet.length}`);
}

section('3. Status classification is derivable from the status alone');
{
  const expected = {
    received: 'actionable', fetched: 'actionable', extracted: 'actionable',
    fetching: 'in_progress', extracting: 'in_progress',
    fetch_failed: 'parked', extraction_incomplete: 'parked',
    archived: 'terminal',
  };
  for (const status of statuses) {
    check(`${status} classifies as ${expected[status]}`, jobs.classifyStatus(status) === expected[status],
      jobs.classifyStatus(status));
  }
  check('every status is classified', statuses.every((s) => expected[s] !== undefined));
  check('archived is terminal — nothing leaves it', jobs.nextStatuses('archived').length === 0,
    jobs.nextStatuses('archived').join(','));
  check('a no-op transition is allowed (resumability)', jobs.canTransition('fetching', 'fetching'));
  check('received cannot jump straight to extracted', !jobs.canTransition('received', 'extracted'));
  check('fetch_failed cannot jump to extracted', !jobs.canTransition('fetch_failed', 'extracted'));
  check('isJobStatus rejects an unknown value', !jobs.isJobStatus('made_up'));
  check('isJobStatus accepts a real value', jobs.isJobStatus('received'));
}

/* ------------------------------------------ 4. URL canonicalisation */

section('4. URL canonicalisation');
{
  const canon = (u) => {
    const r = jobs.canonicaliseUrl(u);
    return r.ok ? r.value.canonical : `REJECTED:${r.reason}`;
  };

  // Pairs that MUST collapse to the same job.
  const same = [
    ['tracking parameters removed',
      'https://boards.greenhouse.io/acme/jobs/123?utm_source=x&utm_medium=y',
      'https://boards.greenhouse.io/acme/jobs/123'],
    ['fragment removed',
      'https://boards.greenhouse.io/acme/jobs/123#apply',
      'https://boards.greenhouse.io/acme/jobs/123'],
    ['host case normalised',
      'https://BOARDS.Greenhouse.IO/acme/jobs/123',
      'https://boards.greenhouse.io/acme/jobs/123'],
    ['trailing slash removed',
      'https://boards.greenhouse.io/acme/jobs/123/',
      'https://boards.greenhouse.io/acme/jobs/123'],
    ['default https port removed',
      'https://boards.greenhouse.io:443/acme/jobs/123',
      'https://boards.greenhouse.io/acme/jobs/123'],
    ['query parameter order normalised',
      'https://example.com/job?b=2&a=1',
      'https://example.com/job?a=1&b=2'],
    ['gclid and fbclid removed',
      'https://example.com/job?gclid=abc&fbclid=def',
      'https://example.com/job'],
  ];
  for (const [label, a, b] of same) {
    const ca = canon(a);
    const cb = canon(b);
    check(`${label}: collapses`, ca === cb, `${ca}  vs  ${cb}`);
  }

  // Pairs that MUST NOT be merged. Over-normalising silently merges two
  // different postings, which is worse than storing a duplicate.
  const different = [
    ['different job ids', 'https://boards.greenhouse.io/acme/jobs/123', 'https://boards.greenhouse.io/acme/jobs/124'],
    ['path case preserved', 'https://example.com/Job/ABC', 'https://example.com/job/abc'],
    ['www is not the bare host', 'https://www.example.com/job', 'https://example.com/job'],
    ['http is not https', 'http://example.com/job', 'https://example.com/job'],
    ['meaningful query kept', 'https://example.com/j?gh_jid=1', 'https://example.com/j?gh_jid=2'],
    ['different hosts', 'https://a.example.com/job', 'https://b.example.com/job'],
    ['non-default port kept', 'https://example.com:8443/job', 'https://example.com/job'],
  ];
  for (const [label, a, b] of different) {
    check(`${label}: stays distinct`, canon(a) !== canon(b), `${canon(a)}  vs  ${canon(b)}`);
  }

  // Rejections.
  for (const [label, url, reason] of [
    ['a non-http scheme', 'ftp://example.com/job', 'unsupported_scheme'],
    ['a javascript: URL', 'javascript:alert(1)', 'unsupported_scheme'],
    ['a file: URL', 'file:///etc/passwd', 'unsupported_scheme'],
    ['a data: URL', 'data:text/html,<h1>x</h1>', 'unsupported_scheme'],
    ['nonsense', 'not a url at all', 'not_a_url'],
    ['an empty string', '', 'not_a_url'],
    ['credentials in the URL', 'https://user:pw@example.com/job', 'credentials_in_url'],
    ['an over-long URL', `https://example.com/${'x'.repeat(2100)}`, 'too_long'],
  ]) {
    const r = jobs.canonicaliseUrl(url);
    check(`rejects ${label}`, !r.ok && r.reason === reason, r.ok ? 'ACCEPTED' : r.reason);
  }

  // The submitted form is preserved byte-for-byte alongside the canonical one.
  {
    const messy = 'https://BOARDS.Greenhouse.IO/acme/jobs/123/?utm_source=x#apply';
    const r = jobs.canonicaliseUrl(messy);
    check('the submitted URL is preserved unmodified', r.ok && r.value.submitted === messy,
      r.ok ? r.value.submitted : r.reason);
  }

  // Determinism.
  {
    const u = 'https://example.com/job?b=2&a=1&utm_source=z';
    check('canonicalisation is deterministic', canon(u) === canon(u) && canon(u) === canon(u));
  }
}

section('5. ATS identification is structural, never guessed');
{
  const id = (u) => {
    const r = jobs.canonicaliseUrl(u);
    return r.ok ? `${r.value.atsVendor ?? 'null'}/${r.value.externalJobId ?? 'null'}` : `REJECTED`;
  };
  const cases = [
    ['https://boards.greenhouse.io/acme/jobs/4567', 'greenhouse/4567'],
    ['https://jobs.lever.co/acme/2b1c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e', 'lever/2b1c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e'],
    ['https://jobs.ashbyhq.com/acme/2b1c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e', 'ashby/2b1c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e'],
    ['https://www.linkedin.com/jobs/view/senior-engineer-3812345678', 'linkedin/3812345678'],
    ['https://www.indeed.com/viewjob?jk=abc123def456', 'indeed/abc123def456'],
    // Unrecognised host: BOTH null. Nothing is invented from a numeric segment.
    ['https://careers.unknown-company.example/openings/12345', 'null/null'],
    // Recognised vendor, but the path does not state an id in the documented
    // shape, so the id stays null rather than being scraped out of the path.
    ['https://boards.greenhouse.io/acme/jobs/not-a-number', 'greenhouse/null'],
  ];
  for (const [url, expected] of cases) {
    check(`${new URL(url).hostname} -> ${expected}`, id(url) === expected, id(url));
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0 ? `ALL ${passed} STATE AND URL CHECKS PASSED` : `${failed} FAILED of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
