/**
 * Worker pairing and scoped credentials, offline.
 *
 *   npm run test:pairing
 *
 * Pure. No database, no network, no worker, no provider. The clock is a
 * parameter, so every expiry boundary is checked exactly rather than
 * approximately.
 *
 * WHAT THIS GUARDS
 *
 * This is the layer that decides whether a process on somebody's laptop is
 * allowed to act as a particular candidate. Getting it wrong does not produce
 * a bad answer; it produces one candidate's worker acting for another. So the
 * properties below are checked at their boundaries and in both directions:
 *
 *   * a secret is never stored, only its hash;
 *   * comparison is constant-time and order-independent of the guess;
 *   * an invitation is single-use, short-lived and attempt-bounded;
 *   * ownership comes from the verified credential and nowhere else;
 *   * status shown to a browser contains no material.
 */
import { readFileSync } from 'node:fs';

/* Named, because a literal escape in this file is a literal escape in the
   source it reads, and the two are not the same thing. */
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
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

const P = await import('../lib/worker/pairing.ts');

const uuid = (n = 1) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const ALICE = uuid(1);
const BOB = uuid(2);
const now = new Date('2026-09-10T12:00:00.000Z');
const at = (ms) => new Date(now.getTime() + ms);
const iso = (ms) => at(ms).toISOString();

/* ============================================ 1-2. SECRETS AND HASHING */

section('1. Pairing secrets are random, transcribable, and never stored raw');

{
  const a = P.generatePairingSecret();
  const b = P.generatePairingSecret();
  check('two secrets differ', a.normalised !== b.normalised);
  check('  the normalised form is the declared length',
    a.normalised.length === P.PAIRING_SECRET_LENGTH, String(a.normalised.length));
  check('  the display form is grouped for a human to read', /-/.test(a.display));
  check('  and normalises back to the same value',
    P.normalisePairingSecret(a.display) === a.normalised);
  check('  lower case and stray spaces still normalise',
    P.normalisePairingSecret(`  ${a.display.toLowerCase()} `) === a.normalised);

  check('the alphabet excludes look-alike characters',
    !/[ILOU]/.test(a.normalised), 'I, L, O and U are the ones people mistype');
  check('  and look-alikes are NOT silently substituted',
    P.normalisePairingSecret('O0O0') === 'O0O0',
    'mapping 0 to O would let two strings verify as one secret');

  // 200 samples is enough to catch a constant or a tiny alphabet, which is
  // what this is actually guarding against.
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(P.generatePairingSecret().normalised);
  check('200 generations produce 200 distinct secrets', seen.size === 200, String(seen.size));
}

section('2. Only hashes are ever compared, and comparison is constant-time');

