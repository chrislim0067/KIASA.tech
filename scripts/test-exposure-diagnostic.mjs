/**
 * Offline tests for the exposure diagnostic's logic.
 *
 *   node scripts/test-exposure-diagnostic.mjs
 *
 * No Docker, no sockets, no network, no machine state, no production. Every
 * dependency is injected, so this runs identically on a developer machine and
 * on a CI runner — which matters, because CI cannot establish anything about
 * the Windows host's security and must not pretend otherwise.
 *
 * WHAT IS BEING PROVEN
 *
 * The previous discovery swallowed per-container failures with a bare
 * `catch { continue; }`. With several containers running and only some
 * inspectable, it classified the readable subset and ignored the rest — able
 * to report LOOPBACK_ONLY_VERIFIED while holding no evidence about a container
 * publishing Postgres on 0.0.0.0.
 *
 * The rule under test is that it now FAILS CLOSED: incomplete evidence can
 * only ever produce UNKNOWN_OR_INCOMPLETE (exit 2), and exit 0 requires
 * complete evidence across both IP families.
 */
import {
  CLASSES,
  STOPPED_STACK_GUIDANCE,
  classify,
  discoverBindings,
  parseHostIp,
} from './lib/exposure.mjs';

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

/* ---------------------------------------------------------------- fakes */

const ports = (list) => JSON.stringify(list);
const binding = (HostIp, HostPort) => ({ HostIp, HostPort: String(HostPort) });

/** A discovery driven entirely by a plain object of container -> behaviour. */
function fakeDiscovery(spec) {
  return discoverBindings({
    listContainers: () => {
      if (spec.__listThrows) throw new Error(spec.__listThrows);
      return Object.keys(spec).filter((k) => !k.startsWith('__'));
    },
    inspectContainer: (name) => {
      const v = spec[name];
      if (typeof v === 'function') return v();
      return v;
    },
  });
}

const verdictOf = (discovery, over = {}) =>
  classify({
    projectId: 'kiasa',
    discovery,
    loopbackOpen: { v4: [], v6: [] },
    externalOpen: [],
    externalTested: { v4: 0, v6: 0 },
    ...over,
  });

/* ------------------------------------------------------- 1. discovery */

section('1. Discovery records evidence instead of discarding it');

{
  const d = fakeDiscovery({ __listThrows: 'docker: command not found' });
  check('Docker unavailable is recorded', d.errors.some((e) => e.kind === 'docker-unavailable'));
  check('  and yields UNKNOWN (2)', verdictOf(d).code === 2, verdictOf(d).name);
}

{
  const d = fakeDiscovery({});
  check('no running containers -> no candidates', d.candidates.length === 0);
  check('  and yields STACK_NOT_RUNNING (3)', verdictOf(d).code === 3, verdictOf(d).name);
}

{
  const d = fakeDiscovery({
    supabase_db_kiasa: ports({ '5432/tcp': [binding('127.0.0.1', 54322)] }),
  });
  check('one container with valid bindings is inspected', d.inspected.length === 1);
  check('  binding parsed', d.bindings.length === 1 && d.bindings[0].hostPort === 54322);
  check('  no errors', d.errors.length === 0);
}

{
  // The exact failure mode that motivated this: two containers, one fails.
  const d = fakeDiscovery({
    supabase_kong_kiasa: ports({ '8000/tcp': [binding('127.0.0.1', 54321)] }),
    supabase_db_kiasa: () => {
      throw new Error('Error: No such object: supabase_db_kiasa');
    },
  });
  check('partial inspection records the failure', d.errors.some((e) => e.kind === 'inspect-failed'));
  check('  the readable container is still parsed', d.bindings.length === 1);
  check(
    '  but the verdict is UNKNOWN (2), not loopback-verified',
    verdictOf(d).code === 2,
    verdictOf(d).name
  );
  check('  and the failure survives into the notes', verdictOf(d).notes.join(' ').includes('supabase_db_kiasa'));
}

{
  const d = fakeDiscovery({ supabase_db_kiasa: '{ not json' });
  check('malformed JSON is recorded', d.errors.some((e) => e.kind === 'malformed-json'));
  check('  and yields UNKNOWN (2)', verdictOf(d).code === 2);
}

{
  const d = fakeDiscovery({ supabase_db_kiasa: () => '' });
  check(
    'a container that disappears mid-discovery is incomplete evidence',
    d.errors.some((e) => e.kind === 'inspect-empty')
  );
  check('  and yields UNKNOWN (2)', verdictOf(d).code === 2);
}

