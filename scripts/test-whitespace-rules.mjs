/**
 * Regression tests for the blank/invisible-value rule. (Review finding F1)
 *
 *   supabase start && node scripts/test-whitespace-rules.mjs
 *
 * The rule these guard: a text-array element or a link label must contain at
 * least one VISIBLE character. The original implementation used btrim(x) = '',
 * and single-argument btrim strips only U+0020, so a tab-only or NBSP-only
 * entry was accepted. Migration 11 replaced that with an explicit code-point
 * set applied through translate().
 *
 * Two layers are exercised, because passing one does not imply the other:
 *
 *   1. The helpers directly (public.is_blank_or_invisible, text_array_ok,
 *      jsonb_links_ok) through psql — every listed code point, alone and
 *      repeated.
 *   2. The real CHECK constraints through an ordinary signed-in PostgREST
 *      client: automation_settings.allowed_titles (the allowlist that made this
 *      a security issue), job_preferences.desired_titles (a second array on a
 *      different table), and profiles.other_links labels.
 *
 * Every invisible character is built from its numeric code point rather than
 * typed literally. A source file full of raw tabs, NBSPs and zero-width spaces
 * cannot be reviewed, and any editor that trims trailing whitespace or
 * normalises line endings would silently weaken the suite.
 *
 * Local Supabase only, publishable key only, no service-role key. The throwaway
 * user is deleted at the end. Exits non-zero on any failure.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

/* ------------------------------------------------------------ local config */

function localEnv() {
  const raw = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
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

/**
 * Runs SQL in the local container. The statement is a separate execFile
 * argument, never interpolated into a shell command line.
 */
const sql = (statement) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement], {
    encoding: 'utf8',
  }).trim();

/* ---------------------------------------------------------------- harness */

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
async function expectRejected(name, promise) {
  const { error } = await promise;
  check(name, Boolean(error), error ? `rejected: ${error.code ?? ''}` : 'NOT REJECTED');
}
async function expectAccepted(name, promise) {
  const { error } = await promise;
  check(name, !error, error ? `unexpected error: ${error.message}` : '');
}

/* -------------------------------------------------------------- fixtures */

const cp = (n) => String.fromCodePoint(n);

/** Every code point migration 11 must treat as invisible. */
const INVISIBLE = [
  [0x0020, 'U+0020 space'],
  [0x0009, 'U+0009 tab'],
  [0x000a, 'U+000A line feed'],
  [0x000b, 'U+000B vertical tab'],
  [0x000c, 'U+000C form feed'],
  [0x000d, 'U+000D carriage return'],
  [0x00a0, 'U+00A0 no-break space'],
  [0x1680, 'U+1680 ogham space mark'],
  [0x2000, 'U+2000 en quad'],
  [0x2001, 'U+2001 em quad'],
  [0x2002, 'U+2002 en space'],
  [0x2003, 'U+2003 em space'],
  [0x2004, 'U+2004 three-per-em space'],
  [0x2005, 'U+2005 four-per-em space'],
  [0x2006, 'U+2006 six-per-em space'],
  [0x2007, 'U+2007 figure space'],
  [0x2008, 'U+2008 punctuation space'],
  [0x2009, 'U+2009 thin space'],
  [0x200a, 'U+200A hair space'],
  [0x200b, 'U+200B zero-width space'],
  [0x200c, 'U+200C zero-width non-joiner'],
  [0x200d, 'U+200D zero-width joiner'],
  [0x2028, 'U+2028 line separator'],
  [0x2029, 'U+2029 paragraph separator'],
  [0x202f, 'U+202F narrow no-break space'],
  [0x205f, 'U+205F medium mathematical space'],
  [0x3000, 'U+3000 ideographic space'],
  [0xfeff, 'U+FEFF zero-width no-break space'],
].map(([n, name]) => [name, cp(n)]);

/** Several invisible characters combined, for the "mixture" cases. */
const MIXED_INVISIBLE = [0x0020, 0x0009, 0x00a0, 0x200b, 0x3000, 0xfeff].map(cp).join('');

/**
 * Legitimate values that must all remain acceptable. Non-ASCII text is built
 * from code points for the same reason as above, and so that this file stays
 * pure ASCII on disk.
 */
