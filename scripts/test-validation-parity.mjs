/**
 * Proves the TypeScript validation mirror still matches the database.
 *
 *   supabase start && node scripts/test-validation-parity.mjs
 *
 * The application-side validator in `lib/profile/validation.ts` exists for fast
 * feedback; the database is the authority. That split is only safe while the
 * two agree, so this suite fails the moment they drift:
 *
 *   1. The 28 invisible code points in `lib/profile/invisible.ts` are compared
 *      against the `U&'...'` literal parsed out of migration 11 — in BOTH
 *      directions, so neither an addition nor a removal can slip through.
 *   2. Array bounds, text lengths and vocabularies in `lib/profile/schema.ts`
 *      are compared against the live CHECK constraints.
 *   3. A curated value set is run through the validator AND through a real
 *      authenticated write, asserting both reach the same accept/reject verdict.
 *
 * Local Supabase only. Exits non-zero on any failure.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { profile, REPO_ROOT } from './support/load-profile-layer.mjs';

const require = createRequire(path.join(REPO_ROOT, 'package.json'));
const { createClient } = require('@supabase/supabase-js');

/* ------------------------------------------------------------ local config */

function localEnv() {
  const raw = execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
    encoding: 'utf8', shell: process.platform === 'win32', cwd: REPO_ROOT,
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
const sql = (statement) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement],
    { encoding: 'utf8' }).trim();

/* ---------------------------------------------------------------- harness */

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const cp = (n) => String.fromCodePoint(n);
const hex = (n) => n.toString(16).toUpperCase().padStart(4, '0');

/* ---------------------------------- 1. invisible code points: TS vs SQL */

section('1. The invisible code-point set matches migration 11 exactly');

const MIGRATION = path.join(REPO_ROOT, 'supabase', 'migrations', '20260907000011_whitespace_and_helper_cleanup.sql');
const migrationSql = fs.readFileSync(MIGRATION, 'utf8');

const literal = /translate\(\s*value,\s*U&'((?:\\[0-9A-F]{4})+)'/.exec(migrationSql);
check('the U& literal was found inside translate()', literal !== null);
if (!literal) {
  console.log('\nCannot continue without the SQL set.');
  process.exit(1);
}
const sqlSet = literal[1].match(/\\[0-9A-F]{4}/g).map((x) => parseInt(x.slice(1), 16));
const tsSet = [...profile.INVISIBLE_CODE_POINTS];

check('SQL declares 28 code points', sqlSet.length === 28, `${sqlSet.length}`);
check('TypeScript declares 28 code points', tsSet.length === 28, `${tsSet.length}`);
check('SQL set has no duplicates', new Set(sqlSet).size === sqlSet.length);
check('TypeScript set has no duplicates', new Set(tsSet).size === tsSet.length);

const missingInTs = sqlSet.filter((n) => !tsSet.includes(n));
const extraInTs = tsSet.filter((n) => !sqlSet.includes(n));
check('every SQL code point is in TypeScript', missingInTs.length === 0,
  missingInTs.map((n) => `U+${hex(n)}`).join(',') || 'none missing');
check('every TypeScript code point is in SQL', extraInTs.length === 0,
  extraInTs.map((n) => `U+${hex(n)}`).join(',') || 'none extra');

// Order is not required to match, but a same-order set is easier to review.
check('the two sets are in the same order', JSON.stringify(sqlSet) === JSON.stringify(tsSet));

section('2. The TypeScript predicate agrees with the SQL function, per code point');
for (const n of sqlSet) {
  const dbAlone = sql(`select public.is_blank_or_invisible(U&'\\${hex(n)}')`) === 't';
  const tsAlone = profile.isBlankOrInvisible(cp(n));
  check(`U+${hex(n)} alone: db=${dbAlone} ts=${tsAlone}`, dbAlone === tsAlone && tsAlone === true);

  const mixed = cp(n) + 'Engineer';
  const dbMixed = sql(`select public.is_blank_or_invisible(U&'\\${hex(n)}Engineer')`) === 't';
  const tsMixed = profile.isBlankOrInvisible(mixed);
  check(`  U+${hex(n)} + visible: db=${dbMixed} ts=${tsMixed}`, dbMixed === tsMixed && tsMixed === false);
}
{
  const cases = [
    ['', true], ['a', false], ['Software Engineer', false], ['Senior Software Engineer', false],
    ['---', false],
  ];
  for (const [value, expected] of cases) {
    const ts = profile.isBlankOrInvisible(value);
    const db = sql(`select public.is_blank_or_invisible('${value.replace(/'/g, "''")}')`) === 't';
    check(`"${value}" -> blank=${expected}`, ts === expected && db === expected, `ts=${ts} db=${db}`);
  }
  check('null is blank in TypeScript', profile.isBlankOrInvisible(null) === true);
  check('undefined is blank in TypeScript', profile.isBlankOrInvisible(undefined) === true);
  // An astral character must count as one visible character, not two surrogates.
  check('emoji outside the BMP is not blank', profile.isBlankOrInvisible(cp(0x1f680)) === false);
}

/* ------------------------------------- 3. no literal invisible bytes in source */

section('3. No source file contains a literal invisible character');
{
  const files = [
    ...fs.readdirSync(path.join(REPO_ROOT, 'lib', 'profile')).map((f) => path.join('lib', 'profile', f)),
    path.join('scripts', 'test-validation-parity.mjs'),
    path.join('scripts', 'test-data-layer.mjs'),
    path.join('scripts', 'support', 'load-profile-layer.mjs'),
    path.join('supabase', 'migrations', '20260907000011_whitespace_and_helper_cleanup.sql'),
  ];
  // Newline, carriage return and the ordinary space are how source is written;
  // every OTHER member of the set would be an invisible character in the file.
  const allowed = new Set([0x000a, 0x000d, 0x0020]);
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const found = [];
    let index = 0;
    for (const ch of text) {
      const n = ch.codePointAt(0);
      if (!allowed.has(n) && (sqlSet.includes(n) || n < 0x20 || n === 0x7f)) {
        found.push(`U+${hex(n)}@${index}`);
      }
      index += ch.length;
    }
    check(`${rel} has no literal invisible bytes`, found.length === 0, found.slice(0, 3).join(' '));
  }
}

