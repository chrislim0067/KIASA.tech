/**
 * Security regression tests — the adversarial cases the Step 2E review found
 * were correct but untested, plus the behaviour added in Step 2F.
 *
 *   supabase start && node scripts/test-security-regressions.mjs
 *
 * Every assertion is made through the publishable key as an ordinary signed-in
 * user, which is exactly how a browser reaches this data. Local only; the script
 * refuses a non-loopback API URL and creates/deletes its own throwaway users.
 */
import { execFileSync } from 'node:child_process';

import { statusEnvRaw } from './lib/supabase-cli.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';

function localEnv() {
  const raw = statusEnvRaw();
  const env = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\r]*)"?/);
    if (m) env[m[1]] = m[2];
  }
  const url = env.API_URL;
  const key = env.PUBLISHABLE_KEY || env.ANON_KEY;
  if (!url || !key) throw new Error('Local Supabase is not running (supabase start).');
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error(`Refusing to run against a non-local API URL: ${url}`);
  }
  return { url, key };
}

const { url: API_URL, key: KEY } = localEnv();
const sql = (s) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', s], {
    encoding: 'utf8',
  }).trim();

const newClient = () => createClient(API_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function makeUser(tag) {
  const client = newClient();
  const { data, error } = await client.auth.signUp({
    email: `sec-${tag}-${randomUUID()}@example.test`,
    password: randomBytes(18).toString('base64url'),
  });
  if (error) throw new Error(error.message);
  return { client, id: data.user.id };
}

const ALL_TABLES = [
  'profiles', 'job_preferences', 'automation_settings', 'work_authorizations',
  'work_experiences', 'education_entries', 'skills', 'certifications',
  'projects', 'languages', 'verified_answers',
];

const rowFor = (id) => ({
  profiles: { user_id: id, legal_first_name: 'Ada' },
  job_preferences: { user_id: id },
  automation_settings: { user_id: id },
  work_authorizations: { user_id: id, country_code: 'GB', is_authorized: true, sponsorship_required_now: false, sponsorship_required_future: false },
  work_experiences: { user_id: id, company_name: 'Acme', job_title: 'Engineer' },
  education_entries: { user_id: id, institution_name: 'Example University' },
  skills: { user_id: id, name: 'TypeScript' },
  certifications: { user_id: id, name: 'Example Cert' },
  projects: { user_id: id, name: 'Example Project' },
  languages: { user_id: id, language_code: 'en', proficiency: 'native_bilingual' },
  verified_answers: { user_id: id, question_key: 'probe', answer_text: 'x', source: 'user_entered' },
});

const A = await makeUser('a');
const B = await makeUser('b');
const rows = rowFor(A.id);
for (const t of ALL_TABLES) {
  const { error } = await A.client.from(t).insert(rows[t]);
  if (error) throw new Error(`setup ${t}: ${error.message}`);
}

/* ------------------------------------------------------ 1. row donation */
section('1. Cross-user row donation (WITH CHECK on UPDATE)');
for (const t of ALL_TABLES) {
  const { data, error } = await A.client.from(t).update({ user_id: B.id }).eq('user_id', A.id).select();
  const moved = sql(`select count(*) from public.${t} where user_id = '${B.id}'`);
  check(`A cannot reassign its ${t} row to B`,
    (error !== null || (data?.length ?? 0) === 0) && moved === '0',
    error ? `blocked: ${error.code}` : `${data?.length ?? 0} changed / B owns ${moved}`);
}

/* --------------------------------------------- 2. generated column immutability */
section('2. requires_human_approval is immutable');
{
  const { error: e1 } = await A.client.from('verified_answers')
    .update({ requires_human_approval: false }).eq('user_id', A.id).select();
  check('cannot UPDATE requires_human_approval', Boolean(e1), e1 ? `blocked: ${e1.code}` : 'NOT BLOCKED');
  const { error: e2 } = await A.client.from('verified_answers').insert({
    user_id: A.id, question_key: 'gen_probe', answer_text: 'x', source: 'user_entered', requires_human_approval: false,
  });
  check('cannot INSERT requires_human_approval', Boolean(e2), e2 ? `blocked: ${e2.code}` : 'NOT BLOCKED');
}

/* ---------------------------------------------------------- 3. TRUNCATE */
section('3. authenticated cannot TRUNCATE (RLS does not cover TRUNCATE)');
for (const t of ['profiles', 'verified_answers', 'skills']) {
  let denied = false;
  let msg = '';
  try {
    sql(`set role authenticated; truncate table public.${t};`);
  } catch (e) {
    denied = true;
    msg = String(e.stderr ?? e.message).split('\n')[0].slice(0, 60);
  }
  check(`TRUNCATE public.${t} denied`, denied, msg || 'TRUNCATE SUCCEEDED');
}

/* ------------------------------------------------- 4. anonymous access */
section('4. Anonymous access denied on every table');
{
  const anon = newClient();
  for (const t of ALL_TABLES) {
    const { data } = await anon.from(t).select('user_id');
    check(`anon SELECT ${t} returns nothing`, (data?.length ?? 0) === 0, `${data?.length ?? 0} row(s)`);
  }
  for (const t of ALL_TABLES) {
    const { error } = await anon.from(t).insert(rowFor(A.id)[t]);
    check(`anon INSERT ${t} blocked`, Boolean(error), error ? error.code : 'NOT BLOCKED');
  }
  for (const t of ALL_TABLES) {
    const { data } = await anon.from(t).delete().eq('user_id', A.id).select();
    check(`anon DELETE ${t} affects nothing`, (data?.length ?? 0) === 0, `${data?.length ?? 0} row(s)`);
  }
}

/* --------------------------------------------------- 5. system timestamps */
section('5. System timestamps cannot be forged (M1)');
{
  const past = '2000-01-01T00:00:00Z';
  await A.client.from('skills').insert({ user_id: A.id, name: 'TimestampProbe', created_at: past, updated_at: past });
  const year = sql(`select extract(year from created_at)::int from public.skills where user_id='${A.id}' and name='TimestampProbe'`);
  check('client-supplied created_at on INSERT is ignored', year !== '2000', `stored year ${year}`);

  const before = sql(`select created_at from public.skills where user_id='${A.id}' and name='TimestampProbe'`);
  await new Promise((r) => setTimeout(r, 1100));
  await A.client.from('skills').update({ name: 'TimestampProbe2', created_at: past, updated_at: past }).eq('name', 'TimestampProbe');
  const after = sql(`select created_at from public.skills where user_id='${A.id}' and name='TimestampProbe2'`);
  const updated = sql(`select updated_at > created_at from public.skills where user_id='${A.id}' and name='TimestampProbe2'`);
  check('created_at is preserved across UPDATE', after === before, `${before} -> ${after}`);
  check('updated_at is advanced by the server', updated === 't', updated);
}

/* ------------------------------------------------- 6. trusted provenance */
section('6. Trusted provenance cannot be forged (M1)');
for (const source of ['agent_drafted_user_approved', 'imported_from_resume']) {
  const { error } = await A.client.from('verified_answers')
    .insert({ user_id: A.id, question_key: `prov_${source}`, answer_text: 'x', source });
  check(`authenticated cannot INSERT source="${source}"`, Boolean(error), error ? `blocked: ${error.code}` : 'NOT BLOCKED');
}
{
  const { error } = await A.client.from('verified_answers')
    .update({ source: 'agent_drafted_user_approved' }).eq('question_key', 'probe').select();
  check('authenticated cannot UPDATE source to a trusted value', Boolean(error), error ? `blocked: ${error.code}` : 'NOT BLOCKED');

  const { error: ok } = await A.client.from('verified_answers')
    .insert({ user_id: A.id, question_key: 'prov_user', answer_text: 'x', source: 'user_entered' });
  check('authenticated CAN still write source="user_entered"', !ok, ok?.message ?? '');
}
{
  // A trusted writer (the owner role, not an API role) may record agent provenance.
  sql(`insert into public.verified_answers (user_id, question_key, answer_text, source)
       values ('${A.id}', 'prov_trusted', 'x', 'agent_drafted_user_approved')`);
  const stored = sql(`select source from public.verified_answers where user_id='${A.id}' and question_key='prov_trusted'`);
  check('a trusted (non-API) role CAN record agent provenance', stored === 'agent_drafted_user_approved', stored);
}
{
  // verified_at is derived, never taken from the client.
  await A.client.from('verified_answers').insert({
    user_id: A.id, question_key: 'verify_probe', answer_text: 'x',
    source: 'user_entered', is_verified: true, verified_at: '2000-01-01T00:00:00Z',
  });
  const y = sql(`select extract(year from verified_at)::int from public.verified_answers where user_id='${A.id}' and question_key='verify_probe'`);
  check('verified_at cannot be back-dated', y !== '2000', `stored year ${y}`);
  await A.client.from('verified_answers').update({ is_verified: false }).eq('question_key', 'verify_probe');
  const cleared = sql(`select verified_at is null from public.verified_answers where user_id='${A.id}' and question_key='verify_probe'`);
  check('un-verifying clears verified_at', cleared === 't', cleared);
}

/* ------------------------------------- 7. work authorization: absence = unknown */
section('7. Work authorization: no row means UNKNOWN');
{
  const { data } = await A.client.from('work_authorizations').select('country_code, is_authorized').eq('country_code', 'DE');
  check('no row exists for an unstated country', (data?.length ?? 0) === 0, `${data?.length ?? 0} row(s)`);
  const nulls = sql(`select count(*) from public.work_authorizations
                     where is_authorized is null or sponsorship_required_now is null or sponsorship_required_future is null`);
  check('a stored row can never be partially stated', nulls === '0', `${nulls} partial row(s)`);
  const { error } = await A.client.from('work_authorizations')
    .insert({ user_id: A.id, country_code: 'DE', is_authorized: true, sponsorship_required_now: null, sponsorship_required_future: false });
  check('a half-answered row is rejected', Boolean(error), error ? error.code : 'NOT BLOCKED');
}

/* ---------------------------------------------------------- 8. URL schemes */
section('8. other_links URL schemes (M3)');
for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'vbscript:x', 'ftp://h/x', '//evil.com', ' javascript:alert(1)']) {
  const { error } = await A.client.from('profiles')
    .update({ other_links: [{ label: 'x', url: bad }] }).eq('user_id', A.id).select();
  check(`rejects ${JSON.stringify(bad.slice(0, 28))}`, Boolean(error), error ? error.code : 'ACCEPTED');
}
for (const good of ['https://example.com/a', 'http://example.com']) {
  const { error } = await A.client.from('profiles')
    .update({ other_links: [{ label: 'Portfolio', url: good }] }).eq('user_id', A.id).select();
  check(`accepts ${good}`, !error, error?.message ?? '');
}
{
  const { error: blank } = await A.client.from('profiles')
    .update({ other_links: [{ label: '   ', url: 'https://example.com' }] }).eq('user_id', A.id).select();
  check('rejects a blank label', Boolean(blank), blank ? blank.code : 'ACCEPTED');
  const many = Array.from({ length: 21 }, (_, i) => ({ label: `l${i}`, url: `https://example.com/${i}` }));
  const { error: tooMany } = await A.client.from('profiles').update({ other_links: many }).eq('user_id', A.id).select();
  check('rejects more than 20 links', Boolean(tooMany), tooMany ? tooMany.code : 'ACCEPTED');
}

