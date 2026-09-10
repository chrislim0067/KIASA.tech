/**
 * One canonical URL normalizer, proven across every ingestion path.
 *
 *   npm run test:dedupe
 *
 * Pure. No network, no database.
 *
 * WHY THIS FILE EXISTS
 *
 * There were two normalizers. `lib/jobs/url.ts` backs the database's
 * `md5(canonical_url)` uniqueness constraint; `lib/agent/job-url.ts` had its
 * own, which stripped a trailing slash from a bare origin, sorted parameters
 * differently and removed a slightly different tracking list.
 *
 * That is not a cosmetic disagreement. In THIS system a duplicate job row
 * becomes a second real application, to the same employer, in the candidate's
 * name, minutes after the first. So the agent module now delegates, and this
 * suite exists to keep it delegating: every assertion below is checked through
 * BOTH entry points, and they must agree exactly.
 *
 * A test that only checked one path would pass happily while the other drifted
 * — which is precisely how the divergence survived two milestones.
 */
import path from 'node:path';

let passed = 0;
let failed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

const JOBS = await import('../lib/jobs/url.ts');
const AGENT = await import('../lib/agent/job-url.ts');

/** The canonical form via the intake path (lib/jobs). */
const viaJobs = (u) => {
  const r = JOBS.canonicaliseUrl(u);
  return r.ok ? r.value.canonical : `REJECTED:${r.reason}`;
};

/** The canonical form via the agent path (lib/agent), which adds SSRF policy. */
const viaAgent = (u) => {
  const r = AGENT.validateJobUrl(u);
  return r.ok ? r.canonical : `REJECTED:${r.reason}`;
};

section('1. Equivalent spellings collapse to ONE canonical form');

/*
 * Each group is the SAME posting written differently. Every member must
 * produce one identical key, or the candidate applies twice.
 */
const EQUIVALENT = [
  {
    what: 'tracking parameters',
    urls: [
      'https://boards.greenhouse.io/acme/jobs/4001',
      'https://boards.greenhouse.io/acme/jobs/4001?utm_source=linkedin',
      'https://boards.greenhouse.io/acme/jobs/4001?utm_source=x&utm_medium=y&utm_campaign=z',
      'https://boards.greenhouse.io/acme/jobs/4001?gclid=abc123',
      'https://boards.greenhouse.io/acme/jobs/4001?fbclid=xyz',
      'https://boards.greenhouse.io/acme/jobs/4001?ref=newsletter',
      'https://boards.greenhouse.io/acme/jobs/4001?trk=public_jobs',
    ],
  },
  {
    what: 'a fragment',
    urls: [
      'https://boards.greenhouse.io/acme/jobs/4002',
      'https://boards.greenhouse.io/acme/jobs/4002#apply',
      'https://boards.greenhouse.io/acme/jobs/4002#app-form-section',
    ],
  },
  {
    what: 'host case',
    urls: [
      'https://boards.greenhouse.io/acme/jobs/4003',
      'https://BOARDS.GREENHOUSE.IO/acme/jobs/4003',
      'https://Boards.Greenhouse.Io/acme/jobs/4003',
    ],
  },
  {
    what: 'the default port',
    urls: [
      'https://boards.greenhouse.io/acme/jobs/4004',
      'https://boards.greenhouse.io:443/acme/jobs/4004',
    ],
  },
  {
    what: 'query parameter order',
    urls: [
      'https://jobs.example.com/role?a=1&b=2&c=3',
      'https://jobs.example.com/role?c=3&b=2&a=1',
      'https://jobs.example.com/role?b=2&c=3&a=1',
    ],
  },
  {
    what: 'a trailing slash on a deep path',
    urls: ['https://jobs.example.com/role', 'https://jobs.example.com/role/'],
  },
  {
    what: 'everything at once',
    urls: [
      'https://jobs.example.com/role?id=7',
      'https://JOBS.example.com:443/role/?utm_source=a&id=7&gclid=b#apply',
    ],
  },
];

for (const { what, urls } of EQUIVALENT) {
  const jobsKeys = new Set(urls.map(viaJobs));
  const agentKeys = new Set(urls.map(viaAgent));
  check(`${what}: ${urls.length} spellings -> one key via lib/jobs`,
    jobsKeys.size === 1, [...jobsKeys].join(' | '));
  check(`  ${what}: -> one key via lib/agent`,
    agentKeys.size === 1, [...agentKeys].join(' | '));
  check(`  ${what}: BOTH PATHS AGREE`,
    jobsKeys.size === 1 && agentKeys.size === 1 && [...jobsKeys][0] === [...agentKeys][0],
    `${[...jobsKeys][0]} vs ${[...agentKeys][0]}`);
}

section('2. Genuinely different postings stay different');

/*
 * The mirror image, and the more dangerous direction to get wrong. Merging two
 * real postings loses an application silently; storing a duplicate at least
 * shows up. Anything that could identify a posting is preserved.
 */