/* ----------------------------- 4. schema.ts limits match the live constraints */

section('4. Declared limits match the live CHECK constraints');
{
  const rows = sql(`select t.relname || '|' || substring(pg_get_constraintdef(c.oid) from 'text_array_ok\\((\\w+), ([0-9]+), ([0-9]+)\\)')
                    || '|' || substring(pg_get_constraintdef(c.oid) from 'text_array_ok\\(\\w+, ([0-9]+)')
                    || '|' || substring(pg_get_constraintdef(c.oid) from 'text_array_ok\\(\\w+, [0-9]+, ([0-9]+)')
                    from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
                    where n.nspname='public' and c.contype='c' and pg_get_constraintdef(c.oid) like '%text_array_ok%'`)
    .split('\n').map((l) => l.trim()).filter(Boolean);

  check('the database reports 14 text_array_ok constraints', rows.length === 14, `${rows.length}`);

  let compared = 0;
  for (const row of rows) {
    const [table, column, maxItems, maxLen] = row.split('|');
    const declared = profile.ARRAY_LIMITS[table]?.[column];
    if (!declared) {
      check(`${table}.${column} is declared in ARRAY_LIMITS`, false, 'missing from schema.ts');
      continue;
    }
    compared++;
    check(`${table}.${column} bounds match`,
      declared.maxItems === Number(maxItems) && declared.maxLen === Number(maxLen),
      `db=(${maxItems},${maxLen}) ts=(${declared.maxItems},${declared.maxLen})`);
  }
  check('every database array constraint was compared', compared === 14, `${compared}/14`);

  const links = sql(`select substring(pg_get_constraintdef(c.oid) from 'jsonb_links_ok\\(\\w+, ([0-9]+), ([0-9]+), ([0-9]+)\\)')
                     from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
                     where n.nspname='public' and pg_get_constraintdef(c.oid) like '%jsonb_links_ok%'`);
  check('other_links bounds match', links === String(profile.OTHER_LINKS_LIMITS.maxItems),
    `db maxItems=${links} ts=${profile.OTHER_LINKS_LIMITS.maxItems}`);
}

