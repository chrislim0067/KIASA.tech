/**
 * Constraint and Row-Level-Security tests for the candidate profile schema.
 *
 *   supabase start && node scripts/test-profile-rls.mjs
 *
 * Runs against the LOCAL Supabase stack only. Local credentials are read at
 * runtime from `supabase status -o env` — nothing is hardcoded here, and the
 * service-role key is never used: every assertion is made through the
 * publishable key as an ordinary signed-in user, which is exactly how the
 * browser will reach this data. If RLS is wrong, these tests see it.
 *
 * Test users are created at runtime with random addresses and random
 * passwords, and deleted at the end. No credentials are written to disk.
 *
 * Exits non-zero on any failure.
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

/** Local-container SQL, used only to remove the throwaway users at the end. */
const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';
const sql = (statement) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement], {
    encoding: 'utf8',
  }).trim();

const anonOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const newClient = () => createClient(API_URL, PUBLISHABLE_KEY, anonOptions);

/* ---------------------------------------------------------------- harness */

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** A constraint violation is expected: the insert must be rejected. */
async function expectRejected(name, promise) {
  const { error } = await promise;
  check(name, Boolean(error), error ? `rejected: ${error.code ?? ''}` : 'NOT REJECTED');
}
async function expectAccepted(name, promise) {
  const { error } = await promise;
  check(name, !error, error ? `unexpected error: ${error.message}` : '');
}

async function makeUser(label) {
  const client = newClient();
  const email = `rls-${label}-${randomUUID()}@example.test`;
  const password = randomBytes(18).toString('base64url'); // never persisted
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(`signUp failed for ${label}: ${error.message}`);
  if (!data.session) throw new Error('No session returned; local confirmations must be off.');
  return { client, id: data.user.id, email };
}

const ALL_TABLES = [
  'profiles', 'job_preferences', 'automation_settings', 'work_authorizations',
  'work_experiences', 'education_entries', 'skills', 'certifications',
  'projects', 'languages', 'verified_answers',
];

/** One minimal valid row per table for a given owner. */
function rowsFor(userId) {
  return {
    profiles: { user_id: userId, legal_first_name: 'Ada', legal_last_name: 'Lovelace' },
    job_preferences: { user_id: userId, desired_titles: ['Software Engineer'] },
    automation_settings: { user_id: userId },
    work_authorizations: {
      user_id: userId, country_code: 'GB',
      is_authorized: true, sponsorship_required_now: false, sponsorship_required_future: false,
    },
    work_experiences: { user_id: userId, company_name: 'Acme', job_title: 'Engineer' },
    education_entries: { user_id: userId, institution_name: 'Example University' },
    skills: { user_id: userId, name: 'TypeScript', proficiency: 'advanced', years_experience: 5 },
    certifications: { user_id: userId, name: 'Example Cert' },
    projects: { user_id: userId, name: 'Example Project' },
    languages: { user_id: userId, language_code: 'en', proficiency: 'native_bilingual' },
    verified_answers: {
      user_id: userId, question_key: 'years_of_typescript', answer_text: '5',
      source: 'user_entered', is_verified: true, verified_at: new Date().toISOString(),
    },
  };
}

/* -------------------------------------------------------------------- run */

console.log(`Local API: ${API_URL}`);

const A = await makeUser('a');
const B = await makeUser('b');
console.log(`user A ${A.id}\nuser B ${B.id}`);

/* ----------------------------------------------- 1. owner can write & read */
section('1. Owner can create and read every table');
const aRows = rowsFor(A.id);
for (const table of ALL_TABLES) {
  await expectAccepted(`A inserts into ${table}`, A.client.from(table).insert(aRows[table]));
}
for (const table of ALL_TABLES) {
  const { data, error } = await A.client.from(table).select('user_id');
  check(`A reads own ${table}`, !error && data?.length === 1, error?.message ?? `${data?.length} row(s)`);
}

