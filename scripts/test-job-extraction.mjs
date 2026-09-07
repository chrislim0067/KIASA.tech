/**
 * Deterministic extraction.
 *
 *   node scripts/test-job-extraction.mjs
 *
 * Pure functions over fixture markup: no database, no network. The point of
 * these tests is less "does it find the title" and more the two rules that keep
 * KIASA honest:
 *
 *   1. A field the page does not state comes back NULL. Never inferred from
 *      prose, never defaulted, never guessed from the title.
 *   2. Published text is stored byte-for-byte — no trimming, no whitespace
 *      collapsing, no case folding — the same rule the database enforces for
 *      candidate data.
 *
 * Non-ASCII fixture content is built from numeric code points so the file stays
 * pure ASCII on disk and cannot be weakened by an editor that trims whitespace.
 *
 * Exits non-zero on any failure.
 */
import { jobs } from './support/load-profile-layer.mjs';

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const cp = (n) => String.fromCodePoint(n);
const NBSP = cp(0x00a0);
const ZWSP = cp(0x200b);

const page = (head, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const ldJson = (object) => `<script type="application/ld+json">${JSON.stringify(object)}</script>`;

const COMPLETE_POSTING = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Senior Software Engineer',
  description: 'Build things that matter.',
  identifier: { '@type': 'PropertyValue', name: 'req', value: 'REQ-4711' },
  datePosted: '2026-08-01',
  validThrough: '2026-12-31T23:59:59Z',
  employmentType: 'FULL_TIME',
  hiringOrganization: { '@type': 'Organization', name: 'Acme Corporation' },
  jobLocation: {
    '@type': 'Place',
    address: { '@type': 'PostalAddress', addressLocality: 'London', addressRegion: 'England', addressCountry: 'GB' },
  },
  jobLocationType: 'TELECOMMUTE',
  baseSalary: {
    '@type': 'MonetaryAmount',
    currency: 'GBP',
    value: { '@type': 'QuantitativeValue', minValue: 70000, maxValue: 95000, unitText: 'YEAR' },
  },
  url: 'https://acme.example.com/careers/4711',
};

/* --------------------------------------------- 1. a complete JSON-LD page */

section('1. Complete JSON-LD extracts every field');
{
  const result = jobs.extractJobFacts(page(ldJson(COMPLETE_POSTING)));
  check('status is extracted', result.status === 'extracted', result.status);
  check('no reason is recorded on success', result.reason === null, String(result.reason));

  const expected = {
    title: 'Senior Software Engineer',
    company_name: 'Acme Corporation',
    location_raw: 'London, England, GB',
    employment_type: 'FULL_TIME',
    date_posted: '2026-08-01',
    salary_min: 70000,
    salary_max: 95000,
    salary_currency: 'GBP',
    salary_period: 'annual',
    remote_type: 'remote',
    description_text: 'Build things that matter.',
    apply_url: 'https://acme.example.com/careers/4711',
    identifier: 'REQ-4711',
  };
  for (const [field, value] of Object.entries(expected)) {
    check(`${field} = ${JSON.stringify(value)}`, result.facts[field] === value, JSON.stringify(result.facts[field]));
  }
  check('valid_through parsed to an instant', typeof result.facts.valid_through === 'string'
    && result.facts.valid_through.startsWith('2026-12-31'), String(result.facts.valid_through));

  check('every extracted field records its method',
    Object.keys(expected).every((f) => result.provenance[f] === 'json_ld'),
    JSON.stringify(result.provenance).slice(0, 90));
  check('provenance has no entry for an unextracted field',
    !('nonexistent_field' in result.provenance));
}

/* ------------------------------------------ 2. absent fields stay NULL */

section('2. A field the page does not state is NULL, never guessed');
{
  const minimal = {
    '@context': 'https://schema.org', '@type': 'JobPosting',
    title: 'Backend Engineer',
    hiringOrganization: { '@type': 'Organization', name: 'Tiny Co' },
  };
  const result = jobs.extractJobFacts(page(ldJson(minimal)));
  check('the stated fields are present', result.facts.title === 'Backend Engineer'
    && result.facts.company_name === 'Tiny Co');

  const mustBeNull = [
    'location_raw', 'employment_type', 'date_posted', 'valid_through',
    'salary_min', 'salary_max', 'salary_currency', 'salary_period',
    'remote_type', 'apply_url', 'identifier',
  ];
  for (const field of mustBeNull) {
    check(`${field} is NULL when unstated`, result.facts[field] === null, JSON.stringify(result.facts[field]));
  }
  check('unstated fields have no provenance entry',
    mustBeNull.every((f) => !(f in result.provenance)), Object.keys(result.provenance).join(','));
}

