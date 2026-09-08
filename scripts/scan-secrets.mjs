/**
 * Secret scan over tracked files.
 *
 *   node scripts/scan-secrets.mjs           (working tree, tracked files only)
 *   node scripts/scan-secrets.mjs --staged  (what is about to be committed)
 *
 * Contacts nothing, installs nothing, and NEVER prints a matched value — only
 * the file, line number, and which rule fired. A scanner that echoes what it
 * found writes the secret into the CI log it was meant to protect.
 *
 * WHY A LOCAL SCRIPT RATHER THAN A HOSTED SCANNER
 *
 * This repository is public and holds a product that processes other people's
 * résumés. The check has to run on a developer's machine before a commit, not
 * only in CI after a push — by then the value is published and rotation is the
 * only remedy. A dependency-free script runs in both places identically.
 *
 * It is a floor, not a ceiling: it catches the shapes this project actually
 * handles. It is not a substitute for a full entropy scanner, and it cannot see
 * a secret that was never in a tracked file, nor one that survives only in
 * history. History is covered separately, by a history-aware scanner.
 *
 * Its own behaviour is tested by scripts/test-secret-scan.mjs, which plants a
 * representative secret for every rule below and fails if any goes unreported.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const staged = process.argv.includes('--staged');

/**
 * Each rule is a shape this codebase can plausibly leak. Deliberately narrow:
 * a rule that fires constantly gets disabled, and a disabled rule protects
 * nothing.
 */
const RULES = [
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9]{32,}/ },
  { id: 'supabase-secret', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    id: 'postgres-url-with-password',
    re: /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@([^\s/:]+)/,
    /**
     * A connection string is only a secret if it points somewhere real.
     *
     * The local stack's URL is `postgres:postgres@127.0.0.1:54322` — printed by
     * `supabase status`, identical on every machine, and documented. The test
     * fixtures point at RFC 2606 / RFC 5737 reserved names and addresses that
     * exist precisely so examples can be written safely. Flagging either trains
     * people to ignore this scanner, which is worse than not running it.
     */
    ignore: (match) => {
      const host = (match[1] || '').toLowerCase();
      return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1' ||
        host.endsWith('.localhost') ||
        /^(example\.(com|org|net))$/.test(host) ||
        /\.(example|invalid|test|localdomain)$/.test(host) ||
        /^192\.0\.2\.\d{1,3}$/.test(host) ||
        /^198\.51\.100\.\d{1,3}$/.test(host) ||
        /^203\.0\.113\.\d{1,3}$/.test(host)
      );
    },
  },
  { id: 'resend-key', re: /\bre_[A-Za-z0-9]{20,}/ },
];

const RULE_IDS = new Set(RULES.map((r) => r.id));

/**
 * A line may opt out of ONE NAMED RULE, with a reason.
 *
 * The marker token is assembled from parts rather than written out, because
 * this file is itself scanned and a literal occurrence here would read as a
 * malformed marker — the scanner would report itself. Spelled out it is
 * "secret-scan", a colon, then "allow", used like this:
 *
 *     const fixture = '...';  // <marker> rule-id -- why this one is safe
 *
 * SCOPED ON PURPOSE. An earlier version skipped a line entirely on a bare
 * marker, so one comment could hide every rule on that line — including a rule
 * added years later, and including a real key sitting beside the placeholder
 * that justified the marker.
 *
 * A marker that is bare, malformed, or names a rule that does not exist
 * suppresses NOTHING and is itself reported. Suppression can only narrow, never
 * widen, and never silently.
 */
const MARKER = 'secret-scan' + ':' + 'allow';
const MARKER_PRESENT = new RegExp(MARKER + '\\b');
const MARKER_SCOPED = new RegExp(
  MARKER + '\\s+([a-z0-9][a-z0-9-]*)\\s+(?:--|—)\\s*(\\S.*?)\\s*$'
);

/**
 * Files that legitimately contain secret-SHAPED text.
 *
 * EMPTY, and measured rather than assumed. Neither `.env.example` (names with
 * empty values) nor `package-lock.json` (integrity hashes, which no rule here
 * matches — there is no entropy rule) triggers anything, so neither needs an
 * exemption, and both are now scanned like everything else.
 *
 * A whole-file skip is the widest exemption available and the hardest to
 * notice, so the set stays empty until something genuinely needs it. Adding a
 * name is then a visible, reviewable diff rather than an inherited assumption.
 */
const ALLOWED_FILES = new Set([]);

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|ico|mp4|webm|mp3|wav|woff2?|ttf|otf|eot|pdf|zip|gz|br|ipynb)$/i;

function trackedFiles() {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['ls-files'];
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const findings = [];
let scanned = 0;

for (const file of trackedFiles()) {
  if (ALLOWED_FILES.has(file) || BINARY_EXT.test(file)) continue;

  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue; // staged deletion, or a path that no longer exists
  }
  if (size > 2 * 1024 * 1024) continue;

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  // NUL bytes are stripped rather than used to skip the file: lib/resume/apply.ts
  // legitimately contains one as a key separator, and skipping on that basis would
  // quietly exclude a real source file from the scan.
  const NUL = String.fromCharCode(0);
  if (text.includes(NUL)) text = text.split(NUL).join(String.fromCharCode(32));

  scanned++;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Resolve the allow marker FIRST. `allowed` stays null unless the marker is
    // well formed AND names a real rule, so a bad marker suppresses nothing.
    let allowed = null;
    if (MARKER_PRESENT.test(line)) {
      const m = MARKER_SCOPED.exec(line);
      if (!m) {
        findings.push({ file, line: i + 1, rule: 'malformed-allow-marker' });
      } else if (!RULE_IDS.has(m[1])) {
        findings.push({ file, line: i + 1, rule: 'unknown-allow-rule' });
      } else {
        allowed = m[1];
      }
    }

    for (const rule of RULES) {
      if (allowed === rule.id) continue;
      const match = rule.re.exec(line);
      if (!match) continue;
      if (rule.ignore && rule.ignore(match)) continue;
      // File and line only. The value is never recorded.
      findings.push({ file, line: i + 1, rule: rule.id });
    }
  }
}

console.log(`Scanned ${scanned} tracked file(s) with ${RULES.length} rules.`);

if (findings.length === 0) {
  console.log('No secret-shaped content found.');
  process.exit(0);
}

console.error(`\n${findings.length} possible secret(s) — values withheld:\n`);
for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
console.error(
  '\nIf any of these is real: treat it as compromised, rotate it at the provider, ' +
    'and remove it from the file. Rotation first — the value may already be public.'
);
process.exit(1);