section('5. Declared vocabularies match the live CHECK constraints');
{
  const vocab = (table, column) => {
    const def = sql(`select pg_get_constraintdef(c.oid) from pg_constraint c
                     join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
                     where n.nspname='public' and t.relname='${table}'
                       and pg_get_constraintdef(c.oid) like '%${column}%'
                       and (pg_get_constraintdef(c.oid) like '%ANY (ARRAY%' or pg_get_constraintdef(c.oid) like '%<@ ARRAY%')
                     limit 1`);
    return [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
  };
  const compare = (label, dbList, tsList) => {
    const a = [...dbList].sort().join(',');
    const b = [...tsList].sort().join(',');
    check(`${label} vocabulary matches`, a === b && dbList.length > 0, a === b ? `${dbList.length} values` : `db=[${a}] ts=[${b}]`);
  };
  compare('sensitivity', vocab('verified_answers', 'sensitivity'), profile.SENSITIVITIES);
  compare('approval categories', vocab('automation_settings', 'always_require_approval_categories'), profile.SENSITIVITIES);
  compare('work modes', vocab('job_preferences', 'work_modes'), profile.WORK_MODES);
  compare('employment types', vocab('job_preferences', 'employment_types'), profile.EMPLOYMENT_TYPES);
  compare('answer types', vocab('verified_answers', 'answer_type'), profile.ANSWER_TYPES);
}

/* --------------------------- 6. validator verdict vs database verdict */

section('6. Validator and database reach the same verdict');

const client = createClient(API_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: signUp, error: signUpError } = await client.auth.signUp({
  email: `parity-${randomUUID()}@example.test`,
  password: randomBytes(18).toString('base64url'),
});
if (signUpError) throw new Error(`signUp failed: ${signUpError.message}`);
const userId = signUp.user.id;
await profile.ensureProfile(client, userId);
await profile.upsertJobPreferences(client, userId, { desired_titles: ['seed'] });

/**
 * Each case is judged three times:
 *
 *   validator — `validateTextArray` alone, no I/O;
 *   database  — a RAW supabase-js write that bypasses the layer entirely, so
 *               the verdict is genuinely PostgreSQL's;
 *   layer     — the exported function, which validates first and only then
 *               writes.
 *
 * The raw write matters: routing the "database" verdict through the layer would
 * mean local validation short-circuits before PostgreSQL is ever consulted, and
 * the test would only prove the layer agrees with itself. Going direct is what
 * makes this a parity test rather than a tautology.
 *
 * A case passes only when all three agree with the expectation, so a validator
 * that is too strict is caught as surely as one that is too lax.
 */
const CASES = [
  ['plain title', ['Software Engineer'], true],
  ['title with internal spaces', ['Senior Software Engineer'], true],
  ['accented title', ['Ing' + cp(0x00e9) + 'nieur logiciel'], true],
  ['Chinese title', [[0x8f6f, 0x4ef6, 0x5de5, 0x7a0b, 0x5e08].map(cp).join('')], true],
  ['leading NBSP then visible', [cp(0x00a0) + 'Engineer'], true],
  ['trailing BOM after visible', ['Engineer' + cp(0xfeff)], true],
  ['single visible character', ['a'], true],
  ['empty string element', [''], false],
  ['space-only element', ['   '], false],
  ['tab-only element', [cp(0x0009)], false],
  ['NBSP-only element', [cp(0x00a0)], false],
  ['ZWSP-only element', [cp(0x200b)], false],
  ['BOM-only element', [cp(0xfeff)], false],
  ['ideographic-space-only element', [cp(0x3000)], false],
  ['mixed invisible-only element', [cp(0x0020) + cp(0x200b) + cp(0xfeff)], false],
  ['one good one invisible', ['Engineer', cp(0x0009)], false],
  ['element over 200 characters', ['x'.repeat(201)], false],
  ['element exactly 200 characters', ['x'.repeat(200)], true],
  ['101 items (over the limit)', Array.from({ length: 101 }, (_, i) => `t${i}`), false],
  ['100 items (at the limit)', Array.from({ length: 100 }, (_, i) => `t${i}`), true],
];

for (const [label, value, expectAccepted] of CASES) {
  const issues = profile.validateTextArray('desired_titles', value, profile.ARRAY_LIMITS.job_preferences.desired_titles);
  const validatorAccepts = issues.length === 0;

  // Raw write: no layer, no local validation — PostgreSQL's own verdict.
  const rawWrite = await client
    .from('job_preferences')
    .upsert({ user_id: userId, desired_titles: value }, { onConflict: 'user_id' })
    .select();
  const databaseAccepts = !rawWrite.error;

  const layerWrite = await profile.upsertJobPreferences(client, userId, { desired_titles: value });
  const layerAccepts = layerWrite.ok;

  const agree = validatorAccepts === databaseAccepts && layerAccepts === databaseAccepts;
  const correct = databaseAccepts === expectAccepted;
  check(
    `${label}: validator=${validatorAccepts} db=${databaseAccepts} layer=${layerAccepts}`,
    agree && correct,
    agree
      ? (correct ? 'agree' : `all agree but expected ${expectAccepted}`)
      : `DISAGREE${rawWrite.error ? ` (db ${rawWrite.error.code})` : ''}`,
  );
}

/* --------------------------------------------------------------- cleanup */

section('7. Cleanup');
sql(`delete from auth.users where id = '${userId}'`);
const leftover = sql(`select count(*) from public.profiles where user_id = '${userId}'`);
check('test user removed', leftover === '0', `${leftover} row(s) left`);

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0 ? `ALL ${passed} VALIDATION-PARITY CHECKS PASSED` : `${failed} FAILED of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