const FRENCH = 'Ing' + cp(0x00e9) + 'nieur logiciel';
const CHINESE = [0x8f6f, 0x4ef6, 0x5de5, 0x7a0b, 0x5e08].map(cp).join('');
const CHINESE_LABEL = [0x4e2a, 0x4eba, 0x4f5c, 0x54c1, 0x96c6].map(cp).join('');
const CYRILLIC = [0x0420, 0x0430, 0x0437, 0x0440, 0x0430, 0x0431, 0x043e, 0x0442, 0x0447, 0x0438, 0x043a].map(cp).join('');
const ARABIC = [0x0645, 0x0647, 0x0646, 0x062f, 0x0633].map(cp).join('');
const EMOJI = cp(0x1f680);

const VISIBLE = [
  ['plain ASCII', 'Software Engineer'],
  ['internal spaces', 'Senior Software Engineer'],
  ['single character', 'a'],
  ['accented Latin', FRENCH],
  ['Chinese', CHINESE],
  ['Cyrillic', CYRILLIC],
  ['Arabic', ARABIC],
  ['punctuation only', '---'],
  ['emoji (outside the BMP)', EMOJI],
];

/**
 * A JS string -> a U&'...' literal. Nothing invisible ever reaches the SQL text
 * as a raw byte, so the assertion cannot be weakened by an encoding round-trip
 * between here, docker exec and the server.
 */
function uLiteral(str) {
  let out = '';
  for (const ch of str) {
    const n = ch.codePointAt(0);
    if (n > 0xffff) out += '\\+' + n.toString(16).toUpperCase().padStart(6, '0');
    else if (n >= 0x20 && n < 0x7f && ch !== "'" && ch !== '\\') out += ch;
    else out += '\\' + n.toString(16).toUpperCase().padStart(4, '0');
  }
  return `U&'${out}'`;
}

/* ------------------------------- 1. the helper, character by character */

section('1. is_blank_or_invisible() catches every listed code point');
for (const [name, ch] of INVISIBLE) {
  const alone = sql(`select public.is_blank_or_invisible(${uLiteral(ch)})`);
  check(`${name} alone is blank`, alone === 't', alone);
  const repeated = sql(`select public.is_blank_or_invisible(${uLiteral(ch.repeat(4))})`);
  check(`  ${name} repeated is blank`, repeated === 't', repeated);
}
{
  const empty = sql(`select public.is_blank_or_invisible('')`);
  check('the empty string is blank', empty === 't', empty);
  const nul = sql(`select public.is_blank_or_invisible(null)`);
  check('null is blank', nul === 't', nul);
  const mixture = sql(`select public.is_blank_or_invisible(${uLiteral(MIXED_INVISIBLE)})`);
  check('a mixture of several invisible characters is blank', mixture === 't', mixture);
}

section('2. is_blank_or_invisible() accepts every legitimate value');
for (const [name, value] of VISIBLE) {
  const r = sql(`select public.is_blank_or_invisible(${uLiteral(value)})`);
  check(`${name} is not blank`, r === 'f', r);
}

section('3. Mixed visible + invisible stays acceptable');
for (const [name, ch] of INVISIBLE) {
  const leading = sql(`select public.is_blank_or_invisible(${uLiteral(ch + 'Engineer')})`);
  check(`${name} + visible is not blank`, leading === 'f', leading);
  const trailing = sql(`select public.is_blank_or_invisible(${uLiteral('Engineer' + ch)})`);
  check(`  visible + ${name} is not blank`, trailing === 'f', trailing);
}
{
  const surrounded = sql(`select public.is_blank_or_invisible(${uLiteral(MIXED_INVISIBLE + 'Engineer' + MIXED_INVISIBLE)})`);
  check('invisible on both sides of visible text is not blank', surrounded === 'f', surrounded);
  const inner = sql(`select public.is_blank_or_invisible(${uLiteral('Engineer' + cp(0x200b) + 'ing')})`);
  check('an invisible character inside a word is not blank', inner === 'f', inner);
}

/* ------------------------------- 4. the centralised array helper */

