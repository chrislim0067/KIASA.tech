/**
 * The worker protocol's server half, offline.
 *
 *   npm run test:endpoints
 *
 * The database is a fake built in this file, the clock is a parameter, and no
 * request leaves the process. That is what lets the whole pairing and
 * credential lifecycle be exercised on a machine that cannot safely run
 * Postgres — including the races, which are hard to provoke against a real one.
 *
 * WHAT THIS GUARDS
 *
 * The endpoints decide whether a process on somebody's laptop may act as a
 * particular candidate. The failure that matters is not "an error" — it is one
 * candidate's worker acting for another, quietly, and looking like success.
 * So the properties below are checked from the caller's side, where an
 * attacker sits:
 *
 *   * identity NEVER comes from a request body;
 *   * an invitation is single-use even when two workers race for it;
 *   * a wrong guess costs an attempt; a dead invitation costs nothing;
 *   * no response ever carries a hash, a secret or a token except the one
 *     moment each is minted.
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

const E = await import('../lib/worker/endpoints.ts');
const P = await import('../lib/worker/pairing.ts');

const uuid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const ALICE = uuid(1);
const BOB = uuid(2);
const now = new Date('2026-09-10T12:00:00.000Z');
const at = (ms) => new Date(now.getTime() + ms);

/**
 * An in-memory stand-in for the two tables.
 *
 * `claimPairing` models the CONDITIONAL update the real store must issue —
 * `where redeemed_at is null` — because that atomicity is the thing being
 * tested, and a fake that just assigns would prove nothing.
 */
function makeStore() {
  const pairings = new Map();
  const credentials = new Map();
  const supervisors = new Map();
  const slots = new Map();
  const heartbeats = [];
  let seq = 100;

  return {
    pairings, credentials, supervisors, slots, heartbeats,
    async createPairing(row) {
      const id = uuid(++seq);
      // The real table has a partial unique index making this one-live-per-user.
      for (const [, p] of pairings) {
        if (p.user_id === row.user_id && !p.redeemed_at && !p.revoked_at) p.revoked_at = now.toISOString();
      }
      pairings.set(id, { id, attempts: 0, redeemed_at: null, revoked_at: null, ...row });
      return { id };
    },
    async findPairingByHash(hash) {
      for (const [, p] of pairings) if (p.secret_hash === hash) return p;
      return null;
    },
    async claimPairing(id, supervisorId) {
      const p = pairings.get(id);
      if (!p || p.redeemed_at !== null) return false;   // the conditional UPDATE
      p.redeemed_at = now.toISOString();
      p.redeemed_supervisor_id = supervisorId;
      return true;
    },
    /*
     * THIS FAKE IS MORE CAPABLE THAN THE REAL THING, AND THAT MATTERS.
     *
     * It increments unconditionally. The database increments only when the
     * submitted value differs from the stored one, and the interface
     * `recordFailedAttempt(id)` hides that value inside the implementation, so no
     * assertion written against this store can reach it. Every counter
     * assertion here passed while the real counter was inert.
     *
     * The value is therefore checked two ways instead: by reading the source
     * in section 14, and against a real Postgres in
     * scripts/test-worker-pairing-db.mjs.
     */
    async recordFailedAttempt(id) {
      const p = pairings.get(id);
      if (p) p.attempts += 1;
    },
    async createSupervisor(row) {
      const id = uuid(++seq);
      supervisors.set(id, { id, ...row });
      return { id };
    },
    async createSlot(row) {
      const id = uuid(++seq);
      slots.set(id, { id, slot_index: 1, ...row });
      return { id };
    },
    async createCredential(row) {
      // The real table has a partial unique index: one live credential per
      // supervisor. A second insert for the same supervisor must fail.
      for (const [, c] of credentials) {
        if (c.supervisor_id === row.supervisor_id && c.revoked_at === null) return null;
      }
      credentials.set(row.id, {
        audience: 'kiasa-worker', scope: 'slot:heartbeat', revoked_at: null, ...row,
      });
      return { id: row.id };
    },
    async findCredentialById(id) {
      return credentials.get(id) ?? null;
    },
    async touchCredential(id, atIso) {
      const c = credentials.get(id);
      if (c) c.last_used_at = atIso;
    },
    async recordHeartbeat(input) {
      const last = heartbeats.filter((h) => h.supervisorId === input.supervisorId).pop();
      // Strictly newer only: a replay or a late arrival changes nothing.
      if (last && input.sequence <= last.sequence) return { applied: false };
      heartbeats.push(input);
      return { applied: true };
    },
  };
}

