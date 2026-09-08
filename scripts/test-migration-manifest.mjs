/**
 * Tests for the migration manifest checker.
 *
 *   node scripts/test-migration-manifest.mjs
 *
 * Runs entirely in throwaway directories under the system temp dir. Contacts
 * nothing, needs no database, and touches no file in this repository — the
 * checker resolves `supabase/migrations` relative to its working directory, so
 * each case builds a miniature repository and runs the real script inside it.
 *
 * WHY THIS EXISTS
 *
 * `check-migrations-offline.mjs` used to report an unrecorded migration and
 * then exit 0. That is the failure mode a checker is least likely to notice
 * about itself: it printed something, CI was green, and the newest migration —
 * the one most likely to still be edited — was the one with no recorded
 * digest. Nothing tested the checker, so nothing caught it.
 *
 * Every case below asserts the EXIT CODE, because that is what CI reads. A
 * message on stdout that nobody gates on is not a check.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), 'check-migrations-offline.mjs');

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

const A_SQL = 'create table a (id uuid primary key);\nselect 1;\n';
const B_SQL = 'create table b (id uuid primary key);\nselect 2;\n';

/** Build a throwaway repo. `files` maps migration filename to contents. */
function makeRepo(files, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'kiasa-mig-test-'));
  const mig = join(dir, 'supabase', 'migrations');
  mkdirSync(mig, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(mig, name), body);
  }
  if (manifest !== undefined) {
    writeFileSync(
      join(mig, 'checksums.json'),
      typeof manifest === 'string' ? manifest : `${JSON.stringify(manifest, null, 2)}\n`
    );
  }
  return dir;
}