/* ------------------------------------------------------- 2. constraints */
section('2. Constraints');
const p = A.client.from('profiles');
await expectRejected('phone must be E.164', p.update({ phone_e164: '07700 900000' }).eq('user_id', A.id).select());
await expectAccepted('valid E.164 accepted', p.update({ phone_e164: '+447700900000' }).eq('user_id', A.id).select());
await expectRejected('country_code must be uppercase 2-letter', p.update({ country_code: 'gb' }).eq('user_id', A.id).select());
await expectAccepted('uppercase country_code accepted', p.update({ country_code: 'GB' }).eq('user_id', A.id).select());
await expectRejected('url must have a scheme', p.update({ linkedin_url: 'linkedin.com/in/x' }).eq('user_id', A.id).select());
await expectRejected('other_links must be an array', p.update({ other_links: { a: 1 } }).eq('user_id', A.id).select());
await expectRejected('contact_email must look like an email', p.update({ contact_email: 'not-an-email' }).eq('user_id', A.id).select());

const auto = A.client.from('automation_settings');
await expectRejected('min_match_score > 100 rejected', auto.update({ min_match_score: 101 }).eq('user_id', A.id).select());
await expectRejected('max_applications_per_day > 1000 rejected', auto.update({ max_applications_per_day: 1001 }).eq('user_id', A.id).select());
await expectAccepted('max_applications_per_day 1000 accepted', auto.update({ max_applications_per_day: 1000 }).eq('user_id', A.id).select());
await expectRejected('allowed_country_codes must be uppercase ISO', auto.update({ allowed_country_codes: ['gb'] }).eq('user_id', A.id).select());
await expectRejected('excluded_companies rejects blank entries', auto.update({ excluded_companies: ['  '] }).eq('user_id', A.id).select());

const { data: defaults } = await A.client
  .from('automation_settings')
  .select('is_automation_enabled, allow_resume_tailoring, allow_cover_letter_generation, max_applications_per_day, stop_on_captcha, stop_on_mfa, stop_on_assessment, stop_on_unknown_question, stop_on_sensitive_question, stop_on_legal_attestation, stop_on_application_fee, stop_on_external_contact_request')
  .eq('user_id', A.id)
  .single();
check('automation disabled by default', defaults?.is_automation_enabled === false);
check('resume tailoring off by default', defaults?.allow_resume_tailoring === false);
check('cover letters off by default', defaults?.allow_cover_letter_generation === false);
check(
  'all 8 stop conditions default true',
  ['stop_on_captcha', 'stop_on_mfa', 'stop_on_assessment', 'stop_on_unknown_question',
   'stop_on_sensitive_question', 'stop_on_legal_attestation', 'stop_on_application_fee',
   'stop_on_external_contact_request'].every((k) => defaults?.[k] === true)
);

const wa = A.client.from('work_authorizations');
await expectRejected('work auth booleans are NOT NULL',
  wa.insert({ user_id: A.id, country_code: 'FR', is_authorized: true, sponsorship_required_now: null, sponsorship_required_future: false }));
await expectRejected('one work-auth row per country',
  wa.insert({ user_id: A.id, country_code: 'GB', is_authorized: true, sponsorship_required_now: false, sponsorship_required_future: false }));

const va = A.client.from('verified_answers');
// Since migration 9, verified_at is derived by a trigger rather than supplied by
// the client, so these no longer fail the CHECK — the trigger normalises them
// first. The guarantee is stronger than before: it is not merely that an
// inconsistent pair is rejected, but that the client cannot choose the value at
// all. Assert the resulting state rather than a rejection.
await expectAccepted('verified answer without verified_at is accepted',
  va.insert({ user_id: A.id, question_key: 'k1', answer_text: 'x', source: 'user_entered', is_verified: true }));
{
  const { data } = await A.client.from('verified_answers').select('verified_at').eq('question_key', 'k1').single();
  check('...and verified_at is stamped by the server', data?.verified_at !== null, String(data?.verified_at));
}
await expectAccepted('unverified answer carrying verified_at is accepted',
  va.insert({ user_id: A.id, question_key: 'k2', answer_text: 'x', source: 'user_entered', is_verified: false, verified_at: new Date().toISOString() }));
{
  const { data } = await A.client.from('verified_answers').select('verified_at').eq('question_key', 'k2').single();
  check('...and the client-supplied verified_at is discarded', data?.verified_at === null, String(data?.verified_at));
}
await expectRejected('locked answer must be verified',
  va.insert({ user_id: A.id, question_key: 'k3', answer_text: 'x', source: 'user_entered', is_verified: false, is_locked: true }));
