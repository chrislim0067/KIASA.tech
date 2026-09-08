/**
 * Where is the local Supabase stack actually reachable from?
 *
 *   npm run check:exposure
 *
 * Read-only and non-destructive. It starts nothing, stops nothing, changes no
 * Docker, firewall, adapter, service or registry setting, deletes no container,
 * network, volume or file, and never contacts a hosted project. It observes.
 *
 * This file is only the runner. Discovery and classification live in
 * scripts/lib/exposure.mjs so they can be tested offline against fakes —
 * see scripts/test-exposure-diagnostic.mjs.
 *
 * RESULTS
 *
 *   STACK_NOT_RUNNING       (3)  nothing to measure. NOT a safety statement.
 *   LOOPBACK_ONLY_VERIFIED  (0)  complete evidence, loopback only, both families.
 *   EXTERNALLY_EXPOSED      (1)  a port is declared on, or answered from, a
 *                                non-loopback address.
 *   UNKNOWN_OR_INCOMPLETE   (2)  evidence is partial. Fails closed: any
 *                                container that could not be fully inspected
 *                                lands here rather than being ignored.
 *
 * IT IS NOT A CI GATE, AND CI DOES NOT RUN IT. The condition worth asserting
 * cannot be satisfied from this repository — CLI 2.117.0 has no bind-address
 * setting — and a gate everyone fails gets deleted. CI runs the offline unit
 * tests of the logic instead, which is a claim it can actually make.
 *
 * TRUST BOUNDARY
 *
 * A probe from this host proves a socket is LISTENING on an address. It does
 * not prove a remote machine can reach it (a firewall may block inbound while
 * the binding is unchanged), nor that one cannot (the firewall may be off, as
 * it is here). Run this on the host that publishes the ports — inside a
 * container, inside WSL, or on a CI runner you are measuring a different
 * network namespace and the answer does not transfer.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { Socket } from 'node:net';
import path from 'node:path';

import {
  CLASSES,
  STOPPED_STACK_GUIDANCE,
  classify,
  discoverBindings,
} from './lib/exposure.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROBE_TIMEOUT_MS = 2000;

const docker = (args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const probe = (host, port, family) =>
  new Promise((resolve) => {
    const s = new Socket();
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        s.destroy();
        resolve(v);
      }
    };
    s.setTimeout(PROBE_TIMEOUT_MS);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    try {
      s.connect({ host, port, family });
    } catch {
      done(false);
    }
  });

function projectId() {
  try {
    const toml = readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');
    const m = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return null;
}

/** Non-loopback addresses of this host, per family. */
function hostAddresses() {
  const v4 = [];
  const v6 = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      const fam = typeof a.family === 'string' ? a.family : `IPv${a.family}`;
      if (fam === 'IPv4') v4.push({ name, address: a.address });
      // Link-local IPv6 needs a scope id and is not routable off the link.
      else if (fam === 'IPv6' && !a.address.toLowerCase().startsWith('fe80')) {
        v6.push({ name, address: a.address });
      }
    }
  }
  return { v4, v6 };
}

function report(verdict) {
  console.log('\n========================================================');
  console.log(`RESULT: ${verdict.name}`);
  for (const l of verdict.notes) console.log(l);
  console.log(
    '\nThis is a diagnostic, not a security gate, and CI does not run it.\n' +
      'See docs/LOCAL-NETWORK-EXPOSURE.md.'
  );
  process.exit(verdict.code);
}

/* ------------------------------------------------------------------ run */

const project = projectId();
console.log(`Project: ${project ?? '(unreadable)'}`);

const discovery = discoverBindings({
  listContainers: () =>
    docker(['ps', '--filter', `name=supabase_.*_${project}`, '--format', '{{.Names}}'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  inspectContainer: (name) =>
    docker(['inspect', name, '--format', '{{json .NetworkSettings.Ports}}']).trim(),
});

// Short-circuit the two cases that need no probing, so a stopped stack never
// opens a socket and never suggests starting an uncontained one.
if (!project || discovery.errors.some((e) => e.kind === 'docker-unavailable')) {
  report(classify({ projectId: project, discovery, loopbackOpen: { v4: [], v6: [] }, externalOpen: [], externalTested: { v4: 0, v6: 0 } }));
}
if (discovery.candidates.length === 0) {
  report({ ...CLASSES.NOT_RUNNING, notes: STOPPED_STACK_GUIDANCE });
}

console.log(`Candidate containers: ${discovery.candidates.length}`);
console.log(`Fully inspected     : ${discovery.inspected.length}`);
console.log(`Published bindings  : ${discovery.bindings.length}`);
console.log(`Discovery problems  : ${discovery.errors.length}\n`);

if (discovery.bindings.length > 0) {
  console.log('=== Published port bindings, as Docker reports them ===');
  for (const b of [...discovery.bindings].sort((a, c) => a.hostPort - c.hostPort)) {
    const tag = b.wildcard ? '   [WILDCARD]' : b.loopback ? '   [loopback]' : '   [NON-LOOPBACK]';
    console.log(
      `  ${String(b.hostIp || '(unset)').padEnd(10)}:${String(b.hostPort).padEnd(6)}` +
        ` <- ${b.containerPort.padEnd(9)} ${b.container}${tag}`
    );
  }
}

// If discovery is already incomplete, probing adds nothing: the verdict is
// fixed. Skipping the probes also keeps a failing run cheap.
if (discovery.errors.length > 0 || discovery.bindings.length === 0) {
  report(
    classify({
      projectId: project,
      discovery,
      loopbackOpen: { v4: [], v6: [] },
      externalOpen: [],
      externalTested: { v4: 0, v6: 0 },
    })
  );
}

const ports = [...new Set(discovery.bindings.map((b) => b.hostPort))].sort((a, b) => a - b);

console.log('\n=== Loopback (expected reachable; this is how the tests connect) ===');
const loopbackOpen = { v4: [], v6: [] };
for (const p of ports) {
  const okV4 = await probe('127.0.0.1', p, 4);
  const okV6 = await probe('::1', p, 6);
  if (okV4) loopbackOpen.v4.push(p);
  if (okV6) loopbackOpen.v6.push(p);
  console.log(
    `  ${String(p).padEnd(6)} IPv4 ${okV4 ? 'OPEN' : 'closed'}   IPv6 ${okV6 ? 'OPEN' : 'closed'}`
  );
}

const { v4, v6 } = hostAddresses();
const externalOpen = [];

console.log('\n=== Non-loopback IPv4 (ideally all closed) ===');
if (v4.length === 0) console.log('  (none)');
for (const { name, address } of v4) {
  const open = [];
  for (const p of ports) if (await probe(address, p, 4)) open.push(p);
  externalOpen.push({ address, family: 4, open });
  console.log(`  ${address.padEnd(16)} ${open.length ? `OPEN: ${open.join(', ')}` : 'none'}   (${name})`);
}

console.log('\n=== Non-loopback IPv6 (ideally all closed) ===');
if (v6.length === 0) console.log('  (no routable non-loopback IPv6 address; IPv6 NOT tested)');
for (const { name, address } of v6) {
  const open = [];
  for (const p of ports) if (await probe(address, p, 6)) open.push(p);
  externalOpen.push({ address, family: 6, open });
  console.log(`  ${address.padEnd(40)} ${open.length ? `OPEN: ${open.join(', ')}` : 'none'}   (${name})`);
}

report(
  classify({
    projectId: project,
    discovery,
    loopbackOpen,
    externalOpen,
    externalTested: { v4: v4.length, v6: v6.length },
  })
);