/** Run the checker inside `dir`. Returns exit status and combined output. */
function run(dir, args = []) {
  try {
    const out = execFileSync(process.execPath, [CHECKER, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, out };
  } catch (e) {
    return { status: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

/** Record a manifest for `files`, then return the repo directory. */
function repoWithRecordedManifest(files) {
  const dir = makeRepo(files);
  const r = run(dir, ['--update']);
  if (r.status !== 0) throw new Error(`--update failed while building fixture: ${r.out}`);
  return dir;
}

const cleanup = [];
const track = (dir) => {
  cleanup.push(dir);
  return dir;
};

try {
  /* ------------------------------------------------------ 1. valid passes */

  section('1. A manifest that matches the migrations passes');
  {
    const dir = track(repoWithRecordedManifest({ '20260101000001_a.sql': A_SQL }));
    const r = run(dir);
    check('valid manifest exits 0', r.status === 0, `exit ${r.status}`);
    check('and says so', /content parity all OK/.test(r.out));
  }

  /* --------------------------------------- 2. new migration FAILS CLOSED */

  section('2. A new migration that is not in the manifest FAILS');
  {
    const dir = track(repoWithRecordedManifest({ '20260101000001_a.sql': A_SQL }));
    writeFileSync(join(dir, 'supabase', 'migrations', '20260101000002_b.sql'), B_SQL);
    const r = run(dir);
    check('unrecorded migration exits non-zero', r.status === 1, `exit ${r.status}`);
    check('and names the file', /20260101000002_b\.sql/.test(r.out));
    check('and does not call it "not a failure"', !/not a failure/.test(r.out));
  }

  /* --------------------------------------------- 3. --update records it */

  section('3. Only an explicit --update records the new migration');
  {
    const dir = track(repoWithRecordedManifest({ '20260101000001_a.sql': A_SQL }));
    writeFileSync(join(dir, 'supabase', 'migrations', '20260101000002_b.sql'), B_SQL);

    const before = run(dir);
    check('check mode fails first', before.status === 1, `exit ${before.status}`);

    const upd = run(dir, ['--update']);
    check('--update exits 0', upd.status === 0, `exit ${upd.status}`);

    const after = run(dir);
    check('check mode passes afterwards', after.status === 0, `exit ${after.status}`);

    const manifest = JSON.parse(
      readFileSync(join(dir, 'supabase', 'migrations', 'checksums.json'), 'utf8')
    );
    check('both migrations are now recorded', Object.keys(manifest).length === 2,
      `${Object.keys(manifest).length} entries`);

    // Check mode must never write. If it did, every one of these cases would
    // pass on a second run regardless of what it found.
    const dir2 = track(repoWithRecordedManifest({ '20260101000001_a.sql': A_SQL }));
    writeFileSync(join(dir2, 'supabase', 'migrations', '20260101000002_b.sql'), B_SQL);
    const mPath = join(dir2, 'supabase', 'migrations', 'checksums.json');
    const mBefore = readFileSync(mPath, 'utf8');
    run(dir2);
    check('check mode did not modify the manifest', readFileSync(mPath, 'utf8') === mBefore);
  }

  /* ----------------------------------------------- 4. later edit fails */

  section('4. Editing a recorded migration afterwards FAILS');
  {
    const dir = track(
      repoWithRecordedManifest({ '20260101000001_a.sql': A_SQL, '20260101000002_b.sql': B_SQL })
    );
    check('clean to start', run(dir).status === 0);

    writeFileSync(
      join(dir, 'supabase', 'migrations', '20260101000002_b.sql'),
      B_SQL + 'alter table b add column extra text;\n'
    );
    const r = run(dir);
    check('edited migration exits non-zero', r.status === 1, `exit ${r.status}`);
    check('and says it was edited in place', /edited in place/.test(r.out));
  }

  /* ------------------------------------- 5. CRLF and LF are equivalent */

  section('5. CRLF and LF versions of identical content are equivalent');
  {
    const lf = '20260101000001_a.sql';
    const dir = track(repoWithRecordedManifest({ [lf]: A_SQL }));

    // Rewrite the same content with Windows line endings. The bytes differ;
    // the migration does not. This is the exact false failure that broke the
    // first CI run: a manifest recorded on Windows, checked on ubuntu.
    writeFileSync(join(dir, 'supabase', 'migrations', lf), A_SQL.replace(/\n/g, '\r\n'));
    const asCrlf = run(dir);
    check('LF-recorded manifest accepts a CRLF checkout', asCrlf.status === 0,
      `exit ${asCrlf.status}`);

    // And the reverse: record from CRLF, verify against LF.
    const dir2 = track(repoWithRecordedManifest({ [lf]: A_SQL.replace(/\n/g, '\r\n') }));
    writeFileSync(join(dir2, 'supabase', 'migrations', lf), A_SQL);
    const asLf = run(dir2);
    check('CRLF-recorded manifest accepts an LF checkout', asLf.status === 0,
      `exit ${asLf.status}`);

    // A genuine content change must still be caught under both endings, or the
    // normalisation above would just be blindness.
    writeFileSync(join(dir2, 'supabase', 'migrations', lf), A_SQL + '-- changed\n');
    check('a real edit is still caught after normalisation', run(dir2).status === 1);
  }

  /* -------------------------------------------------- 6. failure cases */

  section('6. Deleted, renamed, duplicate, empty and malformed all FAIL');

  {
    const dir = track(
      repoWithRecordedManifest({ '20260101000001_a.sql': A_SQL, '20260101000002_b.sql': B_SQL })
    );
    rmSync(join(dir, 'supabase', 'migrations', '20260101000002_b.sql'));
    const r = run(dir);
    check('deleted migration fails', r.status === 1, `exit ${r.status}`);
    check('  and says deleted or renamed', /deleted or renamed/.test(r.out));
  }

  {
    const dir = track(repoWithRecordedManifest({ '20260101000001_a.sql': A_SQL }));
    const m = join(dir, 'supabase', 'migrations');
    writeFileSync(join(m, '20260101000009_renamed.sql'), A_SQL);
    rmSync(join(m, '20260101000001_a.sql'));
    const r = run(dir);
    check('renamed migration fails', r.status === 1, `exit ${r.status}`);
  }

  {
    // Two files, one timestamp: the second is recorded under the same version
    // remotely and silently never runs.
    const dir = track(
      makeRepo({ '20260101000001_a.sql': A_SQL, '20260101000001_b.sql': B_SQL }, {})
    );
    const r = run(dir);
    check('duplicate timestamps fail', r.status === 1, `exit ${r.status}`);
    check('  and says duplicate', /Duplicate version/i.test(r.out));
  }

  {
    const dir = track(makeRepo({ 'not-a-migration.sql': A_SQL }, {}));
    const r = run(dir);
    check('invalid filename fails', r.status === 1, `exit ${r.status}`);
  }

  {
    const dir = track(makeRepo({ '20260101000001_a.sql': '   \n\n' }, {}));
    const r = run(dir);
    check('empty migration fails', r.status === 1, `exit ${r.status}`);
    check('  and says empty', /is empty/i.test(r.out));
  }

  {
    const dir = track(makeRepo({ '20260101000001_a.sql': A_SQL }, '{ this is not json'));
    const r = run(dir);
    check('malformed JSON manifest fails', r.status === 1, `exit ${r.status}`);
    check('  and reports it as invalid JSON, not a stack trace',
      /not valid JSON/i.test(r.out) && !/at Object\.<anonymous>/.test(r.out));
  }

  {
    const dir = track(makeRepo({ '20260101000001_a.sql': A_SQL }, '["an","array"]'));
    const r = run(dir);
    check('a JSON array manifest fails', r.status === 1, `exit ${r.status}`);
  }

  {
    const dir = track(makeRepo({ '20260101000001_a.sql': A_SQL }, {
      '20260101000001_a.sql': 'not-a-digest',
    }));
    const r = run(dir);
    check('invalid digest format fails', r.status === 1, `exit ${r.status}`);
    check('  and says SHA-256 is expected', /SHA-256 digest/i.test(r.out));
  }

  {
    // Uppercase hex and wrong length are both not the digest format written.
    const dir = track(makeRepo({ '20260101000001_a.sql': A_SQL }, {
      '20260101000001_a.sql': 'A'.repeat(64),
    }));
    check('uppercase digest fails', run(dir).status === 1);

    const dir2 = track(makeRepo({ '20260101000001_a.sql': A_SQL }, {
      '20260101000001_a.sql': 'abc123',
    }));
    check('short digest fails', run(dir2).status === 1);
  }

  {
    const dir = track(repoWithRecordedManifest({ '20260101000001_a.sql': A_SQL }));
    const mPath = join(dir, 'supabase', 'migrations', 'checksums.json');
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    m['this is not a migration filename'] = 'f'.repeat(64);
    writeFileSync(mPath, `${JSON.stringify(m, null, 2)}\n`);
    const r = run(dir);
    check('unexpected manifest entry fails', r.status === 1, `exit ${r.status}`);
    check('  and says it is not a valid migration filename',
      /not a valid migration filename/i.test(r.out));
  }

  {
    const dir = track(makeRepo({ '20260101000001_a.sql': A_SQL }));
    const r = run(dir); // no manifest at all
    check('a missing manifest fails', r.status === 1, `exit ${r.status}`);
  }

  {
    // Ordering: filename order and numeric version order must agree.
    const dir = track(makeRepo({}, {}));
    const r = run(dir);
    check('no migrations at all fails', r.status !== 0, `exit ${r.status}`);
  }
} finally {
  for (const dir of cleanup) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} MIGRATION-MANIFEST CHECKS PASSED`);
  process.exit(0);
}
console.log(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