{
  const d = fakeDiscovery({ supabase_vector_kiasa: 'null' });
  check('a container with no published ports is inspected, not an error', d.errors.length === 0);
  check('  with zero bindings', d.bindings.length === 0);
  check('  running but nothing published -> UNKNOWN (2)', verdictOf(d).code === 2, verdictOf(d).name);
}

{
  const d = fakeDiscovery({ supabase_db_kiasa: ports({ '5432/tcp': [binding('127.0.0.1', 'abc')] }) });
  check('a non-numeric host port is recorded', d.errors.some((e) => e.kind === 'invalid-host-port'));
  check('  and yields UNKNOWN (2)', verdictOf(d).code === 2);
}

{
  const d = fakeDiscovery({ supabase_db_kiasa: ports({ '5432/tcp': [binding('127.0.0.1', 99999)] }) });
  check('an out-of-range host port is recorded', d.errors.some((e) => e.kind === 'invalid-host-port'));
}

{
  const d = fakeDiscovery({ supabase_db_kiasa: ports({ '5432/tcp': 'not-an-array' }) });
  check('a malformed binding structure is recorded', d.errors.some((e) => e.kind === 'malformed-binding'));
}

{
  const d = fakeDiscovery({ supabase_db_kiasa: '["an","array"]' });
  check('a non-object ports payload is recorded', d.errors.some((e) => e.kind === 'malformed-ports'));
}

/* ------------------------------------------------ 2. binding semantics */

section('2. Binding classification, IPv4 and IPv6 separately');

const clean = { externalTested: { v4: 2, v6: 1 }, loopbackOpen: { v4: [54322], v6: [54322] } };

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [binding('0.0.0.0', 54322)] }) });
  check('IPv4 wildcard is flagged as wildcard', d.bindings[0].wildcard === true);
  check(
    '  wildcard never becomes LOOPBACK_ONLY_VERIFIED',
    verdictOf(d, clean).code === 2,
    verdictOf(d, clean).name
  );
}

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [binding('::', 54322)] }) });
  check('IPv6 wildcard is flagged as wildcard', d.bindings[0].wildcard === true);
  check('  family is detected as 6', d.bindings[0].family === 6);
  check('  wildcard never becomes verified', verdictOf(d, clean).code === 2);
}

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [binding('127.0.0.1', 54322)] }) });
  check('explicit IPv4 loopback is loopback', d.bindings[0].loopback === true);
  check('  with complete evidence -> LOOPBACK_ONLY_VERIFIED (0)', verdictOf(d, clean).code === 0);
}

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [binding('::1', 54322)] }) });
  check('explicit IPv6 loopback is loopback', d.bindings[0].loopback === true);
  check('  with complete evidence -> exit 0', verdictOf(d, clean).code === 0);
}

{
  // Declared on an address that os.networkInterfaces() never reports.
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [binding('10.9.9.9', 54322)] }) });
  const v = verdictOf(d, clean);
  check('explicit non-loopback IPv4 is EXPOSED (1)', v.code === 1, v.name);
  check('  even though the address is not a local interface', v.notes.join(' ').includes('10.9.9.9'));
}

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [binding('2001:db8::1', 54322)] }) });
  const v = verdictOf(d, clean);
  check('explicit non-loopback IPv6 is EXPOSED (1)', v.code === 1, v.name);
}

/* -------------------------------------------------- 3. probe outcomes */

section('3. Probe outcomes');

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [binding('127.0.0.1', 54322)] }) });
  const v = classify({
    projectId: 'kiasa',
    discovery: d,
    loopbackOpen: { v4: [54322], v6: [] },
    externalOpen: [{ address: '192.168.1.5', family: 4, open: [54322] }],
    externalTested: { v4: 1, v6: 1 },
  });
  check('a port answering externally is EXPOSED (1)', v.code === 1, v.name);
}

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [binding('127.0.0.1', 54322)] }) });
  const v = classify({
    projectId: 'kiasa',
    discovery: d,
    loopbackOpen: { v4: [], v6: [] }, // every probe timed out
    externalOpen: [{ address: '192.168.1.5', family: 4, open: [] }],
    externalTested: { v4: 1, v6: 1 },
  });
  check('probe timeouts everywhere -> UNKNOWN (2), not verified', v.code === 2, v.name);
}

