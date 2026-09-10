/**
 * Local Claude mode: capability detection, routing and output validation.
 *
 *   npm run test:local
 *
 * OFFLINE. No subprocess, no model, no network, no subscription spent. The
 * real adapter is exercised against the real interface separately, by
 * `npm run probe:local`, which is deliberately NOT part of CI — a CI runner is
 * not the candidate's machine and has no subscription, so a green check there
 * would say nothing true.
 *
 * WHAT THIS GUARDS
 *
 * Milestone 2B made local Claude a real integration rather than a plan. The
 * risk that creates is a mock quietly standing in for it: every test below
 * that uses the fake asserts something about the WORKER's behaviour, and the
 * tests that assert the integration is real check the shape of the adapter and
 * the states it must be able to report — `unsupported` and `manual_required`
 * included, because an adapter that cannot say "I have nothing behind me" is
 * how a mock becomes a claim.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

const MODE = await import('../lib/agent/ai-mode.ts');
const T = await import('../lib/local-claude/transport.ts');
const W = await import('../lib/agent/worker-state.ts');

const uuid = (n = 1) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

const SUPPORTED = {
  status: 'supported', adapter: 'claude_code_cli', version: '2.1.267', model: 'sonnet',
};
const UNSUPPORTED = { status: 'unsupported', reason: 'cli_not_installed' };
const MANUAL = { status: 'manual_required', reason: 'candidate_has_not_consented' };

const request = (over = {}) => ({
  request_id: uuid(1), candidate_id: uuid(2), task_id: uuid(3),
  capability: 'application_answer_generation', model: 'sonnet',
  prompt: 'draft an answer', timeout_ms: 60_000, ...over,
});

const ANSWER = JSON.stringify({
  answer: 'Six years with TypeScript.', used_fact_keys: ['years_experience'], uncertain: false,
});

/* ================================================= 1-3. CAPABILITY DETECTION */

section('1. A supported local capability requires evidence, not configuration');

{
  check('supported carries the adapter that answered', SUPPORTED.adapter === 'claude_code_cli');
  check('  and the version the interface reported', /^\d+\.\d+\.\d+$/.test(SUPPORTED.version));
  check('  and the model the CANDIDATE chose', SUPPORTED.model === 'sonnet');
  check('isLocalClaudeUsable is true only for supported',
    MODE.isLocalClaudeUsable(SUPPORTED) === true &&
      MODE.isLocalClaudeUsable(UNSUPPORTED) === false &&
      MODE.isLocalClaudeUsable(MANUAL) === false);
  check('every unsupported reason is from a closed list',
    MODE.LOCAL_UNSUPPORTED_REASONS.length > 0 &&
      MODE.LOCAL_UNSUPPORTED_REASONS.every((r) => /^[a-z][a-z0-9_]*$/.test(r)),
    MODE.LOCAL_UNSUPPORTED_REASONS.join(', '));
}

section('2. Unsupported and manual_required are distinct, and neither is "ok"');

for (const availability of [UNSUPPORTED, MANUAL]) {
  const transport = T.createMockTransport({ availability });
  const outcome = await transport.run(request());
  check(`${availability.status}: run() reports it rather than producing output`,
    outcome.status === availability.status, outcome.status);
  check(`  it names a reason`, outcome.reason === availability.reason);
  check(`  it requires a human`, T.outcomeRequiresHuman(outcome) === true);
}
check('the two states are not interchangeable',
  UNSUPPORTED.status !== MANUAL.status,
  'no local capability at all vs. one that exists but may not be used now');

section('3. The model is never hard-coded');