const redeemBody = (secret) => ({
  pairing_secret: secret, platform: 'windows', agent_version: '0.1.0',
});

/* ================================================== 1-2. STARTING PAIRING */

section('1. Pairing starts from a verified identity, never a request body');

{
  const store = makeStore();
  const r = await E.startPairing(store, ALICE, now);
  check('a pairing is created', r.ok === true);
  check('  the plaintext is returned exactly once', r.ok && r.secret.length > 0);
  check('  it expires within the declared window',
    Date.parse(r.expiresAt) - now.getTime() === P.PAIRING_TTL_MS,
    `${P.PAIRING_TTL_MS} ms`);

  const row = [...store.pairings.values()][0];
  check('ONLY a hash is persisted', /^[0-9a-f]{64}$/.test(row.secret_hash));
  check('  the stored value is not the secret',
    row.secret_hash !== r.secret && row.secret_hash !== P.normalisePairingSecret(r.secret));
  check('  and the row has no plaintext column at all',
    !Object.keys(row).some((k) => /secret$|plaintext|token$/.test(k)),
    Object.keys(row).join(', '));
  check('the row is bound to the authenticated candidate', row.user_id === ALICE);

  const src = readFileSync(path.join(ROOT, 'lib', 'worker', 'endpoints.ts'), 'utf8');
  check('startPairing takes a userId parameter, not a body',
    /export async function startPairing\(\s*store: PairingStore,\s*userId: string/.test(src));
}

section('2. Asking again supersedes the previous invitation');

{
  const store = makeStore();
  const first = await E.startPairing(store, ALICE, now);
  await E.startPairing(store, ALICE, now);
  const rows = [...store.pairings.values()];
  check('two rows exist', rows.length === 2);
  check('  but only one is live',
    rows.filter((p) => !p.redeemed_at && !p.revoked_at).length === 1,
    'a drawer of valid secrets is a drawer of ways in');

  const dead = await E.redeemPairing(store, redeemBody(first.secret), now);
  check('  the superseded secret no longer redeems',
    dead.ok === false && dead.reason === 'revoked', dead.ok ? 'REDEEMED' : dead.reason);
}

/* ============================================= 3-6. REDEMPTION AND ABUSE */

section('3. A valid redemption issues a scoped credential');

{
  const store = makeStore();
  const started = await E.startPairing(store, ALICE, now);
  const r = await E.redeemPairing(store, redeemBody(started.secret), now);

  check('it redeems', r.ok === true, r.ok ? '' : r.reason);
  check('  a token is returned', r.ok && P.WORKER_TOKEN_PATTERN.test(r.token));
  check('  a supervisor was registered', store.supervisors.size === 1);
  check('  exactly one slot', store.slots.size === 1);
  check('  exactly one credential', store.credentials.size === 1);

  const cred = [...store.credentials.values()][0];
  check('ONLY a hash is stored for the token', /^[0-9a-f]{64}$/.test(cred.token_hash));
  check('  the token is not stored anywhere',
    ![...store.credentials.values()].some((c) => JSON.stringify(c).includes(r.token.split('.')[1])));
  check('  it is bound to the candidate from the INVITATION', cred.user_id === ALICE);
  check('  and scoped', cred.audience === 'kiasa-worker' && cred.scope === 'slot:heartbeat');

  // The token must actually verify — the bug this catches is a hash stored
  // against a different credential id than the one the token names.
  const auth = await E.authenticateWorker(store, `Bearer ${r.token}`, now);
  check('THE ISSUED TOKEN AUTHENTICATES', auth.ok === true, auth.ok ? '' : auth.reason);
  check('  and yields the right candidate', auth.ok && auth.userId === ALICE);
  check('  and the right supervisor', auth.ok && auth.supervisorId === r.supervisorId);
}

section('4. Single use, replay, and two workers racing');

{
  const store = makeStore();
  const started = await E.startPairing(store, ALICE, now);
  const first = await E.redeemPairing(store, redeemBody(started.secret), now);
  check('the first redemption succeeds', first.ok === true);

  const replay = await E.redeemPairing(store, redeemBody(started.secret), now);
  check('replaying the same secret fails',
    replay.ok === false && replay.reason === 'already_redeemed',
    replay.ok ? 'REDEEMED TWICE' : replay.reason);
  check('  and no second credential was created', store.credentials.size === 1);

  /*
   * Two workers redeeming concurrently. Both pass evaluation against the same
   * un-redeemed row; only one may win the conditional claim.
   */
  const race = makeStore();
  const started2 = await E.startPairing(race, ALICE, now);
  const [a, b] = await Promise.all([
    E.redeemPairing(race, redeemBody(started2.secret), now),
    E.redeemPairing(race, redeemBody(started2.secret), now),
  ]);
  const winners = [a, b].filter((x) => x.ok);
  check('exactly one of two racing workers wins', winners.length === 1,
    `${winners.length} winner(s)`);
  check('  the loser is told it was already redeemed',
    [a, b].some((x) => !x.ok && x.reason === 'already_redeemed'));
}

section('5. Wrong secrets cost an attempt; dead invitations cost nothing');

{
  const store = makeStore();
  await E.startPairing(store, ALICE, now);
  const row = [...store.pairings.values()][0];

  const wrong = await E.redeemPairing(store, redeemBody('WRONGWRONGWRONGWRONGWRONGX'), now);
  check('a wrong secret is refused', wrong.ok === false);
  check('  and does NOT find a row to charge',
    row.attempts === 0, 'the hash did not match any invitation');

  // A wrong secret that DOES hit a real row is the case that must be counted.
  const store2 = makeStore();
  const started = await E.startPairing(store2, ALICE, now);
  const real = [...store2.pairings.values()][0];
  const normalised = P.normalisePairingSecret(started.secret);
  // Force a hash collision on lookup by presenting the right hash, wrong value.
  const originalFind = store2.findPairingByHash.bind(store2);
  store2.findPairingByHash = async () => real;
  // The replacement character must DIFFER from the one it replaces. Hard-coding
  // 'X' made this a one-in-thirty flake: the alphabet contains X, so roughly
  // every thirtieth run the "near miss" WAS the real secret, redeemed cleanly,
  // and took the two assertions after it down with it. Caught locally on 7cf8aaf
  // after the same code had passed CI twice.
  const different = normalised.endsWith('X') ? 'Y' : 'X';
  const near = await E.redeemPairing(store2, redeemBody(normalised.slice(0, -1) + different), now);
  check('a near miss against a real invitation is refused',
    near.ok === false && near.reason === 'secret_mismatch', near.ok ? 'REDEEMED' : near.reason);
  check('  and IS charged an attempt', real.attempts === 1, String(real.attempts));
  store2.findPairingByHash = originalFind;

  // Exhaustion.
  real.attempts = P.MAX_PAIRING_ATTEMPTS;
  const exhausted = await E.redeemPairing(store2, redeemBody(started.secret), now);
  check('an exhausted invitation is refused even with the RIGHT secret',
    exhausted.ok === false && exhausted.reason === 'too_many_attempts', exhausted.reason);
  check('  brute force is finite', P.MAX_PAIRING_ATTEMPTS <= 10, String(P.MAX_PAIRING_ATTEMPTS));
}

section('6. Expiry, and one candidate cannot redeem another’s invitation');

{
  const store = makeStore();
  const started = await E.startPairing(store, ALICE, now);
  const late = await E.redeemPairing(store, redeemBody(started.secret), at(P.PAIRING_TTL_MS));
  check('redeeming at the expiry instant fails',
    late.ok === false && late.reason === 'expired', late.ok ? 'REDEEMED' : late.reason);
  check('  one millisecond earlier succeeds',
    (await E.redeemPairing(store, redeemBody(started.secret), at(P.PAIRING_TTL_MS - 1))).ok === true);

  /*
   * Cross-candidate: Bob's worker presenting Alice's secret gets ALICE's
   * identity — because identity comes from the invitation, not the caller.
   * That is correct: whoever holds the secret was given it by Alice. What must
   * NOT happen is a body field steering ownership, which section 7 covers.
   */
  const store2 = makeStore();
  const alices = await E.startPairing(store2, ALICE, now);
  await E.startPairing(store2, BOB, now);
  const r = await E.redeemPairing(store2, redeemBody(alices.secret), now);
  check("redeeming Alice's secret yields ALICE, whoever presented it",
    r.ok && [...store2.credentials.values()][0].user_id === ALICE);
  check("  and Bob's invitation is untouched",
    [...store2.pairings.values()].find((p) => p.user_id === BOB).redeemed_at === null);
}

/* ================================================== 7-9. AUTHENTICATION */

section('7. Identity comes from the credential, never from the body');

{
  const store = makeStore();
  const started = await E.startPairing(store, ALICE, now);
  const issued = await E.redeemPairing(store, redeemBody(started.secret), now);

  check('the heartbeat schema has no identity field',
    ['user_id', 'candidate_id', 'supervisor_id', 'slot_id'].every(
      (k) => E.HeartbeatRequest.safeParse({
        sequence: 1, lifecycle: 'running', slot_readiness: 'ready', [k]: BOB,
      }).success === false),
    'strict() rejects it outright');

  const auth = await E.authenticateWorker(store, `Bearer ${issued.token}`, now);
  check('the verified identity is ALICE', auth.ok && auth.userId === ALICE);

  const src = readFileSync(path.join(ROOT, 'lib', 'worker', 'endpoints.ts'), 'utf8');
  check('heartbeat() takes identity as a parameter, not from the body',
    /export async function heartbeat\([\s\S]{0,200}identity: \{/.test(src));
  check('  and the redeem body carries no identity',
    !/user_id|candidate_id/.test(src.slice(src.indexOf('RedeemRequest'), src.indexOf('RedeemRequest') + 400)));
}

section('8. Every authentication refusal');

{
  const store = makeStore();
  const started = await E.startPairing(store, ALICE, now);
  const issued = await E.redeemPairing(store, redeemBody(started.secret), now);
  const cred = [...store.credentials.values()][0];

  for (const [why, header, when, expected] of [
    ['no header', null, now, 'missing_credential'],
    ['an empty bearer', 'Bearer ', now, 'malformed_credential'],
    ['not a bearer scheme', `Token ${issued.token}`, now, 'malformed_credential'],
    ['a malformed token', 'Bearer nonsense', now, 'malformed_credential'],
    ['an unknown credential id', `Bearer ${uuid(999)}.${'a'.repeat(43)}`, now, 'not_found'],
    ['an expired credential', `Bearer ${issued.token}`, at(P.CREDENTIAL_TTL_MS), 'expired'],
  ]) {
    const r = await E.authenticateWorker(store, header, when);
    check(`${why} -> ${expected}`, r.ok === false && r.reason === expected,
      r.ok ? 'ACCEPTED' : r.reason);
  }

  // A tampered secret half against a real credential id.
  const [id, secret] = issued.token.split('.');
  const tampered = `${id}.${secret.slice(0, -1)}${secret.slice(-1) === 'A' ? 'B' : 'A'}`;
  check('a tampered secret -> secret_mismatch',
    (await E.authenticateWorker(store, `Bearer ${tampered}`, now)).reason === 'secret_mismatch');

  cred.revoked_at = now.toISOString();
  check('a revoked credential -> revoked',
    (await E.authenticateWorker(store, `Bearer ${issued.token}`, now)).reason === 'revoked');
  check('  revocation is checked before the secret',
    (await E.authenticateWorker(store, `Bearer ${tampered}`, now)).reason === 'revoked');
}

section('9. Heartbeats are authenticated, idempotent and monotonic');

{
  const store = makeStore();
  const started = await E.startPairing(store, ALICE, now);
  const issued = await E.redeemPairing(store, redeemBody(started.secret), now);
  const auth = await E.authenticateWorker(store, `Bearer ${issued.token}`, now);
  const identity = {
    supervisorId: auth.supervisorId, slotId: auth.slotId, credentialId: auth.credentialId,
  };
  const beat = (sequence, when = now) =>
    E.heartbeat(store, identity, { sequence, lifecycle: 'running', slot_readiness: 'ready' }, when);

  check('a heartbeat is accepted', (await beat(1)).applied === true);
  check('  replaying the same sequence changes nothing',
    (await beat(1)).applied === false, 'idempotent');
  check('  an older sequence changes nothing',
    (await beat(0)).applied === false, 'a retry can overtake what it retried');
  check('  a newer sequence applies', (await beat(2)).applied === true);
  check('the store recorded exactly two applications', store.heartbeats.length === 2,
    'four beats sent, two applied: the replay and the older one changed nothing');
  check('  and the credential was touched',
    typeof [...store.credentials.values()][0].last_used_at === 'string');

  for (const bad of [
    { sequence: -1, lifecycle: 'running', slot_readiness: 'ready' },
    { sequence: 1, lifecycle: 'sprinting', slot_readiness: 'ready' },
    { sequence: 1, lifecycle: 'running', slot_readiness: 'dancing' },
    { sequence: 1.5, lifecycle: 'running', slot_readiness: 'ready' },
    {},
    null,
  ]) {
    const r = await E.heartbeat(store, identity, bad, now);
    check(`a malformed heartbeat is refused: ${JSON.stringify(bad).slice(0, 34)}`,
      r.ok === false && r.reason === 'malformed_request');
  }
}

/* ================================================ 10-12. STATUS AND LEAKS */

section('10. Status transitions the candidate can see');

{
  const base = {
    hasCredential: true, revokedAt: null,
    expiresAt: at(P.CREDENTIAL_TTL_MS).toISOString(), lastHeartbeatAt: now.toISOString(),
  };
  check('a fresh worker is online', E.visibleStatus(base, now) === 'online');
  check('  silence past the window is stale',
    E.visibleStatus(base, at(P.STALE_AFTER_MS + 1)) === 'stale');
  check('  revoked is distinct from stale',
    E.visibleStatus({ ...base, revokedAt: now.toISOString() }, now) === 'revoked');
  check('  never paired is not_paired',
    E.visibleStatus({ ...base, hasCredential: false }, now) === 'not_paired');
}

section('11. No response carries credential material');

{
  const store = makeStore();
  const started = await E.startPairing(store, ALICE, now);
  const issued = await E.redeemPairing(store, redeemBody(started.secret), now);

  const hb = await E.heartbeat(
    store,
    { supervisorId: issued.supervisorId, slotId: issued.slotId, credentialId: issued.token.split('.')[0] },
    { sequence: 1, lifecycle: 'running', slot_readiness: 'ready' }, now
  );
  const serialised = JSON.stringify(hb);
  check('a heartbeat response carries no token', !serialised.includes(issued.token.split('.')[1]));
  check('  and no hash', !/[0-9a-f]{64}/.test(serialised), serialised);
  check('  it is a status, not material', Object.keys(hb).sort().join(',') === 'applied,ok');

  const auth = await E.authenticateWorker(store, `Bearer ${issued.token}`, now);
  check('an auth result carries no hash and no secret',
    !/[0-9a-f]{64}/.test(JSON.stringify(auth)) &&
      !JSON.stringify(auth).includes(issued.token.split('.')[1]));
}

section('12. The module holds no key, shell or vendor path');

{
  const src = readFileSync(path.join(ROOT, 'lib', 'worker', 'endpoints.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const ANTHROPIC_ENV = 'ANTHROPIC' + '_API_KEY';
  for (const [re, what] of [
    [new RegExp(ANTHROPIC_ENV), ANTHROPIC_ENV],
    [/OPENROUTER_API_KEY/, 'the OpenRouter key'],
    [/SUPABASE_SECRET_KEY/, 'a Supabase service key'],
    [/document\.cookie|localStorage/, 'browser storage'],
    [/child_process|shell:\s*true|exec\(/, 'a shell'],
    [/\.anthropic\.com/, 'a vendor endpoint'],
  ]) {
    check(`contains no ${what}`, !re.test(src));
  }
  check('it is server-only', /^import 'server-only';/m.test(src));
  check('the secret is looked up BY HASH, never as a query value',
    /findPairingByHash\(hashSecret\(presented\)\)/.test(src),
    'a plaintext query parameter can land in a slow-query log');
}

section('13. The worker runtime holds nothing it should not');

{
  const raw = readFileSync(path.join(ROOT, 'worker', 'kiasa-worker.mjs'), 'utf8');
  // Comments explain what the worker AVOIDS, so scanning them would flag the
  // explanations rather than the behaviour.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const ANTHROPIC_ENV = 'ANTHROPIC' + '_API_KEY';

  for (const [re, what] of [
    [new RegExp(ANTHROPIC_ENV), ANTHROPIC_ENV],
    [/OPENROUTER_API_KEY/, 'the OpenRouter key'],
    [/SUPABASE_SECRET_KEY|SUPABASE_.*KEY/, 'a Supabase key'],
    [/document\.cookie|localStorage|sessionStorage/, 'browser storage'],
    [/puppeteer|playwright|webdriver/, 'a browser driver'],
    [/child_process|shell:\s*true|\bexec\(/, 'a shell'],
    [/\.anthropic\.com/, 'a vendor endpoint'],
    [/writeFileSync|appendFileSync|createWriteStream/, 'a write to disk'],
  ]) {
    check(`the worker contains no ${what}`, !re.test(src));
  }

  check('the pairing secret is read from STDIN, not argv',
    /readSecretFromStdin/.test(src) && !/process\.argv[\s\S]{0,80}(secret|pairing)/i.test(src),
    'an argv secret is visible in the process list and shell history');
  check('  the credential lives in a variable, never a file',
    /let credential = null/.test(src) && !/\.token.*writeFile/s.test(src));
  check('  and is dropped on shutdown', /credential = null;/.test(src));
  check('the worker sends no cookies', /credentials: 'omit'/.test(src));
  check('  and refuses redirects', /redirect: 'error'/.test(src),
    'a redirect could send the bearer token somewhere else');
  check('every request is bounded by an AbortController', /AbortController/.test(src));
  check('there is no default base URL pointing anywhere',
    /const BASE_URL = process\.env\.KIASA_BASE_URL;/.test(src),
    'a default is how a worker talks to production by accident');
  check('local Claude consent is explicit per run',
    /KIASA_LOCAL_CONSENT === 'yes'/.test(src),
    'an unset variable means not consented, not probably fine');
  check('it uses the EXISTING local-Claude adapter, not a second client',
    /'local-claude',\s*'cli\.ts'/.test(src) && !/openrouter\.ai|api\.openai/.test(src),
    'the adapter path is assembled with path.join, so there is no slash to match');
  check('a rejected credential stops the worker rather than retrying',
    /status === 401 \|\| status === 403/.test(src));

  /*
   * Nothing in the worker reaches an employer or submits anything.
   *
   * Asserted on BEHAVIOUR rather than on the word "employer", which appears
   * legitimately in the fictional probe prompt. What matters is that the only
   * URL it can build is the configured control plane, and that no action verb
   * for submitting or navigating exists.
   */
  const urls = [...src.matchAll(/https?:\/\/[^\s'"`]+/g)].map((m) => m[0]);
  check('  the worker builds no hard-coded URL', urls.length === 0, urls.join(', '));
  check('  the only fetch target is the configured base URL',
    /fetch\(`\$\{BASE_URL\}\$\{pathname\}`/.test(src), 'nothing else is reachable');
  for (const forbidden of ['submit_application', 'captcha', 'solveChallenge', 'navigate']) {
    check(`  no ${forbidden} path exists`, !new RegExp(forbidden, 'i').test(src));
  }
  check('the probe fixture names a fictional employer',
    /Example Corp \(a fictional employer\)/.test(raw));
}

section('14. The attempt counter is atomic, and the read-then-write is gone');

{
  const store = readFileSync(path.join(ROOT, 'lib', 'worker', 'store.ts'), 'utf8');
  const migration = readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20260910000025_pairing_atomic_attempts.sql'),
    'utf8'
  );

  /*
   * The race being closed: the redeem endpoint is unauthenticated by design,
   * so an attacker chooses the concurrency. A read-then-write counter can be
   * pinned below its ceiling by enough parallel guesses, and a limit that can
   * be held at four is not a limit.
   *
   * Postgres row locking is what actually proves the fix, and that is tested
   * against a real database in scripts/test-worker-pairing-db.mjs. What is
   * checkable here is that the client no longer does the arithmetic at all.
   */
  const fn = store.slice(store.indexOf('async recordFailedAttempt'));
  const withComments = fn.slice(0, fn.indexOf('\n    },'));
  // Comments here EXPLAIN the arithmetic the database does, so scanning them
  // would flag the explanation rather than the code.
  const body = withComments.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  check('recordFailedAttempt performs no SELECT', !/\.select\(/.test(body),
    'there is no read, so there is no gap to lose an update in');
  check('  and does no arithmetic', !/\+\s*1|Math\.min|Math\.max/.test(body), body.trim());
  check('  it issues exactly one statement',
    (body.match(/await db/g) ?? []).length === 1,
    'two statements would be two chances to interleave');

  check('the database computes the value from the PREVIOUS row',
    /new\.attempts := least\(old\.attempts \+ 1, 10\)/.test(migration));
  check('  and only when the update touches attempts',
    /if new\.attempts is distinct from old\.attempts then/.test(migration));
  /*
   * The ceiling must CLAMP, not throw. An exception past the ceiling turns a
   * refused guess into a 500 and tells an attacker the ceiling was reached.
   * Checked against the attempts branch specifically — the self-verification
   * block later in the file raises deliberately, and a whole-file scan would
   * confuse the two.
   */
  const guard = migration.slice(
    migration.indexOf('if new.attempts is distinct from old.attempts then'),
    migration.indexOf('  return new;')
  );
  check('the ceiling clamps rather than raising',
    /least\(old\.attempts \+ 1, 10\)/.test(guard) && !/raise exception/.test(guard),
    guard.replace(/\s+/g, ' ').trim().slice(0, 80));

  check('NO new grant was added', !/^grant /m.test(migration),
    'service_role already held UPDATE; the trigger rides that');
  check('  and the migration asserts none appeared',
    /an API role can execute the pairing guard directly/.test(migration) &&
      /authenticated can update a column other than revoked_at/.test(migration));
  check('it is still a BEFORE UPDATE trigger, asserted by the migration',
    /is not a BEFORE UPDATE trigger/.test(migration),
    'an AFTER trigger cannot rewrite the value');

  /*
   * THE SIGNAL MUST BE A VALUE THE ROW CANNOT ALREADY HOLD.
   *
   * The trigger counts an attempt only when `new.attempts` DIFFERS from
   * `old.attempts`, because that is how it tells a failed guess apart from
   * a revocation. Sending 0 therefore counted nothing against a stored 0 —
   * every first guess — and nothing at all under a burst that all saw 0. A
   * real database found that; an in-memory store that increments
   * unconditionally never could, which is why this check reads the SOURCE.
   */
  const signal = body.match(/update\(\{ attempts: (-?\d+) \}\)/);
  check('the failed-attempt signal is a literal, sent unconditionally', signal !== null,
    signal ? signal[0] : 'no update({ attempts: n }) found');
  check('  and lies outside the stored range, so it always counts',
    signal !== null && Number(signal[1]) < 0,
    signal ? 'attempts: ' + signal[1] : 'none');
  check('  which worker_pairings_attempts_bounded enforces',
    /attempts between 0 and 10/.test(
      readFileSync(
        path.join(ROOT, 'supabase', 'migrations', '20260910000024_worker_pairing_and_credentials.sql'),
        'utf8'
      )
    ),
    'a dropped trigger makes the write fail, not record a negative count');

  check('the client value cannot reset the counter',
    /new\.attempts := least/.test(migration) &&
      !/new\.attempts := new\.attempts/.test(migration),
    'the submitted value is discarded, whatever it is');

  /* Everything the fix must not have weakened. */
  const pairing = readFileSync(path.join(ROOT, 'lib', 'worker', 'pairing.ts'), 'utf8');
  check('constant-time comparison survives', /timingSafeEqual\(/.test(pairing));
  check('the attempt ceiling is still checked BEFORE the secret',
    pairing.indexOf("reason: 'too_many_attempts'") < pairing.indexOf('secretMatches(presentedSecret'),
    'a right guess and a wrong one stay indistinguishable past the ceiling');
  check('expiry and single-use are untouched',
    /already_redeemed/.test(pairing) && /reason: 'expired'/.test(pairing));
  check('ownership still comes from the invitation row',
    /return \{ ok: true, userId: row\.user_id \};/.test(pairing));
}

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} WORKER-ENDPOINT CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
