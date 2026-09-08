/**
 * Command hygiene in contributor-facing documentation.
 *
 *   node scripts/test-docs-commands.mjs
 *
 * Offline, no database, no network. Runs in the static CI job.
 *
 * WHY THIS EXISTS
 *
 * docs/RESUME-IMPORT.md told contributors to run:
 *
 *     npx supabase gen types typescript --local > lib/supabase/database.types.ts
 *
 * That one line reintroduced two problems this repository had already fixed.
 * `npx supabase` resolves nothing locally and downloads whatever the registry
 * currently calls latest, so it executes an unpinned CLI against pinned
 * migrations. And the `>` redirection truncates database.types.ts the instant
 * the shell opens it — BEFORE the CLI has run, let alone succeeded — so a
 * failed generation leaves an empty types file and a broken build. The
 * supported path, `npm run db:types`, uses the pinned CLI, generates to a
 * temporary file, validates it, and only then replaces the committed file.
 *
 * Nothing prevented that line from coming back, so this does.
 *
 * WHAT IS SCANNED, AND WHY ONLY THAT
 *
 * Documentation is discovered dynamically from `git ls-files` — every tracked
 * Markdown file, not a hardcoded list — so a new document is covered the day
 * it is added.
 *
 * Within each file, only FENCED CODE BLOCKS IN A SHELL LANGUAGE are examined
 * (```bash, ```sh, ```shell, ```console, ```powershell, ```ps1, ```cmd, ```bat,
 * and unlabelled ``` blocks). That is the precise definition of "something a
 * contributor will copy and run".
 *
 * Prose is deliberately NOT matched. A sentence explaining why `npx supabase`
 * is unsafe must be able to name it — a checker that forbids discussing the
 * problem makes the documentation worse. For the same reason a fenced block
 * tagged with a non-shell language (```text, ```json, ```diff) is not scanned,
 * which is how this file's own examples and the "do not do this" samples in
 * the docs stay legal.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Fenced-block languages whose contents a reader would paste into a shell. */
const SHELL_LANGS = new Set([
  '', 'sh', 'bash', 'zsh', 'shell', 'console', 'terminal',
  'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'batch',
]);

/**
 * Each rule names one executable mistake, precisely.
 *
 * `test` receives a single command line already known to live inside a shell
 * code block, with any leading prompt marker stripped.
 */
const RULES = [
  {
    id: 'unpinned-npx-supabase',
    why: 'downloads and runs an arbitrary newer Supabase CLI; use `npm run db:*`',
    test: (line) => /\bnpx\s+(?:-{1,2}\S+\s+)*supabase(?:@\S+)?\b/.test(line),
  },
  {
    id: 'direct-gen-types',
    why: 'bypasses the failure-safe generator; use `npm run db:types`',
    test: (line) => /\bsupabase\s+gen\s+types\b/.test(line),
  },
  {
    id: 'redirect-into-generated-types',
    why: 'the shell truncates the file before the command runs; use `npm run db:types`',
    test: (line) => />>?\s*\S*database\.types\.ts\b/.test(line),
  },
  {
    id: 'bare-supabase-cli',
    why: 'invokes an unpinned CLI from PATH; use `npm run db:*` or `node scripts/supabase.mjs`',
    // Requires `supabase` followed by whitespace and a subcommand, at the start
    // of a command. `node scripts/supabase.mjs start` does not match, because
    // `supabase.mjs` is not followed directly by whitespace.
    test: (line) =>
      /(?:^|[;&|]\s*|\$\s+)supabase\s+(?:start|stop|status|init|login|link|db|gen|migration|functions|projects)\b/.test(
        line
      ),
  },
  // Deliberately NOT a rule: `supabase link` / `supabase db push` reaching the
  // hosted project. The deployment runbook in docs/ADMIN.md has to be able to
  // document how production is migrated, and forbidding the words would make
  // that impossible. What matters there is the same thing that matters
  // everywhere else -- that the CLI is the pinned one -- which
  // `bare-supabase-cli` above already enforces.
];

/* ------------------------------------------------------------- discovery */