await expectRejected('times_used cannot be negative',
  va.update({ times_used: -1 }).eq('user_id', A.id).select());
await expectRejected('question_key must be snake_case',
  va.insert({ user_id: A.id, question_key: 'Not Valid Key', answer_text: 'x', source: 'user_entered' }));
await expectRejected('duplicate question_key rejected',
  va.insert({ user_id: A.id, question_key: 'years_of_typescript', answer_text: 'y', source: 'user_entered' }));
await expectRejected('unknown sensitivity rejected',
  va.insert({ user_id: A.id, question_key: 'k4', answer_text: 'x', source: 'user_entered', sensitivity: 'made_up' }));
await expectRejected('answer must have content',
  va.insert({ user_id: A.id, question_key: 'k5', source: 'user_entered' }));

// The generated safety column.
const { data: verifiedNormal } = await A.client.from('verified_answers')
  .select('requires_human_approval').eq('question_key', 'years_of_typescript').single();
check('verified + normal => requires_human_approval false', verifiedNormal?.requires_human_approval === false);

for (const sensitivity of ['sensitive', 'legal_attestation', 'demographic_eeo', 'disability', 'veteran_status', 'criminal_history', 'requires_approval']) {
  const key = `probe_${sensitivity}`;
  await A.client.from('verified_answers').insert({
    user_id: A.id, question_key: key, answer_text: 'x', source: 'user_entered',
    is_verified: true, verified_at: new Date().toISOString(), sensitivity,
  });
  const { data } = await A.client.from('verified_answers').select('requires_human_approval').eq('question_key', key).single();
  check(`sensitivity "${sensitivity}" forces human approval`, data?.requires_human_approval === true);
}
await A.client.from('verified_answers').insert({
  user_id: A.id, question_key: 'probe_unverified', answer_text: 'x', source: 'user_entered', is_verified: false,
});
const { data: unverified } = await A.client.from('verified_answers').select('requires_human_approval').eq('question_key', 'probe_unverified').single();
check('unverified answer forces human approval', unverified?.requires_human_approval === true);

await expectRejected('work experience end before start',
  A.client.from('work_experiences').insert({ user_id: A.id, company_name: 'X', job_title: 'Y', start_date: '2024-01-01', end_date: '2023-01-01' }));
await expectRejected('current role cannot have an end date',
  A.client.from('work_experiences').insert({ user_id: A.id, company_name: 'X', job_title: 'Y', is_current: true, end_date: '2024-01-01' }));
await expectRejected('certification expiry before issue',
  A.client.from('certifications').insert({ user_id: A.id, name: 'C', issue_date: '2024-01-01', expiry_date: '2023-01-01' }));
await expectRejected('skill name is case-insensitively unique',
  A.client.from('skills').insert({ user_id: A.id, name: 'typescript' }));
await expectRejected('invalid language proficiency',
  A.client.from('languages').insert({ user_id: A.id, language_code: 'fr', proficiency: 'fluent-ish' }));

// updated_at trigger
const { data: before } = await A.client.from('profiles').select('created_at, updated_at').eq('user_id', A.id).single();
await new Promise((r) => setTimeout(r, 1100));
await A.client.from('profiles').update({ preferred_name: 'Ada' }).eq('user_id', A.id);
const { data: after } = await A.client.from('profiles').select('created_at, updated_at').eq('user_id', A.id).single();
check('updated_at advances on update', new Date(after.updated_at) > new Date(before.updated_at));
check('created_at is not touched', after.created_at === before.created_at);

/* ------------------------------------------------ 3. two-user isolation */
section('3. Two-user isolation (B must not reach A)');
for (const table of ALL_TABLES) {
  const { data, error } = await B.client.from(table).select('user_id').eq('user_id', A.id);
  check(`B cannot SELECT A's ${table}`, !error && data?.length === 0, error?.message ?? `${data?.length} row(s)`);
}
for (const table of ALL_TABLES) {
  const { data } = await B.client.from(table).update({ updated_at: new Date().toISOString() }).eq('user_id', A.id).select();
  check(`B cannot UPDATE A's ${table}`, (data?.length ?? 0) === 0, `${data?.length ?? 0} row(s) affected`);
}
for (const table of ALL_TABLES) {
  const { data } = await B.client.from(table).delete().eq('user_id', A.id).select();
  check(`B cannot DELETE A's ${table}`, (data?.length ?? 0) === 0, `${data?.length ?? 0} row(s) affected`);
}
section('3b. B cannot claim a row for A (WITH CHECK)');
const bRows = rowsFor(A.id); // deliberately stamped with A's id
for (const table of ALL_TABLES) {
  const { error } = await B.client.from(table).insert(bRows[table]);
  check(`B cannot INSERT into ${table} as A`, Boolean(error), error ? `blocked: ${error.code}` : 'NOT BLOCKED');
}