/* -------------------------------------------------- 9. size / cardinality */
section('9. Size and cardinality limits (M2)');
{
  const { error: ok } = await A.client.from('work_experiences')
    .insert({ user_id: A.id, company_name: 'Normal', job_title: 'Engineer', description: 'x'.repeat(9000) });
  check('a realistic 9,000-char description is accepted', !ok, ok?.message ?? '');

  const { error: tooBig } = await A.client.from('work_experiences')
    .insert({ user_id: A.id, company_name: 'Huge', job_title: 'Engineer', description: 'x'.repeat(2_000_000) });
  check('a 2MB description is rejected', Boolean(tooBig), tooBig ? tooBig.code : 'ACCEPTED');

  const { error: bigAnswer } = await A.client.from('verified_answers')
    .insert({ user_id: A.id, question_key: 'big', answer_text: 'x'.repeat(50_000), source: 'user_entered' });
  check('a 50,000-char answer is rejected', Boolean(bigAnswer), bigAnswer ? bigAnswer.code : 'ACCEPTED');

  const { error: bigJson } = await A.client.from('verified_answers')
    .insert({ user_id: A.id, question_key: 'bigjson', answer_structured: { blob: 'x'.repeat(200_000) }, source: 'user_entered' });
  check('an oversized answer_structured is rejected (pg_column_size)', Boolean(bigJson), bigJson ? bigJson.code : 'ACCEPTED');

  const { error: manyTitles } = await A.client.from('job_preferences')
    .update({ desired_titles: Array.from({ length: 5000 }, (_, i) => `t${i}`) }).eq('user_id', A.id).select();
  check('a 5,000-element array is rejected', Boolean(manyTitles), manyTitles ? manyTitles.code : 'ACCEPTED');

  const { error: okTitles } = await A.client.from('job_preferences')
    .update({ desired_titles: ['Software Engineer', 'Backend Engineer'] }).eq('user_id', A.id).select();
  check('a normal title list is accepted', !okTitles, okTitles?.message ?? '');

  const { error: longEl } = await A.client.from('job_preferences')
    .update({ desired_titles: ['x'.repeat(500)] }).eq('user_id', A.id).select();
  check('an over-long array element is rejected', Boolean(longEl), longEl ? longEl.code : 'ACCEPTED');
}

