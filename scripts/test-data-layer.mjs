/**
 * Behavioural tests for the candidate-profile data-access layer.
 *
 *   supabase start && node scripts/test-data-layer.mjs
 *
 * These exercise the SHIPPED implementation in `lib/profile` — the modules are
 * loaded through `scripts/support/load-profile-layer.mjs`, not re-implemented
 * here — against a real local Supabase stack, as an ordinary signed-in user
 * through the publishable key. No service-role key is used anywhere, so RLS is
 * in force exactly as it will be in production.
 *
 * Throwaway users are created at runtime with random addresses and passwords
 * and deleted at the end. No candidate data in this file is real, and none of
 * it is written to a seed or fixture.
 *
 * Exits non-zero on any failure.
 */
import { execFileSync } from 'node:child_process';

import { statusEnvRaw } from './lib/supabase-cli.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { profile, REPO_ROOT } from './support/load-profile-layer.mjs';

const require = createRequire(path.join(REPO_ROOT, 'package.json'));
const { createClient } = require('@supabase/supabase-js');

/* ------------------------------------------------------------ local config */

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

/* ---------------------------------------------------------------- harness */

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(name, ok, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
/** Asserts the layer returned a failure in a specific category. */
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
    email: `dl-${label}-${randomUUID()}@example.test`,
    password: randomBytes(18).toString('base64url'), // never persisted
  });
  if (error) throw new Error(`signUp failed for ${label}: ${error.message}`);
  if (!data.session) throw new Error('No session returned; local confirmations must be off.');
  return { client, id: data.user.id };
}

const A = await makeUser('a');
const B = await makeUser('b');
const anon = newClient();

/* ------------------------------------------------------- 1. bootstrap */

section('1. ensureProfile is idempotent');
{
  const first = await profile.ensureProfile(A.client, A.id);
  check('creates the profile row on first call', first.ok && first.data.user_id === A.id,
    first.ok ? '' : first.error.message);

  const second = await profile.ensureProfile(A.client, A.id);
  check('a repeated call succeeds', second.ok);
  check('and returns the same row', second.ok && first.ok && second.data.created_at === first.data.created_at);

  // Concurrent first-calls for a brand-new user: one INSERT wins, the others
  // hit 23505, which the layer treats as success and resolves by re-reading.
  const C = await makeUser('c');
  const results = await Promise.all(
    Array.from({ length: 8 }, () => profile.ensureProfile(C.client, C.id)),
  );
  check('8 concurrent calls all succeed', results.every((r) => r.ok),
    `${results.filter((r) => !r.ok).length} failed`);
  check('all concurrent calls agree on the row',
    new Set(results.filter((r) => r.ok).map((r) => r.data.created_at)).size === 1);
  const rows = sql(`select count(*) from public.profiles where user_id='${C.id}'`);
  check('exactly one profile row exists', rows === '1', `${rows} row(s)`);
  sql(`delete from auth.users where id='${C.id}'`);

  const bad = await profile.ensureProfile(A.client, 'not-a-uuid');
  checkError('a malformed user id fails closed', bad, 'unauthenticated', 'missing_user_id');
  const empty = await profile.ensureProfile(A.client, '');
  checkError('an empty user id fails closed', empty, 'unauthenticated', 'missing_user_id');
}

/* ------------------------------------------ 2. UNKNOWN, not fabricated */

section('2. Absent singletons read as null (UNKNOWN), never as defaults');
{
  const prefs = await profile.getJobPreferences(A.client, A.id);
  check('job_preferences is null before any write', prefs.ok && prefs.data === null,
    prefs.ok ? String(prefs.data) : prefs.error.message);

  const automation = await profile.getAutomationSettings(A.client, A.id);
  check('automation_settings is null before any write', automation.ok && automation.data === null);

  const auth = await profile.listWorkAuthorizations(A.client, A.id);
  check('work_authorizations is empty, not a denial', auth.ok && auth.data.length === 0);

  const p = await profile.getProfile(A.client, A.id);
  check('the bootstrapped profile has no fabricated name',
    p.ok && p.data !== null && p.data.legal_first_name === null && p.data.legal_last_name === null);
  check('and no fabricated contact details',
    p.ok && p.data.contact_email === null && p.data.phone_e164 === null && p.data.country_code === null);
  check('other_links defaults to the schema value, not invented content',
    p.ok && Array.isArray(p.data.other_links) && p.data.other_links.length === 0);
}

