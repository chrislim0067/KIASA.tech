/**
 * Negative tests for the secret scanner.
 *
 *   node scripts/test-secret-scan.mjs
 *
 * A secret scanner that has never been shown a secret is a scanner that
 * reports "clean" for both reasons — because there is nothing there, and
 * because it cannot see. Those two look identical in CI, and only one of them
 * is good news. This tells them apart.
 *
 * Every check runs against a THROWAWAY git repository under the system temp
 * directory: `scan-secrets.mjs` reads `git ls-files`, so the fixtures have to
 * be tracked somewhere, and they must never be tracked here. Nothing is
 * committed and the directory is removed afterwards.
 *
 * WHY THE FIXTURE VALUES ARE ASSEMBLED FROM PIECES
 *
 * This file is itself scanned. A literal `sk-ant-…` written out below would be
 * a finding in the repository the moment it was committed — the test would
 * break the check it exists to verify. So each fixture is concatenated at
 * runtime: the bytes only ever exist in memory and in the temp directory.
 *
 * WHAT IS PROVEN HERE
 *
 *   1. Every rule fires on a representative secret. A rule that silently stops
 *      matching is caught the next time this runs.
 *   2. No matched value reaches stdout or stderr. A scanner that echoes what it
 *      found copies the secret into the CI log.
 *   3. Secrets are found in the formats this project actually stores config in,
 *      not only in prose.
 *   4. The inline allow marker cannot be used to wave through anything it does
 *      not explicitly name. This is the property that matters most: an
 *      exemption mechanism that can hide an arbitrary finding is a hole with a
 *      comment on it.
 *   5. The only blanket exemptions are the documented binary extensions. Files
 *      that merely look like fixtures — `.env.example` — are still scanned.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCANNER = join(dirname(fileURLToPath(import.meta.url)), 'scan-secrets.mjs');

/* ------------------------------------------------------------- fixtures */

/**
 * One representative secret per rule, assembled so this file never contains
 * the pattern it is testing for. `label` is the rule id the scanner must
 * report; the test fails if it reports anything less.
 */
const SECRETS = {
  'anthropic-key': 'sk-' + 'ant-' + 'api03-' + 'A'.repeat(28),
  'openai-style-key': 'sk-' + 'B'.repeat(44),
  'supabase-secret': 'sb_' + 'secret_' + 'C'.repeat(32),
  jwt: 'eyJ' + 'a'.repeat(14) + '.' + 'b'.repeat(14) + '.' + 'c'.repeat(14),
  'private-key-block': '-----BEGIN' + ' PRIVATE KEY' + '-----',
  'github-token': 'gh' + 'p_' + 'D'.repeat(36),
  'aws-access-key': 'AKIA' + 'ABCDEFGHIJKLMNOP',
  'slack-token': 'xox' + 'b-' + '123456789012-abcdef',
  // A host that is deliberately NOT loopback and NOT an RFC-reserved example
  // name, so the rule's own ignore list does not excuse it.
  'postgres-url-with-password': 'postgres' + '://user:hunter2@' + 'db.internal-prod.net' + ':5432/app',
  'resend-key': 're' + '_' + 'E'.repeat(26),
};

const MARKER = 'secret-scan' + ':' + 'allow';

/* -------------------------------------------------------------- harness */

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

/**
 * Build a throwaway tracked repository from `files`, run the scanner in it, and
 * return the exit code plus combined output.
 */