{
  // Loopback answered, but discovery was incomplete. Evidence wins.
  const d = fakeDiscovery({
    good: ports({ '5432/tcp': [binding('127.0.0.1', 54322)] }),
    bad: () => {
      throw new Error('inspect exploded');
    },
  });
  const v = classify({
    projectId: 'kiasa',
    discovery: d,
    loopbackOpen: { v4: [54322], v6: [54322] },
    externalOpen: [{ address: '192.168.1.5', family: 4, open: [] }],
    externalTested: { v4: 1, v6: 1 },
  });
  check('successful loopback probe cannot rescue incomplete discovery', v.code === 2, v.name);
}

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [binding('127.0.0.1', 54322)] }) });
  const v = classify({
    projectId: 'kiasa',
    discovery: d,
    loopbackOpen: { v4: [54322], v6: [] },
    externalOpen: [{ address: '192.168.1.5', family: 4, open: [] }],
    externalTested: { v4: 1, v6: 0 }, // no routable IPv6 to test
  });
  check('untestable IPv6 -> UNKNOWN (2), never verified', v.code === 2, v.name);
  check('  and says so explicitly', v.notes.join(' ').includes('IPv6'));
}

/* ------------------------------------------------- 4. missing project */

section('4. Missing project id');

{
  const d = fakeDiscovery({});
  const v = classify({
    projectId: null,
    discovery: d,
    loopbackOpen: { v4: [], v6: [] },
    externalOpen: [],
    externalTested: { v4: 0, v6: 0 },
  });
  check('no project id -> UNKNOWN (2)', v.code === 2, v.name);
}

/* --------------------------------------------- 5. stopped-stack safety */

section('5. The stopped-stack message must not tell you to start it');

{
  const text = STOPPED_STACK_GUIDANCE.join('\n');
  check(
    'does NOT instruct an unconditional `npm run db:start`',
    !/Start it with `npm run db:start`/.test(text) && !/^\s*Start it/m.test(text)
  );
  check('states the stopped stack is not evidence of safety', /NOT evidence that the configuration is safe/.test(text));
  check('names the firewall precondition', /Windows Firewall/.test(text));
  check('names the Docker loopback-binding precondition', /Docker loopback binding/i.test(text));
  check('requires independent verification', /independently verified/i.test(text));
  check('points at the document', /docs\/LOCAL-NETWORK-EXPOSURE\.md/.test(text));
  check('requires machine-owner approval for settings changes', /approval/i.test(text));
  check('records the prior measurement', /0\.0\.0\.0 and \[::\]/.test(text));
}

/* ------------------------------- 6. host-address parsing must be real */

section('6. HostIp is validated with a real IP parser');

/*
 * The predecessor tested loopback with the string prefix /^127\./ and decided
 * family by "does it contain a colon". `127.evil` therefore parsed as
 * loopback IPv4 and could carry a run all the way to exit 0.
 */
const IP_CASES = [
  // [value, ok, family, wildcard, loopback, label]
  ['127.0.0.1', true, 4, false, true, 'IPv4 loopback'],
  ['127.1.2.3', true, 4, false, true, 'IPv4 loopback, non-canonical'],
  ['0.0.0.0', true, 4, true, false, 'IPv4 wildcard'],
  ['::', true, 6, true, false, 'IPv6 wildcard'],
  ['[::]', true, 6, true, false, 'IPv6 wildcard, bracketed'],
  ['', true, 0, true, false, 'empty means all interfaces'],
  ['::1', true, 6, false, true, 'IPv6 loopback'],
  ['[::1]', true, 6, false, true, 'IPv6 loopback, bracketed'],
  ['192.168.1.5', true, 4, false, false, 'IPv4 routable'],
  ['2001:db8::1', true, 6, false, false, 'IPv6 routable'],
  ['127.evil', false, null, null, null, 'the reproduced malformed value'],
  ['127.0.0.1.5', false, null, null, null, 'too many octets'],
  ['127.0.0.256', false, null, null, null, 'octet out of range'],
  ['localhost', false, null, null, null, 'a name is not an address'],
  ['::gggg', false, null, null, null, 'invalid IPv6'],
  ['  127.0.0.1  ', false, null, null, null, 'surrounding whitespace'],
];

for (const [value, ok, family, wildcard, loopback, label] of IP_CASES) {
  const p = parseHostIp(value);
  if (ok) {
    check(
      `parse ${JSON.stringify(value)} (${label})`,
      p.ok && p.family === family && p.wildcard === wildcard && p.loopback === loopback,
      p.ok ? `family ${p.family}, wildcard ${p.wildcard}, loopback ${p.loopback}` : p.reason
    );
  } else {
    check(`reject ${JSON.stringify(value)} (${label})`, !p.ok, p.ok ? 'ACCEPTED' : p.reason);
  }
}