/* ---------------------------------------------- 3. work authorization */

section('3. Work authorization: absence means UNKNOWN');
{
  const report = await profile.getCompletenessReport(A.client, A.id);
  check('report is produced', report.ok, report.ok ? '' : report.error.message);
  const fact = report.ok ? report.data.facts.find((f) => f.key === 'work_authorization') : null;
  check('absent authorization is reported as missing', fact?.status === 'missing', fact?.status);
  check('with reason work_authorization_unknown', fact?.reason === 'work_authorization_unknown', fact?.reason);
  check('and it blocks automation', fact?.blocksAutomation === true);
  check('no country is claimed as known',
    report.ok && report.data.knownWorkAuthorizationCountries.length === 0);
  check('the report never states "not authorized"',
    !JSON.stringify(report.ok ? report.data : {}).includes('not_authorized'));

  // The three booleans are NOT NULL precisely so a half-specified row cannot
  // exist. A partial write must be refused, not silently completed.
  const partial = await profile.workAuthorizations.set(A.client, A.id, {
    country_code: 'GB', is_authorized: true,
  });
  checkError('a partially specified authorization is rejected', partial, 'constraint_violation', 'not_null_violation');

  const full = await profile.workAuthorizations.set(A.client, A.id, {
    country_code: 'GB', is_authorized: true,
    sponsorship_required_now: false, sponsorship_required_future: true,
  });
  check('a fully specified authorization is accepted', full.ok, full.ok ? '' : full.error.message);
  check('all three booleans are stored as given',
    full.ok && full.data.is_authorized === true
    && full.data.sponsorship_required_now === false
    && full.data.sponsorship_required_future === true);

  // Re-stating the same country is an upsert on (user_id, country_code).
  const again = await profile.workAuthorizations.set(A.client, A.id, {
    country_code: 'GB', is_authorized: true,
    sponsorship_required_now: false, sponsorship_required_future: true,
  });
  check('re-stating the same country is idempotent', again.ok);
  check('and does not create a second row',
    sql(`select count(*) from public.work_authorizations where user_id='${A.id}'`) === '1');

  // Authorization for one country says nothing about another.
  const after = await profile.getCompletenessReport(A.client, A.id);
  check('only the recorded country is known',
    after.ok && after.data.knownWorkAuthorizationCountries.join(',') === 'GB',
    after.ok ? after.data.knownWorkAuthorizationCountries.join(',') : '');
  const gb = after.ok ? after.data.facts.find((f) => f.key === 'work_authorization.GB') : null;
  check('an unverified authorization still awaits a human',
    gb?.status === 'unverified' && gb?.blocksAutomation === true, `${gb?.status}/${gb?.reason}`);
}

/* ------------------------------------- 4. user_id can never be redirected */

section('4. Row donation is impossible through the layer');
{
  await profile.ensureProfile(B.client, B.id);

  // The input type omits user_id; this is the runtime backstop for a caller
  // that ignores types. The layer stamps the authenticated id last, so the
  // supplied value is overwritten rather than honoured.
  const donated = await profile.upsertJobPreferences(A.client, A.id, {
    user_id: B.id, desired_titles: ['Engineer'],
  });
  check('a supplied user_id does not redirect the write', donated.ok && donated.data.user_id === A.id,
    donated.ok ? donated.data.user_id : donated.error.message);
  check("B's row was not created by A's write",
    sql(`select count(*) from public.job_preferences where user_id='${B.id}'`) === '0');

  const donatedRow = await profile.skills.create(A.client, A.id, { name: 'Rust', user_id: B.id });
  check('a collection insert also stamps the authenticated id',
    donatedRow.ok && donatedRow.data.user_id === A.id);
}