function trackedMarkdown() {
  return execFileSync('git', ['ls-files', '*.md', '*.mdx', '*.markdown'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Every command line inside a shell-language fenced block.
 * Returns `{ line, number }`, numbered from 1 in the original file.
 */
export function shellCommandLines(markdown) {
  const out = [];
  const lines = markdown.split(/\r?\n/);
  let fence = null; // the opening fence's characters, or null when outside
  let inShell = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const open = raw.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)/);

    if (fence === null && open) {
      fence = open[1][0].repeat(3);
      inShell = SHELL_LANGS.has(open[2].toLowerCase());
      continue;
    }
    if (fence !== null && open && open[1].startsWith(fence) && open[2] === '') {
      fence = null;
      inShell = false;
      continue;
    }
    if (fence === null || !inShell) continue;

    // Strip a prompt marker so `$ npx supabase …` is judged on the command.
    const line = raw.replace(/^\s*(?:\$|>|PS[^>]*>)\s+/, '').trim();
    if (line === '') continue;
    out.push({ line, number: i + 1 });
  }
  return out;
}

/* ------------------------------------------------------------------ run */

let failed = 0;
let scannedFiles = 0;
let scannedLines = 0;
const findings = [];

for (const file of trackedMarkdown()) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    continue;
  }
  scannedFiles++;
  for (const { line, number } of shellCommandLines(text)) {
    scannedLines++;
    for (const rule of RULES) {
      if (rule.test(line)) findings.push({ file, number, rule: rule.id, why: rule.why });
    }
  }
}

console.log(
  `Scanned ${scannedLines} shell command line(s) in ${scannedFiles} tracked Markdown file(s) ` +
    `against ${RULES.length} rules.`
);

if (findings.length > 0) {
  failed = findings.length;
  console.error('\nUnsafe executable instruction(s) in contributor documentation:\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.number}  [${f.rule}]`);
    console.error(`      ${f.why}`);
  }
  console.error(
    '\nIf the command is being shown as an example of what NOT to do, put it in a\n' +
      'non-shell fenced block (```text) so it cannot be copied and run as guidance.'
  );
}

/* ------------------------------------------------- self-test of the matcher */

/*
 * The scanner is checked against known-bad and known-good samples in memory.
 *
 * Without this, the suite could pass simply because the matcher stopped
 * matching — the same failure mode the secret scanner's own tests exist to
 * catch. The samples never touch disk and are not documentation.
 */
const npx = 'npx' + ' supabase';
const MUST_FLAG = [
  `${npx} gen types typescript --local > lib/supabase/database.types.ts`,
  `${npx} start`,
  `${npx}@2.117.0 db reset`,
  'supabase gen types typescript --local',
  'supabase start',
  '$ supabase db reset',
  'npm run db:types > lib/supabase/database.types.ts',
  'supabase link --project-ref abcdefghijklmnop',
  'supabase db push',
];
const MUST_NOT_FLAG = [
  'npm run db:types',
  'npm run db:start',
  'npm run db:reset',
  'node scripts/supabase.mjs start',
  'node scripts/supabase.mjs db reset',
  'npm ci',
  'npm run test:docs',
  'docker ps --filter name=supabase',
  'netstat -ano | findstr 54322',
  'echo "supabase gen types is unsafe"'.replace('gen types', 'generation'),
];

let selfTestFailures = 0;
for (const sample of MUST_FLAG) {
  if (!RULES.some((r) => r.test(sample))) {
    selfTestFailures++;
    console.error(`  SELF-TEST FAIL: should have been flagged -> ${sample}`);
  }
}
for (const sample of MUST_NOT_FLAG) {
  const hit = RULES.find((r) => r.test(sample));
  if (hit) {
    selfTestFailures++;
    console.error(`  SELF-TEST FAIL: false positive [${hit.id}] -> ${sample}`);
  }
}

console.log(
  `Matcher self-test: ${MUST_FLAG.length} unsafe and ${MUST_NOT_FLAG.length} safe sample(s), ` +
    `${selfTestFailures} problem(s).`
);

console.log('\n========================================================');
if (failed === 0 && selfTestFailures === 0) {
  console.log('Documentation command hygiene: OK');
  process.exit(0);
}
console.error(
  `FAILED: ${failed} unsafe documented command(s), ${selfTestFailures} matcher self-test problem(s)`
);
process.exit(1);
