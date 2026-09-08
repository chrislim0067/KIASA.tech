/**
 * Assert the Supabase CLI that actually executes is exactly the pinned version.
 *
 *   node scripts/check-supabase-cli.mjs
 *
 * Runs offline, needs no database, and is the first thing the static CI job
 * does. It checks three things that can disagree with one another:
 *
 *   1. package.json pins an EXACT version (no range — a caret here would let
 *      a patch release in without a lockfile change anyone reviewed).
 *   2. The installed wrapper package is that version.
 *   3. The binary, when run, REPORTS that version.
 *
 * The third is the one that matters. The first two are metadata and can be
 * true while a stale or partially installed node_modules runs something else.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { SUPABASE_CLI_VERSION, cliEntry, installedVersion } from './lib/supabase-cli.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

console.log(`\n=== Supabase CLI is pinned to ${SUPABASE_CLI_VERSION} ===`);

const declared = read('package.json').devDependencies?.supabase;
check('package.json declares it as a devDependency', Boolean(declared), declared ?? 'missing');
check(
  'the declared version is exact, not a range',
  declared === SUPABASE_CLI_VERSION,
  `declared "${declared}"`
);

const lock = read('package-lock.json');
const locked = lock.packages?.['node_modules/supabase']?.version;
check('the lockfile records that version', locked === SUPABASE_CLI_VERSION, `lockfile "${locked}"`);

// The wrapper resolves a platform-specific binary package. If the lockfile
// only carried the platform it was generated on, `npm ci` would fail on every
// other platform -- which is exactly what CI is.
const platforms = Object.keys(lock.packages ?? {}).filter((k) => k.includes('@supabase/cli-'));
const wrongVersion = platforms.filter(
  (k) => lock.packages[k].version !== SUPABASE_CLI_VERSION
);
check(
  'every platform binary is locked at the same version',
  platforms.length > 0 && wrongVersion.length === 0,
  `${platforms.length} platform package(s)`
);
check(
  'a Linux binary is locked, so CI can install it',
  platforms.some((k) => k.includes('linux-x64')),
  'required by ubuntu-latest'
);

check('the pinned CLI is installed locally', Boolean(cliEntry()), 'node_modules/supabase');

// The assertion that actually proves something: run it.
let actual = null;
try {
  actual = installedVersion();
} catch (error) {
  check('the CLI executes', false, error.message.split('\n')[0]);
}
if (actual !== null) {
  check('the EXECUTED CLI reports the pinned version', actual === SUPABASE_CLI_VERSION, actual);
}

console.log('\n========================================================');
if (failed === 0) {
  console.log(`Supabase CLI verified: ${SUPABASE_CLI_VERSION} (declared, locked and executed)`);
  process.exit(0);
}
console.error(`${failed} Supabase CLI pinning check(s) FAILED`);
process.exit(1);