section('3. Nothing is inferred from prose');
{
  // A description that mentions remote work, a salary and a seniority level.
  // None of it is structured data, so none of it may be extracted.
  const prose = {
    '@context': 'https://schema.org', '@type': 'JobPosting',
    title: 'Engineer',
    description: 'This is a fully remote, senior, full-time role paying 100000 GBP per year.',
  };
  const result = jobs.extractJobFacts(page(ldJson(prose)));
  check('remote_type is NOT inferred from the description', result.facts.remote_type === null,
    String(result.facts.remote_type));
  check('salary is NOT inferred from the description', result.facts.salary_min === null
    && result.facts.salary_max === null && result.facts.salary_currency === null);
  check('employment_type is NOT inferred from the description', result.facts.employment_type === null);
  check('the description itself IS kept verbatim', result.facts.description_text === prose.description);

  // A title containing "Remote" must not set remote_type either.
  const titled = jobs.extractJobFacts(page(ldJson({
    '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Remote Senior Engineer (Contract)',
  })));
  check('remote_type is NOT inferred from the title', titled.facts.remote_type === null);
  check('employment_type is NOT inferred from "(Contract)" in the title',
    titled.facts.employment_type === null);

  // An employmentType outside the schema.org vocabulary is dropped, not passed
  // through as though it meant something.
  const bogus = jobs.extractJobFacts(page(ldJson({
    '@context': 'https://schema.org', '@type': 'JobPosting', title: 'X', employmentType: 'WHENEVER_YOU_LIKE',
  })));
  check('an unrecognised employmentType is dropped', bogus.facts.employment_type === null,
    String(bogus.facts.employment_type));

  // A salary that is prose rather than a number is not parsed out.
  const wordy = jobs.extractJobFacts(page(ldJson({
    '@context': 'https://schema.org', '@type': 'JobPosting', title: 'X',
    baseSalary: { '@type': 'MonetaryAmount', currency: 'GBP', value: { '@type': 'QuantitativeValue', minValue: 'competitive' } },
  })));
  check('a non-numeric salary is not invented', wordy.facts.salary_min === null,
    String(wordy.facts.salary_min));
}

/* -------------------------------------------- 4. malformed and missing */

section('4. Malformed or missing structured data is an outcome, not a throw');
{
  const malformed = jobs.extractJobFacts(page('<script type="application/ld+json">{ not valid json </script>'));
  check('malformed JSON-LD does not throw', malformed !== undefined);
  check('  status is extraction_incomplete', malformed.status === 'extraction_incomplete', malformed.status);
  check('  reason is malformed_structured_data', malformed.reason === 'malformed_structured_data', String(malformed.reason));
  check('  every field is NULL', Object.values(malformed.facts).every((v) => v === null));

  const bare = jobs.extractJobFacts(page('<title>Just a page</title>', '<p>Nothing structured here.</p>'));
  check('a page with no structured data is incomplete', bare.status === 'extraction_incomplete', bare.status);
  check('  reason is no_structured_data', bare.reason === 'no_structured_data', String(bare.reason));

  for (const [label, input] of [['null', null], ['undefined', undefined], ['an empty string', '']]) {
    const r = jobs.extractJobFacts(input);
    check(`${label} body yields no_structured_data`,
      r.status === 'extraction_incomplete' && r.reason === 'no_structured_data', `${r.status}/${r.reason}`);
  }

  // JSON-LD that parses but is not a JobPosting is not treated as one.
  const wrongType = jobs.extractJobFacts(page(ldJson({ '@context': 'https://schema.org', '@type': 'Article', headline: 'Hi' })));
  check('a non-JobPosting JSON-LD block yields no facts', wrongType.facts.title === null, String(wrongType.facts.title));

  // One malformed block must not stop a valid one alongside it.
  const mixed = jobs.extractJobFacts(page(
    '<script type="application/ld+json">{ broken </script>' + ldJson(COMPLETE_POSTING)));
  check('a valid block still extracts alongside a malformed one',
    mixed.status === 'extracted' && mixed.facts.title === 'Senior Software Engineer', mixed.status);
}

section('5. JobPosting nested inside @graph is found');
{
  const graph = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'Organization', name: 'Wrapper' },
    { '@type': 'JobPosting', title: 'Platform Engineer', hiringOrganization: { name: 'Graph Co' } },
  ] };
  const result = jobs.extractJobFacts(page(ldJson(graph)));
  check('the posting inside @graph is found', result.facts.title === 'Platform Engineer', String(result.facts.title));
  check('  and its organisation', result.facts.company_name === 'Graph Co', String(result.facts.company_name));
}

/* ------------------------------------------ 6. microdata and meta */