function scan(files) {
  const dir = mkdtempSync(join(tmpdir(), 'kiasa-scan-test-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    // Keep the fixtures byte-for-byte; without this git warns about CRLF on
    // Windows for every file and buries the test output.
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
    for (const [name, body] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    execFileSync('git', ['add', '-A', '-f'], { cwd: dir, stdio: 'pipe' });

    let status = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync('node', [SCANNER], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      status = e.status ?? 1;
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
    }
    return { status, out: stdout + stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Did the scanner report `rule` against `file`? */
const reported = (out, file, rule) =>
  out.split('\n').some((l) => l.includes(file) && l.includes(`[${rule}]`));

/* ------------------------------------------- 1. every rule detects a secret */

section('1. Every rule fires on a representative secret');
for (const [rule, value] of Object.entries(SECRETS)) {
  const { status, out } = scan({ 'fixture.txt': `const key = "${value}";\n` });
  check(`${rule} is detected`, reported(out, 'fixture.txt', rule) && status === 1,
    `exit ${status}`);
}

/* ------------------------------------------------ 2. values are never printed */

section('2. The matched value is never printed');
{
  const files = {};
  let i = 0;
  for (const value of Object.values(SECRETS)) files[`f${i++}.txt`] = `x = "${value}"\n`;
  const { status, out } = scan(files);

  check('every planted secret is reported', status === 1,
    `${Object.keys(SECRETS).length} planted, exit ${status}`);

  const leaked = Object.entries(SECRETS).filter(([, v]) => out.includes(v));
  check('no matched value appears in stdout or stderr', leaked.length === 0,
    leaked.length === 0 ? 'output carries file, line and rule only'
      : `${leaked.length} value(s) echoed`);

  // The distinctive middle of a value, in case a scanner ever truncated rather
  // than withheld. Checked separately so a partial leak cannot pass.
  const fragments = ['hunter2', 'api03', 'ABCDEFGHIJKLMNOP'];
  const partial = fragments.filter((f) => out.includes(f));
  check('not even a fragment of a value is printed', partial.length === 0,
    partial.length === 0 ? 'none of the distinctive substrings appear' : partial.join(', '));
}

/* ------------------------------------------------- 3. configuration formats */

section('3. Secrets are found in the formats this project stores config in');
{
  const v = SECRETS['supabase-secret'];
  const cases = {
    '.env': `SUPABASE_SECRET_KEY=${v}\n`,
    'config.json': `{\n  "secret": "${v}"\n}\n`,
    'compose.yml': `services:\n  app:\n    environment:\n      SECRET: ${v}\n`,
    'config.toml': `[auth]\nsecret = "${v}"\n`,
    'settings.ts': `export const secret = '${v}';\n`,
    'notes.md': `The key is ${v} and must be rotated.\n`,
  };
  for (const [name, body] of Object.entries(cases)) {
    const { out } = scan({ [name]: body });
    check(`detected in ${name}`, reported(out, name, 'supabase-secret'));
  }
}

/* ------------------------------------- 4. the allow marker cannot over-reach */

section('4. The inline allow marker suppresses only what it names');
{
  const aws = SECRETS['aws-access-key'];
  const jwt = SECRETS.jwt;

  // A bare marker. The old behaviour skipped the whole line; it must not.
  {
    const { status, out } = scan({ 'a.txt': `key = "${aws}"  // ${MARKER}\n` });
    check('a BARE marker does not suppress the finding',
      reported(out, 'a.txt', 'aws-access-key') && status === 1, `exit ${status}`);
    check('a BARE marker is itself reported',
      reported(out, 'a.txt', 'malformed-allow-marker'));
  }

  // A marker with a rule id but no reason is not a decision anyone recorded.
  {
    const { out } = scan({ 'b.txt': `key = "${aws}"  // ${MARKER} aws-access-key\n` });
    check('a marker with no reason does not suppress',
      reported(out, 'b.txt', 'aws-access-key'));
    check('a marker with no reason is itself reported',
      reported(out, 'b.txt', 'malformed-allow-marker'));
  }

  // A marker naming a DIFFERENT rule must not cover this one.
  {
    const { out } = scan({ 'c.txt': `key = "${aws}"  // ${MARKER} jwt -- unrelated\n` });
    check('a marker naming another rule does not suppress this one',
      reported(out, 'c.txt', 'aws-access-key'));
  }

  // A marker naming a rule that does not exist must not cover anything.
  {
    const { out } = scan({ 'd.txt': `key = "${aws}"  // ${MARKER} no-such-rule -- typo\n` });
    check('a marker naming an unknown rule does not suppress',
      reported(out, 'd.txt', 'aws-access-key'));
    check('an unknown rule id is itself reported',
      reported(out, 'd.txt', 'unknown-allow-rule'));
  }

  // Two different secrets, one marker: the unnamed one must survive.
  {
    const { out } = scan({
      'e.txt': `a="${aws}" b="${jwt}"  // ${MARKER} aws-access-key -- fixture\n`,
    });
    check('the named rule is suppressed', !reported(out, 'e.txt', 'aws-access-key'));
    check('a second, unnamed secret on the same line still fires',
      reported(out, 'e.txt', 'jwt'));
  }

  // The legitimate case still works, and exits clean.
  {
    const { status, out } = scan({
      'f.txt': `key = "${aws}"  // ${MARKER} aws-access-key -- documented test fixture\n`,
    });
    check('a correctly scoped marker with a reason does suppress',
      !reported(out, 'f.txt', 'aws-access-key') && status === 0, `exit ${status}`);
  }
}

/* ---------------------------------------------- 5. exemptions stay narrow */

section('5. Blanket exemptions are limited to documented binary types');
{
  const v = SECRETS['anthropic-key'];

  // `.env.example` is a fixture-shaped name. It must still be scanned: the
  // whole-file exemption list is empty, and this is what proves it.
  // The variable name is incidental; what is proven is that a real key SHAPE
  // in a fixture-named file is still reported. The `anthropic-key` RULE stays
  // even though this application no longer calls Anthropic — someone pasting
  // an `sk-ant-` key anywhere in this repository is still a leak.
  const ex = scan({ '.env.example': `OPENROUTER_API_KEY=${v}\n` });
  check('.env.example is still scanned', reported(ex.out, '.env.example', 'anthropic-key'));

  const lock = scan({ 'package-lock.json': `{ "token": "${v}" }\n` });
  check('package-lock.json is still scanned',
    reported(lock.out, 'package-lock.json', 'anthropic-key'));

  // Binary extensions are skipped by design — text rules on binary bytes are
  // noise. Asserted so the exemption stays a decision rather than a surprise.
  const png = scan({ 'image.png': `${v}\n` });
  check('documented binary extensions are skipped', png.status === 0, `exit ${png.status}`);

  // A clean tree must exit 0, or every check above proves nothing.
  const clean = scan({ 'readme.md': 'Nothing secret here.\n' });
  check('a clean repository exits 0', clean.status === 0, `exit ${clean.status}`);
}

/* --------------------------------------------------------------- report */

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} SECRET-SCANNER CHECKS PASSED`);
  process.exit(0);
}
console.log(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
