/**
 * Command hygiene in contributor-facing documentation.
 *
 *   node scripts/test-docs-commands.mjs
 *
 * Offline, no database, no network. Runs in the static CI job.
 *
 * WHY THIS EXISTS
 *
 * docs/RESUME-IMPORT.md once told contributors to run:
 *
 *     npx supabase gen types typescript --local > lib/supabase/database.types.ts
 *
 * `npx` executes an unpinned CLI, and the `>` truncates database.types.ts the
 * instant the shell opens it — before the command has run at all — so a failed
 * generation leaves an empty file and a broken build. `npm run db:types` uses
 * the pinned CLI, writes to a temporary file, validates it, and only then
 * replaces the committed one.
 *
 * WHAT IS CHECKED
 *
 *   1. The parser itself, end to end, against in-memory documents. The
 *      previous version tested only regular expressions against strings, so a
 *      fence-handling bug let a valid four-backtick block hide an unsafe
 *      command while the suite reported "OK".
 *   2. The rules, against known-unsafe and known-safe command lines.
 *   3. Every tracked Markdown file in the repository, discovered dynamically.
 *
 * Only fenced blocks in a shell language are treated as executable. Prose
 * explaining why a command is unsafe must be able to name it, and a ```text or
 * ```json block showing what NOT to do must stay legal — otherwise the checker
 * makes the documentation worse.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { RULES, STALE_CLAIMS, scanMarkdown, shellCommandLines } from './lib/doc-commands.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

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

/* Built at runtime so this file never contains the literal it forbids. */
const NPX = 'npx' + ' supabase';
const BAD_GEN = `${NPX} gen types typescript --local > lib/supabase/database.types.ts`;
const T3 = '`'.repeat(3);
const T4 = '`'.repeat(4);
const W3 = '~'.repeat(3);
const W4 = '~'.repeat(4);

/** Does scanning this in-memory document report anything? */
const scan = (text) => scanMarkdown('memory.md', text);
const flagged = (text) => scan(text).length > 0;
const commands = (text) => shellCommandLines(text).map((c) => c.line);

/* ------------------------------------------------- 1. the parser, end to end */

section('1. Fence parsing (end to end, in memory)');

check(
  'three-backtick bash block is scanned',
  flagged(`${T3}bash\n${NPX} start\n${T3}\n`)
);

/*
 * THE REGRESSION CASE.
 *
 * Valid CommonMark: the inner three-backtick run cannot close a four-backtick
 * fence, so the unsafe command is still inside the bash block. The previous
 * parser recorded every fence as three characters and exited 0 on this.
 */
const FOUR_BACKTICK_BYPASS =
  `# Fixture\n\n${T4}bash\necho "safe first line"\n${T3}\n${NPX} start\n${T4}\n`;
check(
  'four-backtick block containing three backticks: inner run is CONTENT',
  flagged(FOUR_BACKTICK_BYPASS),
  'the reproduced bypass'
);
check(
  '  and the unsafe line is actually reached by the parser',
  commands(FOUR_BACKTICK_BYPASS).some((l) => l.includes('start')),
  commands(FOUR_BACKTICK_BYPASS).join(' | ')
);

check(
  'four-tilde shell block containing three tildes',
  flagged(`${W4}shell\necho ok\n${W3}\n${NPX} start\n${W4}\n`)
);