const DISTINCT = [
  ['https://boards.greenhouse.io/acme/jobs/4001', 'https://boards.greenhouse.io/acme/jobs/4002',
    'a different job id'],
  ['https://jobs.example.com/role?gh_jid=1', 'https://jobs.example.com/role?gh_jid=2',
    'a vendor job id parameter is NOT tracking noise'],
  ['https://jobs.example.com/Role', 'https://jobs.example.com/role',
    'path case, which many ATS hosts treat as significant'],
  ['https://jobs.example.com/role', 'https://www.jobs.example.com/role',
    'www is not guaranteed to be the same server'],
  ['https://a.example.com/role', 'https://b.example.com/role', 'a different host'],
  ['https://jobs.example.com/role?id=7', 'https://jobs.example.com/role?id=8',
    'a different id value'],
];

for (const [a, b, why] of DISTINCT) {
  check(`kept apart (${why})`, viaJobs(a) !== viaJobs(b), `${viaJobs(a)} vs ${viaJobs(b)}`);
  check(`  and via lib/agent`, viaAgent(a) !== viaAgent(b));
}

section('3. A retry cannot create a second job');

{
  // The exact shape of a real retry: the candidate pastes, it times out, they
  // paste again from a different context that appended a tracking parameter.
  const first = 'https://boards.greenhouse.io/acme/jobs/5000';
  const retry = 'https://boards.greenhouse.io/acme/jobs/5000?utm_source=retry&utm_medium=email';
  check('a retried submission with tracking noise dedupes to the first',
    AGENT.jobDedupeKey(first) === AGENT.jobDedupeKey(retry),
    AGENT.jobDedupeKey(first));
  check('  and matches what the intake path would store',
    AGENT.jobDedupeKey(first) === viaJobs(first));
  check('  three retries, still one key',
    new Set([first, retry, `${first}#apply`].map((u) => AGENT.jobDedupeKey(u))).size === 1);
}

section('4. jobDedupeKey is defensive about un-normalised input');

check('a raw URL is normalised rather than hashed as given',
  AGENT.jobDedupeKey('https://JOBS.example.com/role/?utm_source=x') ===
    AGENT.jobDedupeKey('https://jobs.example.com/role'));
check('an unparseable URL returns null, never a key',
  AGENT.jobDedupeKey('not a url') === null);
check('an empty string returns null', AGENT.jobDedupeKey('') === null);

section('5. The agent path still refuses what the intake path would accept');

/*
 * Delegating canonicalisation must NOT have delegated away the SSRF policy.
 * lib/jobs/url.ts answers "which posting is this"; it does not answer "may we
 * go there", and it accepts plenty this layer must refuse.
 */
const AGENT_ONLY_REFUSALS = [
  ['http://jobs.example.com/role', 'scheme_not_https', 'plain http'],
  ['https://127.0.0.1/x', 'loopback', 'loopback'],
  ['https://169.254.169.254/latest/meta-data/', 'link_local', 'cloud metadata'],
  ['https://10.0.0.5/x', 'private_network', 'a private range'],
  ['https://jobs.example.com:8080/x', 'port_not_allowed', 'a non-443 port'],
  ['https://localhost/x', 'reserved_tld', 'a reserved TLD'],
];
for (const [url, reason, why] of AGENT_ONLY_REFUSALS) {
  const agent = AGENT.validateJobUrl(url);
  check(`agent refuses ${why}`, !agent.ok && agent.reason === reason,
    agent.ok ? 'ACCEPTED' : agent.reason);
}
check('  and the intake canonicaliser accepts http, as designed',
  JOBS.canonicaliseUrl('http://jobs.example.com/role').ok,
  'it answers a different question; both answers are needed');

section('6. ATS identification survives the delegation');

{
  const r = AGENT.validateJobUrl('https://boards.greenhouse.io/acme/jobs/4001');
  check('the agent path now reports the ATS vendor', r.ok && r.atsVendor !== null, String(r.atsVendor));
  check('  and the external job id', r.ok && r.externalJobId !== null, String(r.externalJobId));
  const direct = JOBS.canonicaliseUrl('https://boards.greenhouse.io/acme/jobs/4001');
  check('  identical to the intake path',
    r.ok && direct.ok && r.atsVendor === direct.value.atsVendor &&
      r.externalJobId === direct.value.externalJobId);
}

section('7. There is only one tracking-parameter list');

{
  const src = (await import('node:fs')).readFileSync(
    path.join(path.resolve(import.meta.dirname, '..'), 'lib', 'agent', 'job-url.ts'), 'utf8');
  check('lib/agent/job-url.ts no longer defines its own',
    !/STRIPPED_PARAMS|utm_/.test(src),
    'two lists drift, and a drifted list is a duplicate job row');
  check('  and it imports the one normalizer',
    /canonicaliseUrl/.test(src) && /lib\/jobs\/url/.test(src));
}

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} JOB-DEDUPLICATION CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