section('5. Cross-user isolation through every exported path');
{
  const bSkill = await profile.skills.create(B.client, B.id, { name: 'Elixir' });
  check("B can create B's own row", bSkill.ok);
  const bSkillId = bSkill.ok ? bSkill.data.id : '00000000-0000-0000-0000-000000000000';

  const aList = await profile.listSkills(A.client, A.id);
  check("A's list does not contain B's row",
    aList.ok && !aList.data.some((r) => r.id === bSkillId), `${aList.ok ? aList.data.length : '?'} rows`);

  const steal = await profile.skills.update(A.client, A.id, bSkillId, { name: 'Hijacked' });
  checkError("A cannot update B's row", steal, 'not_found', 'row_not_found');
  check("B's row is unchanged",
    sql(`select name from public.skills where id='${bSkillId}'`) === 'Elixir');

  const wipe = await profile.skills.remove(A.client, A.id, bSkillId);
  checkError("A cannot delete B's row", wipe, 'not_found', 'row_not_found');
  check("B's row still exists", sql(`select count(*) from public.skills where id='${bSkillId}'`) === '1');

  // A holding B's id must not be able to read B's data by passing B's id.
  const impersonate = await profile.getProfile(A.client, B.id);
  check("A passing B's id reads nothing", impersonate.ok && impersonate.data === null,
    impersonate.ok ? String(impersonate.data) : impersonate.error.category);
  const snap = await profile.getCandidateSnapshot(A.client, B.id);
  check("A's snapshot of B is empty, not B's data",
    snap.ok && snap.data.profile === null && snap.data.skills.length === 0);
}

section('6. Anonymous callers get nothing from any exported read');
{
  const reads = [
    ['getProfile', () => profile.getProfile(anon, A.id)],
    ['getJobPreferences', () => profile.getJobPreferences(anon, A.id)],
    ['getAutomationSettings', () => profile.getAutomationSettings(anon, A.id)],
    ['listWorkAuthorizations', () => profile.listWorkAuthorizations(anon, A.id)],
    ['listWorkExperiences', () => profile.listWorkExperiences(anon, A.id)],
    ['listEducationEntries', () => profile.listEducationEntries(anon, A.id)],
    ['listSkills', () => profile.listSkills(anon, A.id)],
    ['listCertifications', () => profile.listCertifications(anon, A.id)],
    ['listProjects', () => profile.listProjects(anon, A.id)],
    ['listLanguages', () => profile.listLanguages(anon, A.id)],
    ['listVerifiedAnswers', () => profile.listVerifiedAnswers(anon, A.id)],
  ];
  for (const [name, run] of reads) {
    const r = await run();
    // Either a hard denial, or an empty result — never another user's data.
    const empty = r.ok && (r.data === null || (Array.isArray(r.data) && r.data.length === 0));
    check(`anon ${name} yields nothing`, !r.ok || empty,
      r.ok ? 'empty' : `${r.error.category}`);
  }
  const write = await profile.upsertProfile(anon, A.id, { city: 'Nowhere' });
  check('anon cannot write', !write.ok, write.ok ? 'WROTE' : write.error.category);
  check("A's city is untouched",
    sql(`select coalesce(city,'(null)') from public.profiles where user_id='${A.id}'`) === '(null)');
}

/* --------------------------------- 7. database-managed columns */

section('7. Database-managed columns cannot be written through the layer');
{
  const before = await profile.getProfile(A.client, A.id);
  const originalCreated = before.ok ? before.data.created_at : null;

  const forged = await profile.upsertProfile(A.client, A.id, {
    city: 'Bristol',
    created_at: '1999-01-01T00:00:00Z',
    updated_at: '1999-01-01T00:00:00Z',
  });
  check('a write carrying timestamps still succeeds', forged.ok, forged.ok ? '' : forged.error.message);
  check('created_at was not moved to the forged value',
    forged.ok && forged.data.created_at !== '1999-01-01T00:00:00+00:00'
    && forged.data.created_at === originalCreated,
    forged.ok ? forged.data.created_at : '');
  check('updated_at was not moved to the forged value',
    forged.ok && forged.data.updated_at !== '1999-01-01T00:00:00+00:00');
  check('the legitimate field was still written', forged.ok && forged.data.city === 'Bristol');

  // The generated column is rejected by PostgreSQL itself (428C9).
  const generated = await profile.saveVerifiedAnswer(A.client, A.id, {
    question_key: 'gen_probe', answer_text: 'x', requires_human_approval: false,
  });
  checkError('writing requires_human_approval is refused', generated, 'immutable_field', 'generated_column_write');

  // verified_at is derived by the migration-9 trigger, never taken from input.
  const stamped = await profile.saveVerifiedAnswer(A.client, A.id, {
    question_key: 'stamp_probe', answer_text: 'x', verified_at: '1999-01-01T00:00:00Z',
  });
  check('a supplied verified_at does not survive',
    stamped.ok && stamped.data.verified_at === null, stamped.ok ? String(stamped.data.verified_at) : stamped.error.message);
}

