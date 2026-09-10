/**
 * The Milestone 2B vertical slice, run end to end against a LOCAL FIXTURE.
 *
 *   npm run demo:slice          mock transport, offline, deterministic
 *   npm run demo:slice -- --real  the candidate's actual local Claude
 *
 * NOTHING IS SUBMITTED ANYWHERE. The fixture is a file in this repository, no
 * browser is driven, and the flow stops at the submit gate and reports its
 * verdict rather than acting on it.
 *
 * WHAT IT DEMONSTRATES
 *
 * Six pages, one slot. The ordinary form is filled from verified facts and its
 * free-text question is drafted; the five hazard pages each STOP, with the
 * right reason and nothing typed. That second half is the part worth watching:
 * a login wall, a challenge, an MFA prompt and a passport-number field all
 * render inputs and a submit button, and the only thing separating them from
 * an ordinary form is the evaluator.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const real = process.argv.includes('--real');

const FIX = await import('../lib/worker/fixture.ts');
const SLICE = await import('../lib/worker/slice.ts');
const T = await import('../lib/local-claude/transport.ts');

const html = readFileSync(path.join(ROOT, 'scripts', 'fixtures', 'employer-form.html'), 'utf8');

const VERIFIED_FACTS = {
  full_name: 'Alex Candidate',
  email: 'alex@example.com',
  years_experience: '6',
  resume: 'resume-2026.pdf',
  primary_skill: 'TypeScript',
};

const MOCK_ANSWER = JSON.stringify({
  answer: 'Six years building production TypeScript services and tooling.',
  used_fact_keys: ['years_experience', 'primary_skill'],
  uncertain: false,
});

let availability;
let transport;

if (real) {
  const CLI = await import('../lib/local-claude/cli.ts');
  availability = await CLI.probeLocalClaude({ model: 'sonnet', consented: true });
  console.log(`probe: ${JSON.stringify(availability)}\n`);
  if (availability.status !== 'supported') {
    console.log('Local Claude is not usable; the slice would use the paste console.');
    process.exit(0);
  }
  transport = CLI.createCliTransport({ model: 'sonnet', consented: true });
} else {
  availability = {
    status: 'supported', adapter: 'claude_code_cli', version: '0.0.0-mock', model: 'sonnet',
  };
  transport = T.createMockTransport({ availability, responses: [MOCK_ANSWER] });
  console.log('transport: MOCK (deterministic). Run with --real for the actual interface.\n');
}

const now = new Date('2026-09-09T12:00:00.000Z');
const base = {
  mode: 'claude_max_assisted',
  availability,
  verifiedFacts: VERIFIED_FACTS,
  transport,
  lifecycle: 'running',
  slotState: {
    state: 'working', since: now.toISOString(),
    task_id: '00000000-0000-4000-8000-00000000000a',
    lease_id: '00000000-0000-4000-8000-00000000000b',
  },
  agentState: 'ready_to_submit',
  lease: {
    lease: {
      slot_id: 'slot-1',
      expires_at: new Date(now.getTime() + 300_000).toISOString(),
      fence_token: 3,
    },
    current_fence_token: 3,
    slot_id: 'slot-1',
    now,
  },
};

const PAGES = ['ordinary', 'login', 'captcha', 'mfa', 'sensitive', 'unknown'];
const results = [];

for (const page of PAGES) {
  const observation = FIX.readFixturePage(html, page);
  const outcome = await SLICE.runSlice({ ...base, observation });

  console.log(`--- page: ${page} ---`);
  console.log(`  status          ${outcome.status}`);
  console.log(`  safety          ${outcome.safety.action}` +
    (outcome.safety.reasons.length ? ` [${outcome.safety.reasons.join(', ')}]` : ''));
  console.log(`  fields filled   ${outcome.filled.length}` +
    (outcome.filled.length ? ` (${outcome.filled.map((f) => f.name).join(', ')})` : ''));
  if (outcome.drafted) {
    console.log(`  drafted         ${outcome.drafted.status}`);
    if (outcome.drafted.status === 'ok') {
      console.log(`    answer        ${JSON.stringify(outcome.drafted.output.answer).slice(0, 120)}`);
      console.log(`    used facts    ${outcome.drafted.output.used_fact_keys.join(', ')}`);
      console.log(`    uncertain     ${outcome.drafted.output.uncertain}`);
      console.log(`    model         ${outcome.drafted.model_reported}`);
    }
  }
  if (outcome.submitGate) {
    console.log(`  submit gate     ${outcome.submitGate.allowed ? 'ALLOWED (not acted on)' : outcome.submitGate.reason}`);
  }
  console.log(`  assisted        ${outcome.candidateAssisted}`);
  console.log('');

  results.push({ page, status: outcome.status, reasons: outcome.safety.reasons, filled: outcome.filled.length });
}

console.log('========================================================');
console.log('SUMMARY');
for (const r of results) {
  const verdict = r.status === 'ready_for_review'
    ? `proceeded, ${r.filled} field(s) filled`
    : `STOPPED [${r.reasons.join(', ')}], ${r.filled} field(s) filled`;
  console.log(`  ${r.page.padEnd(10)} ${verdict}`);
}
const hazards = results.filter((r) => r.page !== 'ordinary');
const allStopped = hazards.every((r) => r.status === 'stopped' && r.filled === 0);
console.log('');
console.log(allStopped
  ? 'Every hazard page stopped with nothing typed.'
  : 'A HAZARD PAGE DID NOT STOP — this is a defect.');
console.log('No application was submitted; the fixture is a local file.');
process.exit(allStopped ? 0 : 1);
