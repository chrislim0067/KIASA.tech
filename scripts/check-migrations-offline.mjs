/**
 * Migration ordering and content parity — offline.
 *
 *   node scripts/check-migrations-offline.mjs
 *   node scripts/check-migrations-offline.mjs --update   (deliberately re-record)
 *
 * Contacts nothing. Reads `supabase/migrations/` and compares it against the
 * committed manifest at `supabase/migrations/checksums.json`. Safe to run in CI
 * with no credentials of any kind.
 *
 * WHAT IT CHECKS, AND WHY EACH ONE EARNED ITS PLACE
 *
 * 1. NAMING. `<14 digits>_<name>.sql`. The Supabase CLI orders by the numeric
 *    prefix; a file that does not carry one is applied in an order nobody
 *    intended.
 *
 * 2. UNIQUE VERSIONS. Two files sharing a prefix are recorded under one version
 *    remotely, so the second silently never runs.
 *
 * 3. DETERMINISTIC ORDER. Lexicographic order over the filenames must equal
 *    numeric order over the versions. Where they disagree, the order the CLI
 *    applies and the order a human reads are different orders.
 *
 * 4. CONTENT PARITY — the one that matters most here.
 *
 *    A migration is applied once and then recorded by version. Editing the file
 *    afterwards changes what a fresh database gets while changing nothing about
 *    a database that already ran it, and the two drift apart in silence. This
 *    project has already been bitten by the adjacent failure: migration
 *    20260908000020 was edited in place after being written, and separately had
 *    not been applied to production while code depending on it was live — every
 *    résumé import failed at the insert.
 *
 *    The manifest makes that visible. Any change to an already-recorded
 *    migration fails this check, and clearing the failure means running
 *    `--update` deliberately — a diff a reviewer can see and question.
 *
 *    CHECK MODE FAILS CLOSED. A migration that is not in the manifest is a
 *    failure, not a note: an earlier version printed "not a failure" and
 *    exited 0, which let a migration sit unrecorded indefinitely and removed
 *    the guarantee the manifest exists for — that every migration has a
 *    recorded digest, so a later edit is detectable. Recording is only ever
 *    done by an explicit `--update`.
 *
 * WHAT IT CANNOT CHECK
 *
 * Whether production has actually applied them. That requires talking to the
 * database, which this script deliberately never does. Proving remote state is
 * a separate, credentialed step in the deploy runbook.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'supabase', 'migrations');
const MANIFEST = join(DIR, 'checksums.json');
const NAME_RE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

const update = process.argv.includes('--update');
const failures = [];
const fail = (message) => failures.push(message);

if (!existsSync(DIR)) {
  console.error(`No migrations directory at ${DIR}`);
  process.exit(2);
}

const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('No migrations found.');
  process.exit(2);
}

/* ------------------------------------------------------------------ naming */

const versions = [];
for (const name of files) {
  const match = NAME_RE.exec(name);
  if (!match) {
    fail(`Name does not match <14 digits>_<lower_snake>.sql: ${name}`);
    continue;
  }
  versions.push({ version: match[1], name });
}

/* ---------------------------------------------------------------- uniqueness */

const seen = new Map();
for (const { version, name } of versions) {
  if (seen.has(version)) fail(`Duplicate version ${version}: ${seen.get(version)} and ${name}`);
  else seen.set(version, name);
}

/* ------------------------------------------------------------------ ordering */

const byNumber = [...versions].sort((a, b) => a.version.localeCompare(b.version));
for (let i = 0; i < versions.length; i++) {
  if (versions[i].name !== byNumber[i].name) {
    fail(
      `Filename order and version order disagree at position ${i}: ` +
        `${versions[i].name} vs ${byNumber[i].name}`
    );
    break;
  }
}

for (let i = 1; i < byNumber.length; i++) {
  if (byNumber[i].version <= byNumber[i - 1].version) {
    fail(`Versions are not strictly increasing: ${byNumber[i - 1].name} then ${byNumber[i].name}`);
  }
}

/* -------------------------------------------------------------- empty files */

for (const { name } of versions) {
  const body = readFileSync(join(DIR, name), 'utf8').trim();
  if (body === '') fail(`Migration is empty: ${name}`);
}

/* ----------------------------------------------------------- dollar quoting */