/* --------------------------------- 8. human-approval boundaries */

section('8. Human-approval boundaries');
{
  const created = await profile.saveVerifiedAnswer(A.client, A.id, {
    question_key: 'why_leaving', question_text: 'Why are you leaving?', answer_text: 'Seeking growth.',
  });
  check('an answer can be saved', created.ok, created.ok ? '' : created.error.message);
  check('a new answer is NOT verified', created.ok && created.data.is_verified === false);
  check('so requires_human_approval is true', created.ok && created.data.requires_human_approval === true);
  check('source is forced to user_entered', created.ok && created.data.source === 'user_entered');

  // The two trusted provenance values are reserved for server-side workflows.
  const forgedSource = await A.client.from('verified_answers')
    .insert({ user_id: A.id, question_key: 'forged', answer_text: 'x', source: 'agent_drafted_user_approved' });
  const mapped = profile.mapPostgrestError(forgedSource.error, { table: 'verified_answers' });
  checkError('a reserved source is refused by the database', mapped, 'forbidden', 'reserved_value');

  const verified = await profile.setAnswerVerification(A.client, A.id, 'why_leaving', true);
  check('explicit verification succeeds', verified.ok, verified.ok ? '' : verified.error.message);
  check('is_verified became true', verified.ok && verified.data.is_verified === true);
  check('verified_at was stamped by the database', verified.ok && verified.data.verified_at !== null);
  check('requires_human_approval cleared for a normal answer',
    verified.ok && verified.data.requires_human_approval === false);

  // Sensitivity alone forces approval even when verified.
  const sensitive = await profile.saveVerifiedAnswer(A.client, A.id, {
    question_key: 'disability_status', answer_text: 'Prefer not to say', sensitivity: 'disability',
  });
  check('a sensitive answer can be stored', sensitive.ok, sensitive.ok ? '' : sensitive.error.message);
  const sensitiveVerified = await profile.setAnswerVerification(A.client, A.id, 'disability_status', true);
  check('even when verified, a sensitive answer still requires approval',
    sensitiveVerified.ok && sensitiveVerified.data.requires_human_approval === true);

  // Locking freezes an answer against verification changes.
  const locked = await profile.setAnswerLock(A.client, A.id, 'why_leaving', true);
  check('an answer can be locked', locked.ok && locked.data.is_locked === true);
  const blocked = await profile.setAnswerVerification(A.client, A.id, 'why_leaving', false);
  checkError('a locked answer refuses verification changes', blocked, 'forbidden', 'answer_locked');
  check('its verification state is unchanged',
    sql(`select is_verified from public.verified_answers where user_id='${A.id}' and question_key='why_leaving'`) === 't');
  await profile.setAnswerLock(A.client, A.id, 'why_leaving', false);

  // Usage recording must never touch content.
  const beforeUse = await profile.listVerifiedAnswers(A.client, A.id);
  const target = beforeUse.ok ? beforeUse.data.find((r) => r.question_key === 'why_leaving') : null;
  const used = await profile.recordAnswerUsage(A.client, A.id, 'why_leaving');
  check('usage is recorded', used.ok && used.data.times_used === (target?.times_used ?? 0) + 1,
    used.ok ? `times_used=${used.data.times_used}` : used.error.message);
  check('last_used_at was set', used.ok && used.data.last_used_at !== null);
  check('the answer text is unchanged', used.ok && used.data.answer_text === target?.answer_text);
  check('the verification state is unchanged', used.ok && used.data.is_verified === target?.is_verified);
  check('the sensitivity is unchanged', used.ok && used.data.sensitivity === target?.sensitivity);
  const usedAgain = await profile.recordAnswerUsage(A.client, A.id, 'why_leaving');
  check('a second recording increments again', usedAgain.ok && usedAgain.data.times_used === used.data.times_used + 1);

  const report = await profile.getCompletenessReport(A.client, A.id);
  check('answers needing approval are listed',
    report.ok && report.data.answersNeedingApproval.includes('disability_status'),
    report.ok ? report.data.answersNeedingApproval.join(',') : '');
  check('the report says a human is needed', report.ok && report.data.status === 'needs_human');
  check('blockers is non-empty and matches the count',
    report.ok && report.data.blockers.length === report.data.counts.blockers && report.data.blockers.length > 0);
}