section('4. text_array_ok() inherits the rule');
for (const [name, ch] of INVISIBLE) {
  const r = sql(`select public.text_array_ok(array[${uLiteral(ch)}], 10, 100)`);
  check(`rejects an array whose only element is ${name}`, r === 'f', r);
}
{
  const mixedArray = sql(`select public.text_array_ok(array['Engineer', ${uLiteral(cp(0x0009))}], 10, 100)`);
  check('rejects an array with one good and one invisible element', mixedArray === 'f', mixedArray);
  const empty = sql(`select public.text_array_ok(array[''], 10, 100)`);
  check('rejects a zero-length element', empty === 'f', empty);
  const spaces = sql(`select public.text_array_ok(array['   '], 10, 100)`);
  check('rejects a space-only element', spaces === 'f', spaces);
  const good = sql(
    `select public.text_array_ok(array['Software Engineer','Senior Software Engineer',${uLiteral(CHINESE)},${uLiteral(FRENCH)}], 10, 100)`,
  );
  check('accepts an array of legitimate titles', good === 't', good);
  const nullArr = sql(`select public.text_array_ok(null, 10, 100)`);
  check('accepts null (the column is optional)', nullArr === 't', nullArr);
  const emptyArr = sql(`select public.text_array_ok(array[]::text[], 10, 100)`);
  check('accepts an empty array', emptyArr === 't', emptyArr);
  const nullElem = sql(`select public.text_array_ok(array[null]::text[], 10, 100)`);
  check('still rejects a null element', nullElem === 'f', nullElem);
  const stillBounded = sql(`select public.text_array_ok(array['ok','ok','ok'], 2, 100)`);
  check('still enforces the item-count limit', stillBounded === 'f', stillBounded);
  const stillLen = sql(`select public.text_array_ok(array[repeat('a', 101)], 10, 100)`);
  check('still enforces the element-length limit', stillLen === 'f', stillLen);
}

section('5. jsonb_links_ok() inherits the rule for labels');
const link = (label, url = 'https://example.com') =>
  `jsonb_build_array(jsonb_build_object('label', ${label}, 'url', '${url}'))`;
for (const [name, ch] of INVISIBLE) {
  const r = sql(`select public.jsonb_links_ok(${link(uLiteral(ch))}, 20, 2048, 200)`);
  check(`rejects a label that is only ${name}`, r === 'f', r);
}
{
  const good = sql(`select public.jsonb_links_ok(${link("'My Design Portfolio'")}, 20, 2048, 200)`);
  check('accepts a label with internal spaces', good === 't', good);
  const cjk = sql(`select public.jsonb_links_ok(${link(uLiteral(CHINESE_LABEL))}, 20, 2048, 200)`);
  check('accepts a non-English label', cjk === 't', cjk);
  const mixedLabel = sql(`select public.jsonb_links_ok(${link(uLiteral(cp(0x00a0) + 'Portfolio'))}, 20, 2048, 200)`);
  check('accepts a label with a leading NBSP and visible text', mixedLabel === 't', mixedLabel);
  const missing = sql(
    `select public.jsonb_links_ok(jsonb_build_array(jsonb_build_object('url', 'https://example.com')), 20, 2048, 200)`,
  );
  check('rejects a link with no label key at all', missing === 'f', missing);
  const stillUrl = sql(`select public.jsonb_links_ok(${link("'Evil'", 'javascript:alert(1)')}, 20, 2048, 200)`);
  check('still rejects a javascript: URL', stillUrl === 'f', stillUrl);
}

/* ---------------------- 6. every constraint routes through the helper */