section('3c. A is intact after B\'s attempts');
for (const table of ALL_TABLES) {
  const { data } = await A.client.from(table).select('user_id');
  check(`A still owns its ${table} row`, (data?.length ?? 0) >= 1, `${data?.length ?? 0} row(s)`);
}

/* ------------------------------------------------------ 4. signed out */
section('4. Signed-out client sees nothing');
const anon = newClient();
for (const table of ALL_TABLES) {
  const { data, error } = await anon.from(table).select('user_id');
  check(`anon cannot read ${table}`, (data?.length ?? 0) === 0, error ? `error: ${error.code}` : '0 rows');
}
{
  const { error } = await anon.from('profiles').insert({ user_id: A.id, legal_first_name: 'Mallory' });
  check('anon cannot INSERT', Boolean(error), error ? `blocked: ${error.code}` : 'NOT BLOCKED');
}

/* ------------------------------------------------- 5. helper functions */
section('5. Helper functions cannot be abused');

// anon must not be able to execute any of them.
for (const fn of ['text_array_matches', 'text_array_no_blanks']) {
  const { error } = await anon.rpc(fn, fn === 'text_array_matches' ? { arr: ['GB'], pattern: '^[A-Z]{2}$' } : { arr: ['x'] });
  check(`anon cannot execute ${fn}()`, Boolean(error), error ? `blocked: ${error.code}` : 'NOT BLOCKED');
}

// The trigger function must not be reachable by anyone through the API.
for (const [label, client] of [['anon', anon], ['authenticated', A.client]]) {
  for (const trigger of ['set_row_timestamps', 'guard_verified_answer_provenance']) {
    const { error } = await client.rpc(trigger);
    check(`${label} cannot execute ${trigger}()`, Boolean(error), error ? `blocked: ${error.code}` : 'NOT BLOCKED');
  }
}

// authenticated CAN call the two CHECK helpers — that is unavoidable, since a
// CHECK constraint evaluates them as the inserting user. What matters is that
// they are harmless: pure, IMMUTABLE, search_path='', they touch no table, and
// they return a boolean derived solely from the arguments passed in. There is
// no table reference to point at another user's row.
{
  const { data, error } = await A.client.rpc('text_array_no_blanks', { arr: ['ok'] });
  check('authenticated may call the CHECK helper (required by the constraint)', !error && data === true, error?.message ?? `returned ${data}`);
}
{
  // Proof it cannot be turned into a data read: it accepts only text[]/text.
  const { error } = await A.client.rpc('text_array_no_blanks', { arr: 'select * from public.profiles' });
  check('CHECK helper rejects a non-array argument', Boolean(error), error ? `blocked: ${error.code}` : 'NOT BLOCKED');
}
// And it changes nothing: A's row count is unaffected by calling it.
{
  const { data } = await A.client.from('profiles').select('user_id');
  check('calling helpers did not alter data', (data?.length ?? 0) === 1, `${data?.length ?? 0} row(s)`);
}

/* --------------------------------------------------------------- cleanup */
section('6. Cleanup');
// Remove the throwaway users; ON DELETE CASCADE takes their rows with them, so
// a repeated run always starts from the same state and no test data lingers.
for (const user of [A, B]) sql(`delete from auth.users where id = '${user.id}'`);
const leftover = sql(`select count(*) from public.profiles where user_id in ('${A.id}', '${B.id}')`);
check('test users and their rows removed', leftover === '0', `${leftover} profile row(s) left`);

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0 ? `ALL ${passed} CHECKS PASSED` : `${failed} FAILED of ${passed + failed}`);
console.log('Note: cascade-delete is verified separately in scripts/test-profile-cascade.mjs');
process.exit(failed === 0 ? 0 : 1);