{
  for (const alias of MODE.LOCAL_MODEL_ALIASES) {
    check(`"${alias}" is accepted`, MODE.resolveLocalModel(alias) === alias);
  }
  check('a full model name is accepted',
    MODE.resolveLocalModel('claude-sonnet-5') === 'claude-sonnet-5');
  check('case and padding are normalised', MODE.resolveLocalModel('  SONNET ') === 'sonnet');
  for (const bad of ['', '   ', null, undefined, 42, 'gpt-4', 'claude; rm -rf /', 'x'.repeat(80)]) {
    check(`rejects ${JSON.stringify(bad)}`, MODE.resolveLocalModel(bad) === null);
  }
  const src = readFileSync(path.join(ROOT, 'lib', 'local-claude', 'cli.ts'), 'utf8');
  check('the adapter defines no default model constant',
    !/DEFAULT_MODEL|model\s*=\s*['"](fable|opus|sonnet|haiku)['"]/.test(src),
    "the candidate's subscription and quota are theirs");
}

/* ============================================== 4-6. CAPABILITY ROUTING */

section('4. openrouter_only routes everything to the server, eligibility aside');

{
  const table = MODE.routingTable('openrouter_only');
  for (const capability of MODE.AI_CAPABILITIES) {
    const expected = capability === 'eligibility_evaluation' ? 'deterministic_rules' : 'openrouter';
    check(`${capability} -> ${expected}`, table[capability].destination === expected);
  }
  check('nothing is attended', Object.values(table).every((r) => r.attended === false));
  check('nothing routes to local Claude',
    Object.values(table).every((r) => r.destination !== 'local_claude'),
    'the candidate chose not to involve their own Claude');
  check('the mode uses a server-held credential',
    MODE.usesServerHeldCredential('openrouter_only') === true);
  check('  and needs no candidate action',
    MODE.requiresCandidateAction('openrouter_only') === false);
}

section('5. claude_max_assisted SPLITS the work when local Claude is available');

{
  const table = MODE.routingTable('claude_max_assisted', SUPPORTED);

  const SERVER_SIDE = ['resume_extraction', 'resume_analysis', 'job_scanning',
    'job_analysis', 'job_scoring', 'structured_task_creation'];
  for (const capability of SERVER_SIDE) {
    check(`${capability} -> openrouter (mechanical reading)`,
      table[capability].destination === 'openrouter');
  }
  for (const capability of MODE.LOCAL_CLAUDE_CAPABILITIES) {
    check(`${capability} -> local_claude (the candidate's own words)`,
      table[capability].destination === 'local_claude');
    check(`  the candidate's own session holds the credential`,
      table[capability].credential_holder === 'candidate_own_session');
    check(`  and it is unattended`, table[capability].attended === false);
  }
  check('eligibility stays deterministic',
    table.eligibility_evaluation.destination === 'deterministic_rules');
  check('exactly three capabilities go to local Claude',
    Object.values(table).filter((r) => r.destination === 'local_claude').length === 3);
  check('no capability is attended when local Claude works',
    MODE.requiresCandidateAction('claude_max_assisted', SUPPORTED) === false);
}

section('6. Without a local capability, the three fall back to the paste console');

for (const availability of [UNSUPPORTED, MANUAL]) {
  const table = MODE.routingTable('claude_max_assisted', availability);
  for (const capability of MODE.LOCAL_CLAUDE_CAPABILITIES) {
    check(`${availability.reason}: ${capability} -> paste console`,
      table[capability].destination === 'candidate_claude_max_paste');
    check(`  and is marked ATTENDED`, table[capability].attended === true,
      'work a person did by hand must never be counted as unattended automation');
  }
  check(`  the mechanical half still runs on the server`,
    table.job_analysis.destination === 'openrouter');
  check(`  the task requires candidate action`,
    MODE.requiresCandidateAction('claude_max_assisted', availability) === true);
}

check('the default availability is not "supported"',
  MODE.routeCapability('claude_max_assisted', 'resume_tailoring').destination !==
    'local_claude',
  'an omitted probe must never be read as a working integration');

section('7. Only the assisted mode involves a Claude session at all');

check('openrouter_only does not require one',
  MODE.requiresClaudeSession('openrouter_only') === false);
check('claude_max_assisted does', MODE.requiresClaudeSession('claude_max_assisted') === true);
check('openrouter_only never raises claude_authentication_required',
  W.requiredPauseReasons({
    mode: 'openrouter_only', employer_session: 'authenticated',
    claude_max_session: 'not_authenticated',
  }).length === 0);
check('claude_max_assisted raises it when signed out',
  W.requiredPauseReasons({
    mode: 'claude_max_assisted', employer_session: 'authenticated',
    claude_max_session: 'not_authenticated',
  }).includes('claude_authentication_required'));
check('  and when the state is unknown (fails closed)',
  W.requiredPauseReasons({
    mode: 'claude_max_assisted', employer_session: 'authenticated',
    claude_max_session: 'unknown',
  }).includes('claude_authentication_required'));

/* ================================================ 8-10. OUTPUT VALIDATION */

section('8. Structured output is validated, never trusted');

{
  const transport = T.createMockTransport({ availability: SUPPORTED, responses: [ANSWER] });
  const ok = await transport.run(request());
  check('a well-formed answer validates', ok.status === 'ok', ok.status);
  check('  and carries the parsed output', ok.status === 'ok' && ok.output.answer.length > 0);
  check('  and does not require a human', T.outcomeRequiresHuman(ok) === false);
}

{
  const BAD = [
    ['prose instead of JSON', 'Sure! Here is my answer: six years.'],
    ['an empty response', ''],
    ['valid JSON of the wrong shape', '{"text":"six years"}'],
    ['a missing uncertain flag', '{"answer":"x","used_fact_keys":[]}'],
    ['an answer over the length bound', JSON.stringify({ answer: 'x'.repeat(2001), used_fact_keys: [], uncertain: false })],
    ['an extra field', JSON.stringify({ answer: 'x', used_fact_keys: [], uncertain: false, note: 'hi' })],
    ['a fact key that is not a key', JSON.stringify({ answer: 'x', used_fact_keys: ['DROP TABLE'], uncertain: false })],
    ['JSON null', 'null'],
    ['an array', '[]'],
  ];
  for (const [why, raw] of BAD) {
    const transport = T.createMockTransport({ availability: SUPPORTED, responses: [raw] });
    const outcome = await transport.run(request());
    check(`rejects ${why}`, outcome.status === 'invalid_output', outcome.status);
    check(`  and requires a human`, T.outcomeRequiresHuman(outcome) === true);
  }
}

check('a fenced response is unwrapped rather than refused',
  (await T.createMockTransport({
    availability: SUPPORTED, responses: ['```json\n' + ANSWER + '\n```'],
  }).run(request())).status === 'ok',
  'a formatting habit is not a different answer');

section('9. An uncertain answer always reaches a human');

{
  const uncertain = JSON.stringify({
    answer: 'I am not sure.', used_fact_keys: [], uncertain: true,
  });
  const outcome = await T.createMockTransport({
    availability: SUPPORTED, responses: [uncertain],
  }).run(request());
  check('the call succeeds', outcome.status === 'ok');
  check('  but it requires a human', T.outcomeRequiresHuman(outcome) === true,
    'a model that says it was unsure is the clearest signal an answer would be a guess');
}

section('10. Nothing credential-shaped survives validation');

{
  const LEAKS = [
    ['an api key', 'sk-or-v1-' + 'a'.repeat(32)],
    ['a JWT', 'eyJ' + 'a'.repeat(40)],
    ['a bearer token', 'Bearer ' + 'a'.repeat(32)],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ];
  for (const [why, secret] of LEAKS) {
    const raw = JSON.stringify({ answer: `my answer ${secret}`, used_fact_keys: [], uncertain: false });
    const outcome = await T.createMockTransport({
      availability: SUPPORTED, responses: [raw],
    }).run(request());
    check(`output containing ${why} is refused`, outcome.status === 'invalid_output', outcome.status);
  }
  // A positive control: an ordinary answer must still pass.
  check('  an ordinary answer still passes',
    (await T.createMockTransport({ availability: SUPPORTED, responses: [ANSWER] })
      .run(request())).status === 'ok');
}

section('11. The request itself can carry no credential');

{
  const req = request();
  check('a valid request has no credential-shaped key',
    W.findCredentialLikeKeys(req).length === 0, Object.keys(req).join(','));
  for (const planted of ['api_key', 'session_token', 'cookie', 'authorization', 'credential']) {
    check(`  a planted ${planted} is rejected by the schema`,
      T.LocalClaudeRequest.safeParse({ ...req, [planted]: 'x' }).success === false);
  }
  check('an over-long prompt is rejected',
    T.LocalClaudeRequest.safeParse({ ...req, prompt: 'x'.repeat(T.MAX_PROMPT_CHARS + 1) })
      .success === false);
  check('an unbounded timeout is rejected',
    T.LocalClaudeRequest.safeParse({ ...req, timeout_ms: 999_999_999 }).success === false);
  check('a capability outside the three is rejected',
    T.LocalClaudeRequest.safeParse({ ...req, capability: 'job_scoring' }).success === false,
    'only the candidate-voice capabilities may go to a local model');
}

section('12. The adapter uses only the official, documented interface');

{
  const raw = readFileSync(path.join(ROOT, 'lib', 'local-claude', 'cli.ts'), 'utf8');
  /*
   * Comments are stripped before scanning. This file explains at length why it
   * does NOT use a shell, and the phrase it is warning against is the phrase
   * the scan looks for — the first run of this suite failed on its own
   * documentation. Scanning code only makes every check below mean what it
   * says: that the BEHAVIOUR is absent, not merely the word.
   */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('the file still documents why it avoids a shell',
    /shell/.test(raw) && raw.length > src.length, 'comments stripped before scanning');
  const FORBIDDEN = [
    [/document\.cookie|localStorage|sessionStorage/, 'browser storage'],
    [/puppeteer|playwright|webdriver/, 'a browser driver'],
    [/shell:\s*true/, 'a shell'],
    [/ANTHROPIC' \+ '_API_KEY|process\.env\.ANTHROPIC/, 'an API key from the environment'],
    [/\.anthropic\.com/, 'a direct vendor endpoint'],
    [/sessionKey|session_key|sk-ant/, 'a session credential'],
  ];
  for (const [re, what] of FORBIDDEN) {
    check(`the adapter contains no ${what}`, !re.test(src));
  }
  check('it passes arguments as an array, never a command string',
    /spawn\(\s*exe\.command,\s*\[/.test(src),
    'the prompt contains employer-controlled text');
  check('it sends the prompt over stdin',
    /child\.stdin\.end\(stdin\)/.test(src));
  check('it denies every tool',
    /DISALLOWED_TOOLS/.test(src) && /'--permission-prompts',\s*\n?\s*'none'/.test(src),
    'a job posting can contain any instruction it likes');
  check('it checks consent before executing anything',
    src.indexOf('candidate_has_not_consented') < src.indexOf('runCli(exe'),
    'probing to find out would already be the use that was not consented to');
}

section('13. The boundary did not move because a supported path was found');

{
  for (const forbidden of ['browser_storage_access', 'session_token_extraction',
    'credential_replay', 'private_endpoint_calls', 'undocumented_api_calls',
    'automation_disguise', 'captcha_bypass', 'mfa_bypass']) {
    check(`${forbidden} is permanently out of scope`,
      MODE.PERMANENTLY_OUT_OF_SCOPE.includes(forbidden));
  }
  const req = MODE.LOCAL_INTEGRATION_REQUIREMENTS;
  check('the official-interface requirement is met', req.official_documented_interface === 'met');
  check('runs only on the candidate machine', req.runs_only_on_candidate_machine === 'met');
  check('the server holds no Claude credential', req.server_holds_no_claude_credential === 'met');
  check('the ACCOUNT TERMS question is still open',
    req.account_terms_reviewed_by_candidate === 'open',
    'a working probe did not answer a licensing question');
}

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} LOCAL-CLAUDE CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