for (const [value, label] of [
  [undefined, 'missing'],
  [null, 'null'],
  [42, 'number'],
  [{}, 'object'],
  [['127.0.0.1'], 'array'],
]) {
  const p = parseHostIp(value);
  check(`reject non-string HostIp (${label})`, !p.ok, p.ok ? 'ACCEPTED' : p.reason);
}

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [binding('127.evil', 54322)] }) });
  check(
    'a malformed HostIp becomes a structured discovery error',
    d.errors.some((e) => e.kind === 'invalid-host-ip'),
    JSON.stringify(d.errors[0] ?? null)
  );
  check('  and produces no binding', d.bindings.length === 0);
  const v = verdictOf(d, { externalTested: { v4: 2, v6: 1 }, loopbackOpen: { v4: [54322], v6: [] } });
  check('  and forces UNKNOWN (2)', v.code === 2, v.name);
}

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [{ HostPort: '54322' }] }) });
  check('a missing HostIp key fails closed', d.errors.some((e) => e.kind === 'invalid-host-ip'));
}

{
  const d = fakeDiscovery({ c: ports({ '5432/tcp': [{ HostIp: 1234, HostPort: '54322' }] }) });
  check('a non-string HostIp fails closed', d.errors.some((e) => e.kind === 'invalid-host-ip'));
}

/* -------------------------- 7. exit 0 requires BOTH families covered */

section('7. Exit 0 requires positive coverage of BOTH IP families');

const loopbackOnly = fakeDiscovery({ c: ports({ '5432/tcp': [binding('127.0.0.1', 54322)] }) });
const withCounts = (v4, v6) =>
  classify({
    projectId: 'kiasa',
    discovery: loopbackOnly,
    loopbackOpen: { v4: [54322], v6: [54322] },
    externalOpen: [],
    externalTested: { v4, v6 },
  });

check('v4:0 v6:1 -> UNKNOWN (2)  [the reproduced defect]', withCounts(0, 1).code === 2, withCounts(0, 1).name);
check('v4:1 v6:0 -> UNKNOWN (2)', withCounts(1, 0).code === 2, withCounts(1, 0).name);
check('v4:0 v6:0 -> UNKNOWN (2)', withCounts(0, 0).code === 2, withCounts(0, 0).name);
check('v4:1 v6:1 -> LOOPBACK_ONLY_VERIFIED (0)', withCounts(1, 1).code === 0, withCounts(1, 1).name);
check('v4:6 v6:2 -> LOOPBACK_ONLY_VERIFIED (0)', withCounts(6, 2).code === 0, withCounts(6, 2).name);
check(
  'the untested family is named in the notes',
  withCounts(0, 1).notes.join(' ').includes('IPv4'),
  withCounts(0, 1).notes.join(' ').slice(0, 90)
);

section('7b. Malformed coverage evidence fails closed');

for (const [v4, v6, label] of [
  [-1, 1, 'negative IPv4 count'],
  [1, -3, 'negative IPv6 count'],
  [1.5, 1, 'fractional count'],
  ['2', 1, 'string count'],
  [NaN, 1, 'NaN count'],
  [null, 1, 'null count'],
  [undefined, 1, 'missing count'],
]) {
  const v = withCounts(v4, v6);
  check(`${label} -> UNKNOWN (2)`, v.code === 2, v.name);
}

{
  const v = classify({
    projectId: 'kiasa',
    discovery: loopbackOnly,
    loopbackOpen: { v4: [54322], v6: [54322] },
    externalOpen: [],
    externalTested: undefined,
  });
  check('a missing externalTested object -> UNKNOWN (2)', v.code === 2, v.name);
}

/* ------------------------------------------------------ 8. exit codes */

section('8. Every exit code is reachable');

check('LOOPBACK_ONLY_VERIFIED = 0', CLASSES.LOOPBACK.code === 0);
check('EXTERNALLY_EXPOSED     = 1', CLASSES.EXPOSED.code === 1);
check('UNKNOWN_OR_INCOMPLETE  = 2', CLASSES.UNKNOWN.code === 2);
check('STACK_NOT_RUNNING      = 3', CLASSES.NOT_RUNNING.code === 3);

console.log('\n========================================================');
if (failed === 0) {
  console.log(`ALL ${passed} EXPOSURE-DIAGNOSTIC CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
