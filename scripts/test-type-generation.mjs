/**
 * Proves that type generation is failure-safe. (Review finding M4)
 *
 *   node scripts/test-type-generation.mjs
 *
 * The old command redirected the CLI's stdout straight into the types file, so a
 * failure truncated it to 0 bytes. These tests force real failures and assert
 * the existing file survives byte-for-byte.
 *
 * The loopback-guard cases contact nothing: the guard rejects the URL before the
 * CLI is ever invoked.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const TARGET = path.join(ROOT, 'lib', 'supabase', 'database.types.ts');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-types.mjs');

let failed = 0;
let passed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const hash = (file) => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
const run = (env = {}) =>
  spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, ...env }, cwd: ROOT });

if (!fs.existsSync(TARGET)) {
  console.error('No existing types file to protect; run npm run db:types first.');
  process.exit(1);
}

const before = hash(TARGET);
const beforeSize = fs.statSync(TARGET).size;
console.log(`guarding ${path.relative(ROOT, TARGET)} (${beforeSize} bytes, sha256 ${before.slice(0, 16)}…)`);

/* --------------------------------------------- 1. unreachable local database */
section('1. Generation failure leaves the existing file intact');
{
  // Loopback (so the guard allows it) but nothing is listening on port 1.
  const r = run({ DB_URL: 'postgresql://postgres:postgres@127.0.0.1:1/postgres' });
  check('exits non-zero when the database is unreachable', r.status !== 0, `exit ${r.status}`);
  check('types file is unchanged', hash(TARGET) === before, `${fs.statSync(TARGET).size} bytes`);
  check('types file is not truncated', fs.statSync(TARGET).size === beforeSize, `${fs.statSync(TARGET).size} vs ${beforeSize}`);
  check('reports that the file was preserved', /left UNCHANGED/.test(r.stderr ?? ''), (r.stderr ?? '').trim().split('\n').pop() ?? '');
}

/* ------------------------------------------------------- 2. loopback guard */
section('2. Non-loopback databases are refused without contacting them');
for (const url of [
  'postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
  'postgresql://postgres:pw@203.0.113.10:5432/postgres',
  'postgresql://postgres:pw@example.com:5432/postgres',
]) {
  const host = new URL(url).hostname;
  const r = run({ DB_URL: url });
  const refused = r.status !== 0 && /non-loopback/i.test(r.stderr ?? '');
  check(`refuses ${host}`, refused, `exit ${r.status}`);
  check(`  file untouched after refusing ${host}`, hash(TARGET) === before);
  // The guard runs before the CLI, so nothing was dialled.
  check(`  no CLI invocation for ${host}`, !/Connecting to db/.test(r.stdout ?? ''), 'no connection attempt');
}
{
  const r = run({ DB_URL: 'not a url' });
  check('refuses a malformed DB_URL', r.status !== 0 && /not a valid URL/i.test(r.stderr ?? ''), `exit ${r.status}`);
  check('  file untouched', hash(TARGET) === before);
}

/* ------------------------------------------------- 3. no stray temp files */
section('3. Temporary files are cleaned up');
{
  const strays = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('kiasa-types-'));
  check('no kiasa-types-* temp files left behind', strays.length === 0, strays.slice(0, 3).join(', '));
}

/* ------------------------------------------------------- 4. success path */
section('4. The success path still replaces the file correctly');
{
  const r = run();
  const succeeded = r.status === 0;
  // Asserted on the measured exit status, not on a literal, and reported once
  // under one label whichever way it goes.
  check('generation succeeds against the local stack', succeeded,
    succeeded ? (r.stdout ?? '').trim() : `exit ${r.status}: ${(r.stderr ?? '').split('\n')[0]}`);

  if (succeeded) {
    const after = hash(TARGET);
    check('regenerated file is valid and non-empty', fs.statSync(TARGET).size > 500, `${fs.statSync(TARGET).size} bytes`);
    check('regenerated content matches the committed file', after === before,
      after === before ? 'byte-identical' : 'DIFFERS — schema drift or an uncommitted change');
  } else {
    // The run failed, so the only thing left worth proving is that it failed
    // safely. These are different assertions, not the same one relabelled.
    check('types file survived the failed run', hash(TARGET) === before, `${fs.statSync(TARGET).size} bytes`);
    check('types file was not truncated by the failed run', fs.statSync(TARGET).size === beforeSize,
      `${fs.statSync(TARGET).size} vs ${beforeSize}`);
  }
}

console.log(`\n${'='.repeat(56)}`);
console.log(failed === 0 ? `ALL ${passed} TYPE-GENERATION CHECKS PASSED` : `${failed} FAILED of ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