/* ------------------------------------------- 9. automation stays off */

section('9. Automation is never enabled implicitly');
{
  const first = await profile.upsertAutomationSettings(A.client, A.id, { min_match_score: 60 });
  check('automation settings can be created', first.ok, first.ok ? '' : first.error.message);
  check('is_automation_enabled defaults false', first.ok && first.data.is_automation_enabled === false);
  check('allow_resume_tailoring defaults false', first.ok && first.data.allow_resume_tailoring === false);
  check('allow_cover_letter_generation defaults false', first.ok && first.data.allow_cover_letter_generation === false);
  check('max_applications_per_day defaults 0', first.ok && first.data.max_applications_per_day === 0);

  const stops = [
    'stop_on_captcha', 'stop_on_mfa', 'stop_on_assessment', 'stop_on_unknown_question',
    'stop_on_sensitive_question', 'stop_on_legal_attestation', 'stop_on_application_fee',
    'stop_on_external_contact_request',
  ];
  const allOn = first.ok && stops.every((s) => first.data[s] === true);
  check('all eight stop conditions default true', allOn,
    first.ok ? stops.filter((s) => first.data[s] !== true).join(',') || 'all true' : '');

  const unrelated = await profile.upsertAutomationSettings(A.client, A.id, { min_match_score: 70 });
  check('an unrelated update leaves automation off', unrelated.ok && unrelated.data.is_automation_enabled === false);
  check('and leaves the stop conditions on', unrelated.ok && stops.every((s) => unrelated.data[s] === true));

  const explicit = await profile.upsertAutomationSettings(A.client, A.id, { is_automation_enabled: true });
  check('an explicit caller value does enable it', explicit.ok && explicit.data.is_automation_enabled === true);
  await profile.upsertAutomationSettings(A.client, A.id, { is_automation_enabled: false });
}

/* ------------------------------- 10. byte-for-byte storage */

section('10. Candidate text is stored byte-for-byte');
{
  const cases = [
    ['leading NBSP', cp(0x00a0) + 'Engineer'],
    ['trailing ZWSP', 'Engineer' + cp(0x200b)],
    ['surrounding BOM', cp(0xfeff) + 'Engineer' + cp(0xfeff)],
    ['embedded tab between words', 'Senior' + cp(0x0009) + 'Engineer'],
    ['internal double space', 'Senior  Engineer'],
    ['trailing ordinary space', 'Engineer '],
    ['leading ordinary space', ' Engineer'],
    ['accented', 'Ing' + cp(0x00e9) + 'nieur'],
    ['CJK', [0x8f6f, 0x4ef6].map(cp).join('')],
    ['emoji', cp(0x1f680) + ' Engineer'],
  ];
  for (const [label, value] of cases) {
    const write = await profile.upsertProfile(A.client, A.id, { preferred_name: value });
    if (!write.ok) {
      check(`${label} accepted`, false, write.error.message);
      continue;
    }
    const read = await profile.getProfile(A.client, A.id);
    const stored = read.ok ? read.data.preferred_name : null;
    check(`${label} stored unmodified`, stored === value,
      stored === value ? 'byte-identical' : `in=${JSON.stringify(value)} out=${JSON.stringify(stored)}`);
    // Also compare the raw bytes at the database, not just through PostgREST.
    const octets = sql(`select octet_length(preferred_name) from public.profiles where user_id='${A.id}'`);
    check(`  ${label} byte length matches`, Number(octets) === Buffer.byteLength(value, 'utf8'),
      `db=${octets} js=${Buffer.byteLength(value, 'utf8')}`);
  }
}

/* ------------------------------------- 11. every error category */