/* ------------------------------------------- 10. blank array elements (L1) */
section('10. Blank array elements rejected, including allowlists (L1)');
for (const [table, column] of [
  ['automation_settings', 'allowed_titles'],
  ['automation_settings', 'excluded_titles'],
  ['automation_settings', 'excluded_companies'],
  ['job_preferences', 'desired_titles'],
  ['job_preferences', 'desired_locations'],
  ['job_preferences', 'preferred_industries'],
]) {
  for (const blank of ['', '   ']) {
    const { error } = await A.client.from(table).update({ [column]: [blank] }).eq('user_id', A.id).select();
    check(`${table}.${column} rejects ${blank === '' ? 'empty string' : 'whitespace'}`, Boolean(error), error ? error.code : 'ACCEPTED');
  }
}

/* ------------------------------------ 11. approval category vocabulary (L2) */
section('11. always_require_approval_categories vocabulary (L2)');
{
  const valid = ['normal', 'sensitive', 'legal_attestation', 'demographic_eeo', 'disability', 'veteran_status', 'criminal_history', 'requires_approval'];
  const { error } = await A.client.from('automation_settings')
    .update({ always_require_approval_categories: valid }).eq('user_id', A.id).select();
  check('all 8 valid categories accepted together', !error, error?.message ?? '');
  for (const v of valid) {
    const { error: e } = await A.client.from('automation_settings')
      .update({ always_require_approval_categories: [v] }).eq('user_id', A.id).select();
    check(`category "${v}" accepted`, !e, e?.message ?? '');
  }
  for (const bad of ['demographic', 'DISABILITY', 'veteran', 'legal-attestation', 'made_up', '']) {
    const { error: e } = await A.client.from('automation_settings')
      .update({ always_require_approval_categories: [bad] }).eq('user_id', A.id).select();
    check(`typo "${bad || '(empty)'}" rejected`, Boolean(e), e ? e.code : 'ACCEPTED');
  }
}

/* ------------------------------------------------------------- cleanup */
section('12. Cleanup');
for (const u of [A, B]) sql(`delete from auth.users where id = '${u.id}'`);
const left = sql(`select count(*) from public.profiles where user_id in ('${A.id}','${B.id}')`);
check('test users and their rows removed', left === '0', `${left} left`);

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0 ? `ALL ${passed} SECURITY REGRESSION CHECKS PASSED` : `${failed} FAILED of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