check(
  'a closing fence LONGER than its opening still closes',
  !flagged(`${T3}bash\necho ok\n${'`'.repeat(5)}\n${NPX} start\n`),
  'command after the close is outside the block'
);

check(
  'mismatched fence characters do not close',
  flagged(`${T3}bash\n${W3}\n${NPX} start\n${T3}\n`),
  'a tilde run cannot close a backtick fence'
);

check(
  'CRLF input parses identically',
  flagged(`${T4}bash\r\necho ok\r\n${T3}\r\n${NPX} start\r\n${T4}\r\n`)
);

check('unlabelled block is treated as shell', flagged(`${T3}\n${NPX} start\n${T3}\n`));

check(
  'unterminated shell block is still inspected',
  flagged(`${T3}bash\n${NPX} start\n`),
  'a missing closing fence must not become a blind spot'
);

for (const lang of ['text', 'json', 'typescript', 'ts', 'diff', 'yaml']) {
  check(
    `non-shell \`${lang}\` block is ignored`,
    !flagged(`${T3}${lang}\n${NPX} start\n${T3}\n`)
  );
}

check(
  'prose mentioning the command is ignored',
  !flagged(`Never run \`${NPX} start\`; it downloads an unpinned CLI.\n`)
);

check(
  'PowerShell prompt marker is stripped',
  flagged(`${T3}powershell\nPS C:\\repo> ${NPX} start\n${T3}\n`)
);
check(
  'console prompt marker is stripped',
  flagged(`${T3}console\n$ ${NPX} start\n${T3}\n`)
);

check(
  'indented fences (up to 3 spaces) are honoured',
  flagged(`   ${T3}bash\n   ${NPX} start\n   ${T3}\n`)
);

/* ----------------------------------------------------- 2. the rules */

section('2. Rules: unsafe command lines must be flagged');

const MUST_FLAG = [
  BAD_GEN,
  `${NPX} start`,
  `${NPX}@2.117.0 db reset`,
  'npm exec supabase start',
  'npm exec -- supabase db reset',
  'pnpm dlx supabase start',
  'yarn dlx supabase start',
  'bunx supabase start',
  'supabase gen types typescript --local',
  'supabase start',
  '$ supabase db reset',
  'sudo supabase start',
  'command supabase start',
  'env SUPABASE_DEBUG=1 supabase start',
  'cmd /c supabase start',
  'npm run db:types > lib/supabase/database.types.ts',
];
for (const sample of MUST_FLAG) {
  const hit = RULES.find((r) => r.test(sample));
  check(`flagged: ${sample.slice(0, 62)}`, Boolean(hit), hit ? hit.id : 'NOT FLAGGED');
}

section('3. Rules: safe command lines must NOT be flagged');

const MUST_NOT_FLAG = [
  'npm run db:types',
  'npm run db:start',
  'npm run db:stop',
  'npm run db:reset',
  'npm run check:cli',
  'npm run check:exposure',
  'node scripts/supabase.mjs start',
  'node scripts/supabase.mjs db reset',
  'node scripts/supabase.mjs link --project-ref <ref>',
  'node scripts/supabase.mjs db push',
  'npm ci',
  'npm run test:docs',
  'docker ps --filter "name=supabase"',
  'docker inspect supabase_db_kiasa --format "{{json .NetworkSettings.Ports}}"',
  'Test-NetConnection 127.0.0.1 -Port 54322 -InformationLevel Quiet',
  'git ls-files',
];
for (const sample of MUST_NOT_FLAG) {
  const hit = RULES.find((r) => r.test(sample));
  check(`clean: ${sample.slice(0, 62)}`, !hit, hit ? `false positive [${hit.id}]` : '');
}

/* ------------------------------------------------- 4. stale claim rules */

section('4. Stale deployment claims');

check(
  'a fixed "confirm 1-13 are applied" claim is rejected',
  STALE_CLAIMS.some((c) => c.test('supabase migration list      # confirm 1–13 are applied'))
);
check(
  'a fixed "applies 14-17" claim is rejected',
  STALE_CLAIMS.some((c) => c.test('db push             # applies 14–17'))
);
check(
  'the ASCII-hyphen spelling is rejected too',
  STALE_CLAIMS.some((c) => c.test('# applies 14-17'))
);
check(
  'honest language about pending migrations is accepted',
  !STALE_CLAIMS.some((c) =>
    c.test('Review the full pending plan; `db push` applies every pending migration.')
  )
);

/* The two claims removed from docs/ADMIN.md in this pass. */
for (const sample of [
  'Not confirmed that production has migrations 1–13 applied.',
  'Not confirmed that production has migrations 1-13 applied.',
  'migrations 1–20 are applied',
  'migrations 5–9 were applied',
]) {
  check(
    `asserting a fixed applied range is rejected: "${sample.slice(0, 48)}"`,
    STALE_CLAIMS.some((c) => c.test(sample))
  );
}

for (const sample of [
  'with `supabase/migrations/` currently holding twenty migrations',
  'the directory contains 20 migrations',
  'there are 20 migrations',
]) {
  check(
    `a hardcoded migration count is rejected: "${sample.slice(0, 48)}"`,
    STALE_CLAIMS.some((c) => c.test(sample))
  );
}

for (const sample of [
  'migrations 14–17 are the ones that introduced the administrator surface',
  'The hosted migration history is unverified.',
  'It applies every migration the linked project considers pending',
  'read the directory, and read the plan',
]) {
  check(
    `honest/historical wording is accepted: "${sample.slice(0, 48)}"`,
    !STALE_CLAIMS.some((c) => c.test(sample))
  );
}

/* ------------------------------------------- 5. the repository itself */

section('5. Tracked documentation');

function trackedMarkdown() {
  return execFileSync('git', ['ls-files', '*.md', '*.mdx', '*.markdown'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const files = trackedMarkdown();
check('markdown discovery is dynamic and non-empty', files.length > 0, `${files.length} file(s)`);

let lineCount = 0;
const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    continue;
  }
  lineCount += shellCommandLines(text).length;
  findings.push(...scanMarkdown(file, text));
}

check(
  'no unsafe or stale instruction in tracked documentation',
  findings.length === 0,
  findings.length === 0
    ? `${lineCount} shell command line(s) across ${files.length} file(s)`
    : `${findings.length} finding(s)`
);
for (const f of findings) {
  console.log(`        ${f.file}${f.number ? ':' + f.number : ''}  [${f.rule}]  ${f.why}`);
}

/* ------------------------------------------------------------- report */

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} DOCUMENTATION COMMAND-HYGIENE CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
if (findings.length > 0) {
  console.error(
    '\nIf a command is being shown as an example of what NOT to do, put it in a\n' +
      'non-shell fenced block (```text) so it cannot be copied and run as guidance.'
  );
}
process.exit(1);