section('11. Every error category is provoked by a real failure');
{
  const unauth = await profile.getProfile(A.client, 'nope');
  checkError('unauthenticated', unauth, 'unauthenticated', 'missing_user_id');

  const invalid = await profile.upsertProfile(A.client, A.id, { contact_email: 'not-an-email' });
  checkError('invalid_input (caught locally, never sent)', invalid, 'invalid_input', 'validation_failed');
  check('  and it names the offending field', !invalid.ok && invalid.error.field === 'contact_email');

  const missing = await profile.skills.update(A.client, A.id, randomUUID(), { name: 'Ghost' });
  checkError('not_found', missing, 'not_found', 'row_not_found');

  // A cross-column rule the local validator deliberately does not mirror, so
  // this genuinely reaches PostgreSQL and returns 23514.
  const dates = await profile.workExperiences.create(A.client, A.id, {
    company_name: 'Acme', job_title: 'Engineer',
    start_date: '2020-01-01', end_date: '2019-01-01',
  });
  checkError('constraint_violation from a real 23514', dates, 'constraint_violation', 'check_violation');
  check('  and it names the constraint', !dates.ok && dates.error.field === 'work_experiences_date_order',
    dates.ok ? '' : String(dates.error.field));

  const nulls = await profile.workAuthorizations.set(A.client, A.id, { country_code: 'FR', is_authorized: true });
  checkError('constraint_violation from a real 23502', nulls, 'constraint_violation', 'not_null_violation');

  const generated = await profile.saveVerifiedAnswer(A.client, A.id, {
    question_key: 'imm_probe', answer_text: 'x', requires_human_approval: true,
  });
  checkError('immutable_field from a real 428C9', generated, 'immutable_field', 'generated_column_write');

  const forbidden = await profile.upsertProfile(anon, A.id, { city: 'X' });
  checkError('forbidden from a real 42501', forbidden, 'forbidden', 'permission_denied');

  const badId = await profile.skills.update(A.client, A.id, 'not-a-uuid', { name: 'x' });
  checkError('invalid_input for a malformed row id', badId, 'invalid_input', 'bad_row_id');

  const emptyPatch = await profile.skills.update(A.client, A.id, randomUUID(), {});
  checkError('invalid_input for an empty update', emptyPatch, 'invalid_input', 'empty_update');

  // Genuine 23514s for the two whitespace cases the prompt calls out. Local
  // validation intercepts these before the database, which is the intended
  // behaviour, so the REAL database errors are captured with a raw query and
  // fed through the layer's own mapper.
  const rawInvisible = await A.client.from('job_preferences')
    .upsert({ user_id: A.id, desired_titles: [cp(0x200b)] }, { onConflict: 'user_id' });
  check('raw invisible-only element really is rejected by the database',
    rawInvisible.error?.code === '23514', String(rawInvisible.error?.code));
  checkError('  and maps to constraint_violation',
    profile.mapPostgrestError(rawInvisible.error, { table: 'job_preferences' }),
    'constraint_violation', 'check_violation');

  const rawOverLimit = await A.client.from('job_preferences')
    .upsert({ user_id: A.id, desired_titles: Array(101).fill('x') }, { onConflict: 'user_id' });
  check('raw over-limit array really is rejected by the database',
    rawOverLimit.error?.code === '23514', String(rawOverLimit.error?.code));
  checkError('  and maps to constraint_violation',
    profile.mapPostgrestError(rawOverLimit.error, { table: 'job_preferences' }),
    'constraint_violation', 'check_violation');

  const rawConflict = await A.client.from('profiles').insert({ user_id: A.id });
  check('raw duplicate insert really is 23505', rawConflict.error?.code === '23505', String(rawConflict.error?.code));
  checkError('  and maps to conflict',
    profile.mapPostgrestError(rawConflict.error, { table: 'profiles' }), 'conflict', 'unique_violation');

  const rawMissingFn = await A.client.rpc('definitely_not_a_function', {});
  checkError('a missing database function maps to schema_mismatch',
    profile.mapPostgrestError(rawMissingFn.error, {}), 'schema_mismatch', 'function_not_found');

  checkError('a transport failure maps to unavailable',
    profile.mapPostgrestError({ code: null, message: 'fetch failed' }, {}), 'unavailable', 'transport_error');
  checkError('an unrecognised code maps to unknown',
    profile.mapPostgrestError({ code: 'XX999', message: 'boom' }, {}), 'unknown', 'unmapped_error');
}

