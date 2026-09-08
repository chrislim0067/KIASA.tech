/**
 * Finding executable commands in Markdown, and judging them.
 *
 * Pure and side-effect free on import, which is the point: the previous
 * version did its work at module scope and called `process.exit`, so the
 * parser could not be imported and tested. Its "self-test" therefore only ever
 * ran regular expressions against hand-written strings — it never exercised
 * the Markdown parser at all, and a fence-handling bug walked straight past it.
 *
 * FENCE PARSING FOLLOWS CommonMark
 *
 * The rule that matters: a closing fence must use the SAME character as the
 * opening fence and be AT LEAST AS LONG. A shorter run inside a longer block
 * is ordinary content.
 *
 * The earlier implementation recorded every fence as three characters
 * (`open[1][0].repeat(3)`), so a three-backtick line closed a four-backtick
 * block. This was a real bypass:
 *
 *     ````bash
 *     echo "safe first line"
 *     ```                      <- treated as the close; it is not
 *     npx supabase start       <- therefore never scanned
 *     ````
 *
 * That document is valid Markdown and the unsafe command really is inside the
 * bash block. It is now a permanent regression case.
 */

/** Fenced-block languages whose contents a reader would paste into a shell. */
export const SHELL_LANGS = new Set([
  '', 'sh', 'bash', 'zsh', 'shell', 'console', 'terminal',
  'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'batch',
]);

/* ------------------------------------------------------------- the parser */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)[^\n]*$/;
const CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Every command line inside a shell-language fenced block.
 *
 * Returns `{ line, number }` with `number` counted from 1 in the original
 * document. Handles LF and CRLF. An UNTERMINATED shell block still yields its
 * contents — a document that forgets a closing fence must not become a blind
 * spot.
 */
export function shellCommandLines(markdown) {
  const out = [];
  const lines = String(markdown).split(/\r?\n/);

  let openChar = null; // '`' or '~'
  let openLen = 0;
  let inShell = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    if (openChar === null) {
      const m = FENCE_RE.exec(raw);
      if (m) {
        openChar = m[1][0];
        openLen = m[1].length;
        // An info string may only be a language when it has no backtick in it
        // (CommonMark forbids backticks in a backtick-fence info string).
        const info = m[2].toLowerCase();
        inShell = SHELL_LANGS.has(info);
      }
      continue;
    }

    // Inside a block: only a fence of the SAME character, at least as long,
    // with nothing but whitespace after it, closes it.
    const c = CLOSE_RE.exec(raw);
    if (c && c[1][0] === openChar && c[1].length >= openLen) {
      openChar = null;
      openLen = 0;
      inShell = false;
      continue;
    }

    if (!inShell) continue;

    // Strip a prompt marker so `$ npx supabase …` is judged on the command.
    const line = raw.replace(/^\s*(?:\$|>|PS[^>]*>)\s+/, '').trim();
    if (line === '') continue;
    out.push({ line, number: i + 1 });
  }

  return out;
}

/* -------------------------------------------------------------- the rules */

/**
 * Package runners that fetch and execute whatever is newest.
 * `npm exec` is included with and without the `--` separator.
 */
const RUNNER = String.raw`(?:npx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec(?:\s+--)?|pnpm\s+exec|yarn\s+exec)`;

/**
 * Command prefixes that wrap another command without changing what it is:
 * `sudo supabase …` is still a bare CLI invocation.
 */
const WRAPPER = String.raw`(?:sudo(?:\s+-\S+)*\s+|command\s+|exec\s+|time\s+|env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*|cmd(?:\.exe)?\s+/[a-zA-Z]\s+|powershell(?:\.exe)?\s+-\S+\s+)`;

const SUBCOMMANDS =
  '(?:start|stop|status|init|login|link|db|gen|migration|functions|projects|test|inspect|secrets|branches)';

export const RULES = [
  {
    id: 'unpinned-cli-runner',
    why: 'downloads and runs an arbitrary newer Supabase CLI; use `npm run db:*`',
    test: (line) =>
      new RegExp(String.raw`(?:^|[;&|]\s*)${RUNNER}\s+(?:-{1,2}\S+\s+)*supabase(?:@\S+)?\b`).test(line),
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
    // `node scripts/supabase.mjs start` does not match: `supabase.mjs` is not
    // `supabase` followed by whitespace.
    test: (line) =>
      new RegExp(
        String.raw`(?:^|[;&|]\s*|\$\s+)(?:${WRAPPER})*supabase\s+${SUBCOMMANDS}\b`
      ).test(line),
  },
];

/**
 * Stale claims that are wrong rather than unsafe, checked over the WHOLE
 * document rather than only its shell blocks, because prose can be just as
 * misleading as a command.
 *
 * `db push` applies whatever the linked project considers pending. Telling a
 * reader it "applies 14–17" invites them to run it believing 18, 19 and 20
 * will be left alone.
 */
export const STALE_CLAIMS = [
  {
    id: 'stale-migration-range-applied',
    why: 'the hosted migration history is unverified; do not assert a fixed applied range',
    test: (text) => /confirm\s+1\s*[‐-―-]\s*13\s+are\s+applied/i.test(text),
  },
  {
    id: 'stale-migration-range-pushed',
    why: '`db push` applies all pending migrations, not a fixed range',
    test: (text) => /applies\s+14\s*[‐-―-]\s*17\b/i.test(text),
  },
  {
    id: 'asserted-applied-migration-range',
    // Matches an ASSERTION that a fixed range is applied, in either voice:
    // "migrations 1–13 applied", "has migrations 1-13 applied".
    // Deliberately does NOT match the historical note "migrations 14–17 are
    // the ones that introduced …", which describes what they contain rather
    // than claiming what production currently has.
    why: 'the hosted migration history is unverified; never assert a fixed applied range',
    test: (text) =>
      /migrations?\s+\d+\s*[‐-―-]\s*\d+\s+(?:are\s+|is\s+|were\s+|has\s+been\s+)?applied/i.test(text),
  },
  {
    id: 'hardcoded-migration-count',
    // A literal count of the migration directory goes stale the next time one
    // is added, and this document is read while pointing at production.
    why: 'do not hardcode how many migrations exist; read the directory',
    test: (text) =>
      /\b(?:holding|contains?|currently\s+has|there\s+are)\s+(?:twenty|thirty|forty|\d{1,3})\s+migrations\b/i.test(
        text
      ),
  },
];

/* ------------------------------------------------------------ the scanner */

/**
 * Scan one document. Returns findings; never throws on odd input.
 * `{ file, number, rule, why }`, with `number` 0 for whole-document claims.
 */
export function scanMarkdown(file, text) {
  const findings = [];
  for (const { line, number } of shellCommandLines(text)) {
    for (const rule of RULES) {
      if (rule.test(line)) findings.push({ file, number, rule: rule.id, why: rule.why });
    }
  }
  for (const claim of STALE_CLAIMS) {
    if (claim.test(String(text))) {
      findings.push({ file, number: 0, rule: claim.id, why: claim.why });
    }
  }
  return findings;
}