section('6. All 14 array constraints use the corrected helper');
{
  const total = sql(`select count(*) from pg_constraint c
                     join pg_class t on t.oid = c.conrelid
                     join pg_namespace n on n.oid = t.relnamespace
                     where n.nspname='public' and c.contype='c'
                       and pg_get_constraintdef(c.oid) like '%text_array_ok%'`);
  check('14 CHECK constraints call text_array_ok', total === '14', `${total} found`);

  // The corrected behaviour lives in is_blank_or_invisible, so prove the helper
  // bodies actually call it rather than assuming the replacement took effect.
  for (const fn of ['text_array_ok', 'jsonb_links_ok']) {
    // p.prosrc, not pg_get_functiondef(p.oid): the planner may evaluate a
    // function call in WHERE before the nspname filter, and pg_get_functiondef
    // raises on an aggregate such as pg_catalog.array_agg.
    const body = sql(`select p.prosrc like '%is_blank_or_invisible%'
                      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                      where n.nspname='public' and p.prokind='f' and p.proname='${fn}'`);
    check(`${fn}() delegates to is_blank_or_invisible()`, body === 't', body);
  }
  const stale = sql(`select coalesce(string_agg(p.proname, ','), 'none') from pg_proc p
                     join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public' and p.prokind='f' and p.prosrc like '%btrim%'`);
  check('no helper still uses btrim() for blankness', stale === 'none', stale);

  const dead = sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='text_array_no_blanks'`);
  check('the superseded text_array_no_blanks() is gone', dead === '0', `${dead} found`);
  const deadConstraints = sql(`select count(*) from pg_constraint c
                               join pg_class t on t.oid=c.conrelid
                               join pg_namespace n on n.oid=t.relnamespace
                               where n.nspname='public'
                                 and pg_get_constraintdef(c.oid) like '%text_array_no_blanks%'`);
  check('no constraint references the dropped helper', deadConstraints === '0', `${deadConstraints} found`);
}

/* -------------------- 7. the real constraints, as a real signed-in user */

section('7. Enforcement through PostgREST as a signed-in user');

const client = createClient(API_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const email = `ws-${randomUUID()}@example.test`;
const password = randomBytes(18).toString('base64url'); // never persisted
const { data: signUp, error: signUpError } = await client.auth.signUp({ email, password });
if (signUpError) throw new Error(`signUp failed: ${signUpError.message}`);
if (!signUp.session) throw new Error('No session returned; local confirmations must be off.');
const userId = signUp.user.id;

await expectAccepted('profile row created', client.from('profiles').insert({ user_id: userId }));

// 7a. automation_settings.allowed_titles is an ALLOWLIST. A blank entry here is
// the one that could later be read as "match anything", so it must be rejected.
await expectAccepted(
  'allowed_titles accepts legitimate titles',
  client.from('automation_settings').insert({
    user_id: userId,
    allowed_titles: ['Software Engineer', 'Senior Software Engineer', CHINESE, FRENCH],
  }),
);
for (const [name, ch] of INVISIBLE) {
  await expectRejected(
    `allowed_titles rejects ${name}`,
    client.from('automation_settings').update({ allowed_titles: ['Engineer', ch] }).eq('user_id', userId),
  );
}
await expectRejected(
  'allowed_titles rejects a zero-length entry',
  client.from('automation_settings').update({ allowed_titles: [''] }).eq('user_id', userId),
);
await expectRejected(
  'allowed_titles rejects a space-only entry',
  client.from('automation_settings').update({ allowed_titles: ['   '] }).eq('user_id', userId),
);

const KEPT = cp(0x00a0) + 'Engineer';
await expectAccepted(
  'allowed_titles accepts a leading NBSP followed by visible text',
  client.from('automation_settings').update({ allowed_titles: [KEPT] }).eq('user_id', userId),
);
{
  // The stored value must be byte-identical: the rule tests, it never trims.
  const { data } = await client.from('automation_settings').select('allowed_titles').eq('user_id', userId).single();
  const stored = data?.allowed_titles?.[0];
  check(
    'the accepted value is stored unmodified (not trimmed)',
    stored === KEPT,
    stored === KEPT ? 'byte-identical' : JSON.stringify(stored),
  );
}

// 7b. A second array field on a different table, proving this is centralised
// rather than specific to one constraint.
await expectAccepted(
  'desired_titles accepts legitimate titles',
  client.from('job_preferences').insert({ user_id: userId, desired_titles: ['Product Designer'] }),
);
for (const [name, ch] of INVISIBLE) {
  await expectRejected(
    `desired_titles rejects ${name}`,
    client.from('job_preferences').update({ desired_titles: [ch] }).eq('user_id', userId),
  );
}
await expectAccepted(
  'desired_titles still accepts a visible non-English title',
  client.from('job_preferences').update({ desired_titles: [CHINESE, FRENCH] }).eq('user_id', userId),
);

// 7c. other_links labels.
await expectAccepted(
  'other_links accepts a label with internal spaces',
  client
    .from('profiles')
    .update({ other_links: [{ label: 'My Design Portfolio', url: 'https://example.com/portfolio' }] })
    .eq('user_id', userId),
);
for (const [name, ch] of INVISIBLE) {
  await expectRejected(
    `other_links rejects a label that is only ${name}`,
    client
      .from('profiles')
      .update({ other_links: [{ label: ch, url: 'https://example.com' }] })
      .eq('user_id', userId),
  );
}
await expectAccepted(
  'other_links still accepts a non-English label',
  client
    .from('profiles')
    .update({ other_links: [{ label: CHINESE_LABEL, url: 'https://example.com' }] })
    .eq('user_id', userId),
);

/* --------------------------------------------------------------- cleanup */

section('8. Cleanup');
sql(`delete from auth.users where id = '${userId}'`);
const leftover = sql(`select count(*) from public.profiles where user_id = '${userId}'`);
check('test user and rows removed', leftover === '0', `${leftover} row(s) left`);

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0 ? `ALL ${passed} WHITESPACE CHECKS PASSED` : `${failed} FAILED of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