section('12. Errors are safe to surface and carry agent guidance');
{
  const r = await profile.upsertProfile(A.client, A.id, { phone_e164: 'bad' });
  check('a local failure carries no SQL or table internals',
    !r.ok && !/select |insert |relation |constraint |pg_/i.test(r.error.message), r.ok ? '' : r.error.message);
  check('technical detail is kept in a separate field', !r.ok && typeof r.error.detail === 'string');
  check('requiresHuman is set for a validation failure', !r.ok && r.error.requiresHuman === true);
  check('retryable is false for a validation failure', !r.ok && r.error.retryable === false);

  const t = profile.mapPostgrestError({ code: null, message: 'fetch failed' }, {});
  check('a transport failure is marked retryable', !t.ok && t.error.retryable === true);
  check('and does not demand a human', !t.ok && t.error.requiresHuman === false);
}

/* --------------------------------------- 13. snapshot and report */

section('13. Snapshot is complete, stable and serialisable');
{
  const snap = await profile.getCandidateSnapshot(A.client, A.id);
  check('snapshot is produced', snap.ok, snap.ok ? '' : snap.error.message);
  if (snap.ok) {
    const keys = [
      'profile', 'jobPreferences', 'automationSettings', 'workAuthorizations', 'workExperiences',
      'educationEntries', 'skills', 'certifications', 'projects', 'languages', 'verifiedAnswers',
    ];
    check('all eleven tables are represented', keys.every((k) => k in snap.data),
      keys.filter((k) => !(k in snap.data)).join(',') || 'all present');
    check('it is JSON-serialisable', (() => {
      try { JSON.parse(JSON.stringify(snap.data)); return true; } catch { return false; }
    })());
    check('it carries the user id', snap.data.userId === A.id);
    check('capturedAt is an ISO instant', /^\d{4}-\d{2}-\d{2}T.*Z$/.test(snap.data.capturedAt));

    const second = await profile.getCandidateSnapshot(A.client, A.id);
    if (second.ok) {
      const strip = (s) => JSON.stringify({ ...s, capturedAt: null });
      check('two consecutive snapshots are identical apart from capturedAt',
        strip(snap.data) === strip(second.data));
    }

    // Deterministic ordering.
    const skillNames = snap.data.skills.map((s) => `${s.sort_order}:${s.name}`);
    const sorted = [...skillNames].sort();
    check('collections come back in a deterministic order',
      JSON.stringify(skillNames) === JSON.stringify(sorted), skillNames.join(' '));
  }

  const report = await profile.getCompletenessReport(A.client, A.id);
  check('report is machine-readable without prose parsing',
    report.ok && ['ready', 'needs_human'].includes(report.data.status)
    && Array.isArray(report.data.blockers)
    && report.data.facts.every((f) => typeof f.key === 'string' && typeof f.blocksAutomation === 'boolean'));
  check('every blocker uses a fixed reason vocabulary',
    report.ok && report.data.blockers.every((f) => [
      'never_recorded', 'awaiting_human_verification', 'sensitive_requires_approval', 'work_authorization_unknown',
    ].includes(f.reason)));
  check('counts agree with the facts array',
    report.ok && report.data.counts.blockers === report.data.blockers.length
    && report.data.counts.present + report.data.counts.missing + report.data.counts.unverified
       === report.data.facts.length);

  // buildCompletenessReport must be pure: same snapshot in, same report out.
  if (snap.ok) {
    const one = profile.buildCompletenessReport(snap.data);
    const two = profile.buildCompletenessReport(snap.data);
    check('buildCompletenessReport is deterministic', JSON.stringify(one) === JSON.stringify(two));
  }
}

/* --------------------------------------------------------------- cleanup */

section('14. Cleanup');
for (const user of [A, B]) sql(`delete from auth.users where id = '${user.id}'`);
const leftover = sql(`select count(*) from public.profiles where user_id in ('${A.id}','${B.id}')`);
check('test users and their rows removed', leftover === '0', `${leftover} row(s) left`);

console.log(`\n${'='.repeat(60)}`);
console.log(failed === 0 ? `ALL ${passed} DATA-LAYER CHECKS PASSED` : `${failed} FAILED of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