{
  /*
   * Generated rather than written down.
   *
   * A literal here was flagged by gitleaks — not because the value was
   * sensitive, but because a 26-character alphanumeric string assigned to a
   * variable named `secret` is exactly what its entropy heuristic looks for,
   * and rightly so. Deriving the fixture from the module's own generator
   * removes the literal entirely, and is a better test besides: it exercises
   * the real output shape instead of one hand-picked string.
   *
   * The assertions below are all about RELATIONSHIPS — stability, difference,
   * matching — so none of them needs a fixed value.
   */
  const secret = P.generatePairingSecret().normalised;
  const h = P.hashSecret(secret);

  check('the hash is 64 hex characters', /^[0-9a-f]{64}$/.test(h), h.slice(0, 12) + '…');
  check('  it is not the secret', !h.includes(secret));
  check('  and is stable', P.hashSecret(secret) === h);
  check('a different secret hashes differently', P.hashSecret(secret + 'X') !== h);

  check('the correct secret matches', P.secretMatches(secret, h));
  check('a wrong secret does not', P.secretMatches('WRONG', h) === false);
  check('an empty secret does not', P.secretMatches('', h) === false);
  check('a malformed stored hash is refused, not crashed',
    P.secretMatches(secret, 'not-a-hash') === false);
  check('an empty stored hash is refused', P.secretMatches(secret, '') === false);
  check('a hash of the wrong length is refused', P.secretMatches(secret, 'abcd') === false);

  const src = readFileSync(path.join(ROOT, 'lib', 'worker', 'pairing.ts'), 'utf8');
  check('comparison uses timingSafeEqual', /timingSafeEqual\(/.test(src));
  check('  and never `===` on the secret itself',
    !/presented\s*===\s*|secret\s*===\s*stored/.test(src));
  check('secrets come from the system CSPRNG', /randomBytes\(/.test(src));
  check('  and never from Math.random', !/Math\.random/.test(src));
}

/* ================================================ 3-6. PAIRING LIFECYCLE */

const pairing = (over = {}) => ({
  id: uuid(10),
  user_id: ALICE,
  secret_hash: P.hashSecret('GOODSECRET'),
  expires_at: iso(P.PAIRING_TTL_MS),
  redeemed_at: null,
  revoked_at: null,
  attempts: 0,
  ...over,
});

section('3. A valid pairing redeems, and yields the OWNER from the row');

{
  const r = P.evaluatePairing(pairing(), 'GOODSECRET', now);
  check('it redeems', r.ok === true);
  check('  and the owner comes from the stored row, not the caller',
    r.ok && r.userId === ALICE,
    'a body field would be something the caller chose');
}

section('4. Every refusal, at its boundary');

{
  const cases = [
    ['a missing row', null, 'GOODSECRET', now, 'not_found'],
    ['a wrong secret', pairing(), 'BADSECRET', now, 'secret_mismatch'],
    ['an empty secret', pairing(), '', now, 'secret_mismatch'],
    ['an already-redeemed invitation', pairing({ redeemed_at: iso(-1000) }), 'GOODSECRET', now, 'already_redeemed'],
    ['a revoked invitation', pairing({ revoked_at: iso(-1000) }), 'GOODSECRET', now, 'revoked'],
    ['an exhausted invitation', pairing({ attempts: P.MAX_PAIRING_ATTEMPTS }), 'GOODSECRET', now, 'too_many_attempts'],
    ['a malformed expiry', pairing({ expires_at: 'soon' }), 'GOODSECRET', now, 'expired'],
  ];
  for (const [why, row, secret, when, expected] of cases) {
    const r = P.evaluatePairing(row, secret, when);
    check(`${why} -> ${expected}`, r.ok === false && r.reason === expected,
      r.ok ? 'REDEEMED' : r.reason);
  }

  /* Expiry, exactly at the boundary in both directions. */
  const row = pairing({ expires_at: iso(1000) });
  check('one millisecond before expiry still redeems',
    P.evaluatePairing(row, 'GOODSECRET', at(999)).ok === true);
  check('  exactly at expiry is refused',
    P.evaluatePairing(row, 'GOODSECRET', at(1000)).reason === 'expired',
    'an expiry that is inclusive is an expiry that has not happened');
  check('  after expiry is refused',
    P.evaluatePairing(row, 'GOODSECRET', at(1001)).reason === 'expired');

  check('attempts one below the ceiling still redeem',
    P.evaluatePairing(pairing({ attempts: P.MAX_PAIRING_ATTEMPTS - 1 }), 'GOODSECRET', now).ok === true);
}

section('5. State is checked BEFORE the secret is compared');

{
  /*
   * An expired or exhausted invitation must be refused without the comparison
   * running, so a guess reveals nothing by timing about how close it was.
   * Asserted by reason, which is the observable consequence: a correct secret
   * against a dead invitation reports the DEAD state, never `secret_mismatch`.
   */
  check('expired + correct secret reports expiry, not a mismatch',
    P.evaluatePairing(pairing({ expires_at: iso(-1) }), 'GOODSECRET', now).reason === 'expired');
  check('expired + WRONG secret also reports expiry',
    P.evaluatePairing(pairing({ expires_at: iso(-1) }), 'NOPE', now).reason === 'expired',
    'the two are indistinguishable to a caller, which is the point');
  check('redeemed + wrong secret reports redemption',
    P.evaluatePairing(pairing({ redeemed_at: iso(-1) }), 'NOPE', now).reason === 'already_redeemed');
  check('exhausted + correct secret reports exhaustion',
    P.evaluatePairing(pairing({ attempts: 10 }), 'GOODSECRET', now).reason === 'too_many_attempts');
}

section('6. Replay and cross-candidate redemption');

{
  const row = pairing();
  check('the first redemption succeeds', P.evaluatePairing(row, 'GOODSECRET', now).ok === true);
  // Single-use is a database UPDATE ... WHERE redeemed_at IS NULL; once it has
  // run, the row this function sees carries the timestamp.
  const afterRedemption = { ...row, redeemed_at: iso(1) };
  check('  replaying the same secret fails',
    P.evaluatePairing(afterRedemption, 'GOODSECRET', at(2)).reason === 'already_redeemed',
    'atomic single-use is the conditional UPDATE; this is the second layer');

  const bobs = pairing({ user_id: BOB, secret_hash: P.hashSecret('BOBSECRET') });
  check("Alice's secret does not redeem Bob's invitation",
    P.evaluatePairing(bobs, 'GOODSECRET', now).reason === 'secret_mismatch');
  check("  and Bob's invitation yields BOB, never the caller's claim",
    P.evaluatePairing(bobs, 'BOBSECRET', now).userId === BOB);
}

/* ============================================== 7-10. WORKER CREDENTIALS */

section('7. Token format and parsing');

{
  const id = uuid(20);
  const { token, secret } = P.generateWorkerToken(id);
  check('the token is <id>.<secret>', P.WORKER_TOKEN_PATTERN.test(token), token.slice(0, 20) + '…');
  check('  the id half is the credential id', token.startsWith(`${id}.`));
  check('  the secret half is 43 base64url characters', secret.length === 43);
  check('  two tokens differ', P.generateWorkerToken(id).secret !== secret);

  const parsed = P.parseWorkerToken(token);
  check('a well-formed token parses', parsed.ok === true && parsed.credentialId === id);
  for (const bad of [null, undefined, 42, '', 'nodot', `${id}.`, `.${secret}`,
    `${id}.${secret}extra`, `not-a-uuid.${secret}`, `${id}.${secret}`.replace(/\./, '..')]) {
    check(`  rejects ${JSON.stringify(String(bad)).slice(0, 28)}`,
      P.parseWorkerToken(bad).ok === false);
  }
}

const credential = (over = {}) => ({
  id: uuid(20),
  user_id: ALICE,
  supervisor_id: uuid(30),
  slot_id: uuid(31),
  token_hash: P.hashSecret('TOKENSECRET'),
  audience: 'kiasa-worker',
  scope: 'slot:heartbeat',
  expires_at: iso(P.CREDENTIAL_TTL_MS),
  revoked_at: null,
  ...over,
});

const REQUIRED = { audience: 'kiasa-worker', scope: 'slot:heartbeat' };

section('8. A valid credential authenticates, and IS the source of ownership');

{
  const r = P.evaluateCredential(credential(), 'TOKENSECRET', now, REQUIRED);
  check('it authenticates', r.ok === true);
  check('  the candidate comes from the credential', r.ok && r.userId === ALICE);
  check('  bound to one supervisor', r.ok && r.supervisorId === uuid(30));
  check('  and one slot', r.ok && r.slotId === uuid(31));
}

section('9. Every credential refusal');

for (const [why, row, secret, when, expected] of [
  ['a missing credential', null, 'TOKENSECRET', now, 'not_found'],
  ['a wrong secret', credential(), 'WRONG', now, 'secret_mismatch'],
  ['a revoked credential', credential({ revoked_at: iso(-1) }), 'TOKENSECRET', now, 'revoked'],
  ['an expired credential', credential({ expires_at: iso(-1) }), 'TOKENSECRET', now, 'expired'],
  ['a malformed expiry', credential({ expires_at: 'never' }), 'TOKENSECRET', now, 'expired'],
  ['the wrong audience', credential({ audience: 'kiasa-web' }), 'TOKENSECRET', now, 'wrong_audience'],
  ['an insufficient scope', credential({ scope: 'slot:submit' }), 'TOKENSECRET', now, 'insufficient_scope'],
]) {
  const r = P.evaluateCredential(row, secret, when, REQUIRED);
  check(`${why} -> ${expected}`, r.ok === false && r.reason === expected,
    r.ok ? 'ACCEPTED' : r.reason);
}

check('revocation is checked before the secret',
  P.evaluateCredential(credential({ revoked_at: iso(-1) }), 'WRONG', now, REQUIRED).reason ===
    'revoked');
check('expiry at the exact instant is refused',
  P.evaluateCredential(credential({ expires_at: iso(1000) }), 'TOKENSECRET', at(1000), REQUIRED)
    .reason === 'expired');
check('  one millisecond earlier is accepted',
  P.evaluateCredential(credential({ expires_at: iso(1000) }), 'TOKENSECRET', at(999), REQUIRED)
    .ok === true);

section('10. A credential cannot be widened by asking');

{
  /*
   * The required audience and scope come from the ENDPOINT, not the caller.
   * These assert that a credential minted for one purpose is refused for
   * another even when its own row says something broader.
   */
  const r = P.evaluateCredential(credential(), 'TOKENSECRET', now,
    { audience: 'kiasa-worker', scope: 'slot:submit' });
  check('a heartbeat credential cannot satisfy a submit scope',
    r.ok === false && r.reason === 'insufficient_scope');
  check('this milestone issues exactly one scope',
    readFileSync(path.join(ROOT, 'supabase', 'migrations',
      '20260910000024_worker_pairing_and_credentials.sql'), 'utf8')
      .match(/check \(scope in \(\s*'slot:heartbeat'\s*\)\)/) !== null,
    'submission authority is not something a worker credential can carry');
}

/* ============================================== 11-13. STATUS AND LEAKAGE */

section('11. Status shown to a candidate is status, and nothing else');

{
  const base = {
    hasCredential: true, revokedAt: null,
    expiresAt: iso(P.CREDENTIAL_TTL_MS), lastHeartbeatAt: iso(0),
  };
  check('a fresh heartbeat is online', P.visibleStatus(base, now) === 'online');
  check('  just inside the stale window is still online',
    P.visibleStatus({ ...base, lastHeartbeatAt: iso(-P.STALE_AFTER_MS) }, now) === 'online');
  check('  one millisecond past it is stale',
    P.visibleStatus({ ...base, lastHeartbeatAt: iso(-P.STALE_AFTER_MS - 1) }, now) === 'stale');
  check('never having beaten is stale, not online',
    P.visibleStatus({ ...base, lastHeartbeatAt: null }, now) === 'stale');
  check('no credential is not_paired',
    P.visibleStatus({ ...base, hasCredential: false }, now) === 'not_paired');
  check('revoked beats stale',
    P.visibleStatus({ ...base, revokedAt: iso(-1), lastHeartbeatAt: null }, now) === 'revoked',
    'a candidate debugging a sleeping laptop should not be told it was revoked');
  check('expired is distinct from revoked',
    P.visibleStatus({ ...base, expiresAt: iso(-1) }, now) === 'expired');
  check('a malformed expiry reads as expired, not online',
    P.visibleStatus({ ...base, expiresAt: 'nonsense' }, now) === 'expired');
}

section('12. No credential material can reach a browser response');

{
  const view = {
    status: 'online', supervisor_id: uuid(30), slot_index: 1,
    slot_readiness: 'ready', pause_reason: null, stop_reason: null,
    last_heartbeat_at: iso(0), paired_at: iso(-1000), expires_at: iso(P.CREDENTIAL_TTL_MS),
  };
  check('a valid status view parses', P.WorkerStatusView.safeParse(view).success);
  for (const planted of ['token', 'token_hash', 'secret', 'secret_hash', 'api_key',
    'authorization', 'cookie', 'pairing_secret']) {
    check(`  a "${planted}" field is rejected`,
      P.WorkerStatusView.safeParse({ ...view, [planted]: 'x' }).success === false);
  }
  check('the view has exactly nine fields', Object.keys(view).length === 9);
  check('  none of them is credential-shaped',
    !Object.keys(view).some((k) => /token|secret|key|hash|auth|cookie/i.test(k)),
    Object.keys(view).join(', '));

  /*
   * THE SLOT FIELDS CARRY VOCABULARY MEMBERS, NOT PROSE.
   *
   * A pause reason is where a worker would be most tempted to explain itself,
   * and where a sentence lifted off an employer's page would be most at home.
   * The enum is what stops that, so it is asserted rather than assumed.
   */
  check('  a paused slot may name a reason from the list',
    P.WorkerStatusView.safeParse(
      { ...view, slot_readiness: 'paused', pause_reason: 'captcha_detected' }).success);
  check('  but not a sentence',
    P.WorkerStatusView.safeParse(
      { ...view, slot_readiness: 'paused',
        pause_reason: 'the site asked for a code sent to a phone' }).success === false,
    'a pause reason is a member of a closed list, never something a worker wrote');
  check('  a readiness outside the vocabulary is refused',
    P.WorkerStatusView.safeParse({ ...view, slot_readiness: 'thinking' }).success === false);
  check('  a stop reason outside the vocabulary is refused',
    P.WorkerStatusView.safeParse(
      { ...view, stop_reason: 'it seemed like a good idea' }).success === false);

  /*
   * AND THE READER BUILDS EXACTLY THESE KEYS.
   *
   * THIS IS THE CHECK THAT WAS MISSING. The old version of this section built
   * its own six-key object and asserted that it parsed — which it did, while
   * the status reader was putting nine keys into a `.strict()` schema and
   * getting `invalid_view` back on every single call. A hand-made fixture
   * cannot catch a producer that disagrees with its own schema; comparing the
   * schema to the PRODUCER'S OWN object literal is what makes the two move
   * together.
   */
  const routeSource = readFileSync(
    path.join(ROOT, 'lib', 'worker', 'status.ts'), 'utf8')
    .split(CR + LF).join(LF);
  const opens = routeSource.indexOf('const view = {');
  const closes = routeSource.indexOf(LF + '  };', opens);
  check('the status reader builds a view literal this test can read',
    opens > 0 && closes > opens);
  if (opens > 0 && closes > opens) {
    const routeKeys = routeSource
      .slice(opens, closes)
      .split(LF)
      .map((line) => /^ {4}([a-z_]+):/.exec(line))
      .filter((m) => m !== null)
      .map((m) => m[1])
      .sort();
    const schemaKeys = Object.keys(P.WorkerStatusView.shape).sort();
    check('  and every key it sends is one the schema names',
      routeKeys.join(',') === schemaKeys.join(','),
      `route sends [${routeKeys.join(', ')}]; schema names [${schemaKeys.join(', ')}]`);
  }
}

section('13. The module holds no provider or vendor credential path');

{
  const src = readFileSync(path.join(ROOT, 'lib', 'worker', 'pairing.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const ANTHROPIC_ENV = 'ANTHROPIC' + '_API_KEY';
  for (const [re, what] of [
    [new RegExp(ANTHROPIC_ENV), ANTHROPIC_ENV],
    [/OPENROUTER_API_KEY/, 'the OpenRouter key'],
    [/SUPABASE_SECRET_KEY|service_role/, 'a Supabase service credential'],
    [/document\.cookie|localStorage/, 'browser storage'],
    [/child_process|shell:\s*true/, 'a shell'],
    [/\bfetch\s*\(/, 'a network call'],
  ]) {
    check(`contains no ${what}`, !re.test(src));
  }
  check('it is pure: no clock of its own',
    !/Date\.now\(\)/.test(src), 'every expiry check takes the time as a parameter');
}

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} WORKER-PAIRING CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
