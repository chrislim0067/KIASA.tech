/**
 * ONE live OpenRouter request. Local only.
 *
 *   npm run smoke:openrouter
 *
 * THIS IS THE ONLY SCRIPT IN THE REPOSITORY THAT SPENDS MONEY, and it spends
 * it once. CI never runs it — there is no workflow step for it, and it refuses
 * to run when `CI` is set, so a future step added by accident still cannot
 * bill anyone.
 *
 * WHAT IT SENDS
 *
 * A synthetic job posting and a synthetic candidate summary, both written into
 * this file. NO REAL CANDIDATE DATA, no résumé, no employer, no PII. Nothing
 * is fetched, no site is opened, and no application is submitted.
 *
 * WHAT IT PRINTS
 *
 * Model, latency, status, token counts and reported cost. It never prints the
 * key, its length, or a prefix of it; it never prints the prompt; and it
 * prints only bounded, redacted fields of the response.
 *
 * HOW IT FAILS
 *
 * Closed. A missing key or an unset `OPENROUTER_MODEL` exits 0 with an
 * explanation and MAKES NO REQUEST, because the alternative is billing someone
 * for a call that was never going to be valid.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* --------------------------------------------------------- environment */

/**
 * Load `.env.local` if present.
 *
 * Read into `process.env` and never echoed. Next.js loads this file for the
 * app; a plain node script does not, so the smoke test would otherwise report
 * "not configured" on a machine where the key is sitting right there.
 */
function loadEnvLocal() {
  for (const candidate of ['.env.local', '.env']) {
    const file = path.join(ROOT, candidate);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      // Never overwrite a value the shell already set.
      if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
    return candidate;
  }
  return null;
}

const envFile = loadEnvLocal();

if (process.env.CI) {
  console.error('REFUSING: CI is set. The live smoke test is local-only and never runs in CI.');
  process.exit(1);
}

const CONFIG = await import('../lib/ai/config.ts');
const SCORING = await import('../lib/ai/job-scoring.ts');

console.log('OpenRouter live smoke test — ONE request, synthetic data only.');
console.log(`env file: ${envFile ?? '(none found; using the shell environment)'}`);

/* ------------------------------------------------------- the two gates */

const readiness = CONFIG.gatewayReadiness();
// Booleans only. Never a value, never a length, never a prefix.
console.log(`OPENROUTER_API_KEY: ${readiness.keyConfigured ? 'configured' : 'NOT configured'}`);
console.log(`OPENROUTER_MODEL:   ${readiness.modelConfigured ? 'configured' : 'NOT configured'}`);

if (!readiness.keyConfigured) {
  console.log('\nNo key. Nothing was requested and nothing was billed.');
  console.log('Set OPENROUTER_API_KEY in this repository\'s .env.local, then re-run.');
  process.exit(0);
}

if (!readiness.modelConfigured) {
  const problem = CONFIG.resolveGatewayModel();
  console.log(`\n${typeof problem === 'string' ? '' : problem.message}`);
  console.log('Nothing was requested and nothing was billed.');
  console.log('\nThis path has NO DEFAULT MODEL, deliberately: picking one would spend your');
  console.log('money on a model you did not choose, and a slug guessed from training data');
  console.log('is a 404 waiting to happen. Choose one from the OpenRouter model catalogue');
  console.log('and set OPENROUTER_MODEL=<vendor/model> in .env.local, then re-run.');
  process.exit(0);
}

/* ---------------------------------------------------------- the fixture */

/** Entirely invented. No real person, no real employer, no real posting. */
const FIXTURE_JOB = [
  'Senior TypeScript Engineer — Example Corp (fictional)',
  '',
  'We are looking for an engineer with several years of TypeScript experience',
  'to work on backend services. Experience with payment systems is a plus.',
  'Remote friendly. No agencies.',
].join('\n');

const FIXTURE_CANDIDATE = [
  'Six years of TypeScript across backend services.',
  'Built and operated a payments integration.',
  'Comfortable with Postgres and CI automation.',
].join('\n');

/* ------------------------------------------------------------ the call */

let requests = 0;
const countingFetch = async (url, init) => {
  requests++;
  return fetch(url, init);
};

console.log('\nSending exactly one request…');
const started = Date.now();

const outcome = await SCORING.scoreJob({
  jobText: FIXTURE_JOB,
  resumeSummary: FIXTURE_CANDIDATE,
  fetchImpl: countingFetch,
  // Exactly one paid request: no retry, even on a retryable failure.
  maxAttempts: 1,
  timeoutMs: 60_000,
});

const wall = Date.now() - started;

/* ---------------------------------------------------------- the report */

console.log(`\nrequests made: ${requests}`);
if (requests > 1) {
  console.error('DEFECT: more than one request was made. This must be exactly one.');
  process.exit(1);
}

if (!outcome.ok) {
  console.log(`refused before sending: ${outcome.code} — ${outcome.message}`);
  process.exit(0);
}

const r = outcome.result;
console.log(`model:      ${r.usage.model}`);
console.log(`status:     ${r.usage.status}`);
console.log(`latency:    ${r.usage.latency_ms} ms (wall ${wall} ms)`);
console.log(`attempts:   ${r.usage.attempts}`);
console.log(`tokens:     prompt=${r.usage.prompt_tokens} completion=${r.usage.completion_tokens} total=${r.usage.total_tokens}`);
console.log(`cost (USD): ${r.usage.cost_usd ?? '(not reported)'}`);
console.log(`request id: ${r.usage.provider_request_id ?? '(none)'}`);

if (!r.ok) {
  console.log(`\nfailed: ${r.code}${r.status ? ` (HTTP ${r.status})` : ''}, retryable=${r.retryable}`);
  console.log('No response body is shown, deliberately — a provider error can echo the request.');
  process.exit(1);
}

/*
 * The response, bounded and labelled.
 *
 * Printed because it is the point of the exercise and contains only synthetic
 * data, but truncated: this is untrusted model output and the terminal is a
 * log.
 */
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
console.log('\nvalidated structured result:');
console.log(`  score:              ${r.data.score}`);
console.log(`  safety:             ${r.data.safety}`);
console.log(`  rationale:          ${clip(r.data.rationale, 160)}`);
console.log(`  claude_instruction: ${clip(r.data.claude_instruction, 160)}`);

const authority = SCORING.assertModelCannotAuthorise(r.data);
console.log(`\nmayAutoSubmit:  ${authority.mayAutoSubmit}   (always false, whatever the model said)`);
console.log(`requiresHuman:  ${authority.requiresHuman}`);
console.log('\nNo employer site was contacted and no application was submitted.');
console.log('Usage was NOT persisted: this script writes no database row by design.');
console.log('`job_scoring` IS an accepted provider_usage operation since migration 23,');
console.log('but persisting it needs a Supabase connection this smoke test deliberately avoids.');
process.exit(0);