/*
 * EVERY DOLLAR-QUOTED BLOCK MUST CLOSE.
 *
 * A migration whose $$ or $fn$ delimiters do not pair is not a migration that
 * fails a check -- it is a syntax error, and the only place it surfaces is the
 * moment the stack applies it. From outside CI that looks identical to the
 * database failing to boot: exit code 1, no annotation, nothing naming a file.
 *
 * Not hypothetical. Migration 26 was corrupted by an editing script whose
 * replacement text contained a dollar-apostrophe, which String.replace expands
 * to "everything after the match"; the truncated function body then cost two CI
 * cycles before anyone counted the delimiters. Ten lines here catch it offline,
 * in a second.
 *
 * Parity only: this proves the delimiters pair, not that the SQL between them
 * is correct. Postgres is the authority on that, and CI still asks it.
 */
for (const { name } of versions) {
  const body = readFileSync(join(DIR, name), 'utf8');
  const tags = new Map();
  for (const [tag] of body.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g)) {
    tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  for (const [tag, count] of tags) {
    if (count % 2 !== 0) {
      fail(`Unbalanced dollar quoting in ${name}: ${tag} appears ${count} time(s)`);
    }
  }
}

/* ---------------------------------------------------------------- checksums */

/**
 * Hash the CONTENT, not the platform.
 *
 * git normalises line endings on checkout: with core.autocrlf=true a Windows
 * working tree holds CRLF while a Linux CI runner holds LF for the very same
 * committed blob. Hashing the raw bytes therefore made every migration look
 * "edited in place" the moment the manifest crossed platforms -- recorded on
 * Windows, checked on ubuntu-latest, twenty false failures.
 *
 * Normalising CRLF to LF first makes the manifest describe the migration
 * rather than the checkout it happened to be recorded from. A real edit still
 * changes the hash; a checkout on a different platform no longer does.
 */
const sha256 = (name) =>
  createHash('sha256')
    .update(readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');

const current = Object.fromEntries(versions.map(({ name }) => [name, sha256(name)]));

if (update) {
  writeFileSync(MANIFEST, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  console.log(`Recorded ${Object.keys(current).length} migration checksum(s) in ${MANIFEST}`);
  if (failures.length > 0) {
    console.error('\nOrdering problems remain:');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

const DIGEST_RE = /^[a-f0-9]{64}$/;

if (!existsSync(MANIFEST)) {
  fail(`No checksum manifest. Create it deliberately: node ${process.argv[1]} --update`);
} else {
  // A manifest that is not readable JSON is a failure, not a crash. An
  // uncaught SyntaxError exits non-zero too, but it prints a stack trace
  // instead of saying which file is wrong and what to do about it.
  let recorded = null;
  try {
    recorded = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (error) {
    fail(`Manifest is not valid JSON (${MANIFEST}): ${error.message}`);
  }

  if (recorded !== null && (typeof recorded !== 'object' || Array.isArray(recorded))) {
    fail('Manifest must be a JSON object mapping migration filename to SHA-256 digest.');
    recorded = null;
  }

  if (recorded !== null) {
    for (const [name, hash] of Object.entries(recorded)) {
      // An entry that is not a migration filename cannot describe a migration.
      // Left unchecked it is a silent typo: the real file then reads as
      // unrecorded, and the stale key is never compared against anything.
      if (!NAME_RE.test(name)) {
        fail(`Manifest entry is not a valid migration filename: ${name}`);
        continue;
      }
      if (typeof hash !== 'string' || !DIGEST_RE.test(hash)) {
        fail(
          `Manifest entry ${name} does not hold a SHA-256 digest ` +
            `(expected 64 lowercase hex characters).`
        );
        continue;
      }
      if (!(name in current)) {
        fail(`Recorded migration has been deleted or renamed: ${name}`);
      } else if (current[name] !== hash) {
        fail(
          `Recorded migration was edited in place: ${name}. A database that already ` +
            `applied it will not see the change. Write a new migration, or run --update ` +
            `if this file has genuinely never been applied anywhere.`
        );
      }
    }

    /*
     * A NEW MIGRATION IS A FAILURE IN CHECK MODE.
     *
     * This previously printed "not a failure" and exited 0, which made the
     * manifest advisory: a migration could sit outside it indefinitely, and
     * the one guarantee the manifest exists to provide -- that every migration
     * has a recorded digest, so a later edit is detectable -- simply did not
     * hold for the newest and most likely to be edited file.
     *
     * Recording it is a deliberate act (`--update`) that shows up as a diff a
     * reviewer can question. Check mode never records anything.
     */
    const added = Object.keys(current).filter((name) => !(name in recorded));
    if (added.length > 0) {
      fail(
        `Migration(s) not recorded in the manifest: ${added.join(', ')}. ` +
          `Record them deliberately: node ${process.argv[1]} --update`
      );
    }
  }
}

/* ------------------------------------------------------------------- report */

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(`${files.length} migration(s): naming, uniqueness, ordering and content parity all OK.`);
process.exit(0);