section('6. Microdata and meta tags are used, in that precedence');
{
  const microdata = page('', `
    <div itemscope itemtype="https://schema.org/JobPosting">
      <h1 itemprop="title">Data Engineer</h1>
      <meta itemprop="datePosted" content="2026-07-15">
      <span itemprop="employmentType">PART_TIME</span>
      <div itemprop="description">Work with pipelines.</div>
    </div>`);
  const result = jobs.extractJobFacts(microdata);
  check('microdata title is extracted', result.facts.title === 'Data Engineer', String(result.facts.title));
  check('  with method microdata', result.provenance.title === 'microdata', String(result.provenance.title));
  check('microdata datePosted is extracted', result.facts.date_posted === '2026-07-15', String(result.facts.date_posted));
  check('microdata employmentType is extracted', result.facts.employment_type === 'PART_TIME');

  const metaOnly = jobs.extractJobFacts(page(
    '<meta property="og:title" content="Meta Engineer">'
    + '<meta property="og:description" content="From open graph.">'
    + '<meta property="og:site_name" content="Meta Co">'));
  check('og:title is used when nothing better exists', metaOnly.facts.title === 'Meta Engineer');
  check('  with method meta', metaOnly.provenance.title === 'meta', String(metaOnly.provenance.title));
  check('og:site_name becomes company_name', metaOnly.facts.company_name === 'Meta Co');

  // JSON-LD must win over og: for the same field.
  const both = jobs.extractJobFacts(page(
    '<meta property="og:title" content="Open Graph Title">'
    + ldJson({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'JSON-LD Title' })));
  check('JSON-LD takes precedence over og:', both.facts.title === 'JSON-LD Title', String(both.facts.title));
  check('  and provenance records json_ld', both.provenance.title === 'json_ld', String(both.provenance.title));
}

/* --------------------------------------- 7. byte-for-byte faithfulness */

section('7. Published text is kept byte-for-byte');
{
  const cases = [
    ['leading NBSP', NBSP + 'Senior Engineer'],
    ['trailing ZWSP', 'Senior Engineer' + ZWSP],
    ['internal double space', 'Senior  Engineer'],
    ['trailing ordinary space', 'Senior Engineer '],
    ['leading ordinary space', ' Senior Engineer'],
    ['embedded tab', 'Senior' + cp(0x0009) + 'Engineer'],
    ['accented', 'Ing' + cp(0x00e9) + 'nieur logiciel'],
    ['CJK', [0x8f6f, 0x4ef6, 0x5de5, 0x7a0b, 0x5e08].map(cp).join('')],
    ['emoji', cp(0x1f680) + ' Engineer'],
    ['mixed case preserved', 'sEnIoR eNgInEeR'],
  ];
  for (const [label, title] of cases) {
    const result = jobs.extractJobFacts(page(ldJson({
      '@context': 'https://schema.org', '@type': 'JobPosting', title,
    })));
    check(`${label} survives extraction unmodified`, result.facts.title === title,
      result.facts.title === title ? 'byte-identical' : JSON.stringify(result.facts.title));
  }

  // HTML character references are DECODED, because "&amp;" in markup is the
  // character "&" — that recovers the published text rather than altering it.
  const entity = jobs.extractJobFacts(page('<meta property="og:title" content="Research &amp; Development">'));
  check('HTML entities are decoded to the published character',
    entity.facts.title === 'Research & Development', String(entity.facts.title));
  const numericEntity = jobs.extractJobFacts(page('<meta property="og:title" content="Caf&#233; Engineer">'));
  check('numeric character references are decoded',
    numericEntity.facts.title === 'Caf' + cp(0x00e9) + ' Engineer', String(numericEntity.facts.title));
  const unknownEntity = jobs.extractJobFacts(page('<meta property="og:title" content="A &weirdthing; B">'));
  check('an unknown entity is left exactly as written',
    unknownEntity.facts.title === 'A &weirdthing; B', String(unknownEntity.facts.title));
}

/* ----------------------------------------------- 8. determinism */

section('8. Extraction is a pure, byte-stable function');
{
  const html = page(ldJson(COMPLETE_POSTING));
  const runs = Array.from({ length: 5 }, () => jobs.extractJobFacts(html));
  const serialised = runs.map((r) => JSON.stringify({ facts: r.facts, provenance: r.provenance, status: r.status, reason: r.reason }));
  check('five runs over the same input are byte-identical',
    new Set(serialised).size === 1, `${new Set(serialised).size} distinct result(s)`);

  // Different input must genuinely produce a different result, so the check
  // above cannot pass by everything being constant.
  const other = jobs.extractJobFacts(page(ldJson({ ...COMPLETE_POSTING, title: 'Different Title' })));
  check('different input produces a different result',
    JSON.stringify(other.facts) !== JSON.stringify(runs[0].facts));

  // No clock and no network: a result computed now must equal one computed
  // after a delay, and nothing in the output may be a timestamp of the run.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const later = jobs.extractJobFacts(html);
  check('a later run is identical (no clock dependency)',
    JSON.stringify(later.facts) === JSON.stringify(runs[0].facts));
}

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0 ? `ALL ${passed} EXTRACTION CHECKS PASSED` : `${failed} FAILED of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
