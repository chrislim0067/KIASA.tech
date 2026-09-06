/**
 * Verifies ON DELETE CASCADE: removing an auth user removes all of their
 * candidate data, and nobody else's.
 *
 *   supabase start && node scripts/test-profile-cascade.mjs
 *
 * Deleting an auth.users row needs more than an ordinary session, so this uses
 * psql inside the LOCAL Postgres container rather than a service-role key —
 * keeping the "no service key" rule intact while still exercising the real
 * foreign-key behaviour. Local only; it refuses to run against anything else.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_kiasa';

const sql = (statement) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', statement], {
    encoding: 'utf8',
  }).trim();

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
  if (!/127\.0\.0\.1|localhost/.test(env.API_URL ?? '')) {
    throw new Error(`Refusing to run against a non-local API URL: ${env.API_URL}`);
  }
  return { url: env.API_URL, key: env.PUBLISHABLE_KEY || env.ANON_KEY };
}

const { url, key } = localEnv();
const TABLES = [
  'profiles', 'job_preferences', 'automation_settings', 'work_authorizations',
  'work_experiences', 'education_entries', 'skills', 'certifications',
  'projects', 'languages', 'verified_answers',
];

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function seedUser(label) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signUp({
    email: `cascade-${label}-${randomUUID()}@example.test`,
    password: randomBytes(18).toString('base64url'),
  });
  if (error) throw new Error(error.message);
  const id = data.user.id;
  const rows = {
    profiles: { user_id: id, legal_first_name: 'Cascade' },
    job_preferences: { user_id: id },
    automation_settings: { user_id: id },
    work_authorizations: { user_id: id, country_code: 'US', is_authorized: true, sponsorship_required_now: false, sponsorship_required_future: false },
    work_experiences: { user_id: id, company_name: 'Acme', job_title: 'Engineer' },
    education_entries: { user_id: id, institution_name: 'Example University' },
    skills: { user_id: id, name: 'SQL' },
    certifications: { user_id: id, name: 'Example Cert' },
    projects: { user_id: id, name: 'Example Project' },
    languages: { user_id: id, language_code: 'en', proficiency: 'native_bilingual' },
    verified_answers: { user_id: id, question_key: 'cascade_probe', answer_text: 'x', source: 'user_entered' },
  };
  for (const t of TABLES) {
    const { error: e } = await client.from(t).insert(rows[t]);
    if (e) throw new Error(`seed ${t}: ${e.message}`);
  }
  return id;
}

const countFor = (userId) =>
  TABLES.reduce((total, t) => total + Number(sql(`select count(*) from public.${t} where user_id = '${userId}'`)), 0);

console.log(`Local API: ${url}\ncontainer: ${CONTAINER}\n`);

const doomed = await seedUser('doomed');
const survivor = await seedUser('survivor');

console.log('=== before deletion ===');
check('doomed user has a row in all 11 tables', countFor(doomed) === 11, `${countFor(doomed)}/11`);
check('survivor has a row in all 11 tables', countFor(survivor) === 11, `${countFor(survivor)}/11`);

sql(`delete from auth.users where id = '${doomed}'`);

console.log('\n=== after deleting the auth user ===');
check('auth user is gone', sql(`select count(*) from auth.users where id = '${doomed}'`) === '0');
for (const t of TABLES) {
  const n = sql(`select count(*) from public.${t} where user_id = '${doomed}'`);
  check(`${t} cascaded to 0 rows`, n === '0', `${n} row(s) left`);
}
check('survivor data untouched', countFor(survivor) === 11, `${countFor(survivor)}/11`);

sql(`delete from auth.users where id = '${survivor}'`);

console.log(`\n${'='.repeat(50)}`);
console.log(failed === 0 ? 'CASCADE VERIFIED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
