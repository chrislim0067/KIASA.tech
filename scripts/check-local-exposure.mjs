/**
 * Where is the local Supabase stack actually reachable from?
 *
 *   npm run check:exposure
 *
 * Read-only and non-destructive. It starts nothing, stops nothing, changes no
 * Docker, firewall, adapter or registry setting, and never contacts a hosted
 * project. It only observes.
 *
 * WHAT IT REPORTS
 *
 *   STACK_NOT_RUNNING       nothing to measure. NOT a statement about safety:
 *                           a stopped stack proves nothing about how it will
 *                           bind the next time it starts.
 *   LOOPBACK_ONLY_VERIFIED  every published port answered on loopback and on
 *                           no non-loopback address, for both IP families that
 *                           were testable.
 *   EXTERNALLY_EXPOSED      at least one port answered on a non-loopback
 *                           address of this host.
 *   UNKNOWN_OR_INCOMPLETE   the evidence is partial — Docker unreachable, port
 *                           bindings unreadable, or one family untestable.
 *                           Reported as unresolved, never as safe.
 *
 * Exit code follows the classification: 0 verified loopback-only, 1 exposed,
 * 2 unknown or incomplete, 3 not running.
 *
 * IT IS NOT A CI GATE, AND CI DOES NOT RUN IT.
 *
 * The condition it would assert cannot be satisfied by anything in this
 * repository: Supabase CLI 2.117.0 has no bind-address setting, so on a clean
 * checkout every port publishes on all interfaces. A gate that every developer
 * and every runner fails is a gate that gets deleted. It is a diagnostic, and
 * docs/LOCAL-NETWORK-EXPOSURE.md is the honest statement of the residual risk.
 *
 * THE TRUST BOUNDARY
 *
 * A probe from this host proves a socket is LISTENING on an address. It does
 * not prove a remote machine can reach it — a host firewall may block inbound
 * traffic while the binding is unchanged — and it does not prove a remote
 * machine cannot, because a firewall can be off, as it is on the machine this
 * was written for. Binding and reachability are separate facts and this tool
 * measures only the first, plus whatever the local IP stack will admit.
 *
 * Run it on the Windows/macOS/Linux host that publishes the ports. Inside a
 * container, inside WSL, or on a GitHub Actions runner you are measuring a
 * different network namespace, and the answer does not transfer to the host.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { Socket } from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROBE_TIMEOUT_MS = 2000;

/* --------------------------------------------------------------- helpers */

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

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

/** The project id the CLI namespaces its containers with. */
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

/**
 * Published port bindings, discovered from the running containers.
 *
 * Read from `docker inspect`, not from a hardcoded list: the list was the
 * previous version's weakness, since a port added or renamed by a CLI upgrade
 * would silently stop being checked. Config is used only to name the project
 * and as a fallback hint when nothing is running.
 */
function discoverBindings(project) {
  const names = docker([
    'ps',
    '--filter',
    `name=supabase_.*_${project}`,
    '--format',
    '{{.Names}}',
  ])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (names.length === 0) return { containers: [], bindings: [] };

  const bindings = [];
  for (const name of names) {
    let raw;
    try {
      raw = docker(['inspect', name, '--format', '{{json .NetworkSettings.Ports}}']);
    } catch {
      continue;
    }
    let ports;
    try {
      ports = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    for (const [containerPort, hostList] of Object.entries(ports ?? {})) {
      for (const b of hostList ?? []) {
        bindings.push({
          container: name,
          containerPort,
          hostIp: b.HostIp,
          hostPort: Number(b.HostPort),
          family: b.HostIp && b.HostIp.includes(':') ? 6 : 4,
        });
      }
    }
  }
  return { containers: names, bindings };
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
      // Link-local IPv6 needs a scope id to connect to and is not routable off
      // the link; excluded rather than reported as an untested unknown.
      else if (fam === 'IPv6' && !a.address.toLowerCase().startsWith('fe80')) {
        v6.push({ name, address: a.address });
      }
    }
  }
  return { v4, v6 };
}

/* ------------------------------------------------------------------ main */

const CLASS = {
  NOT_RUNNING: { name: 'STACK_NOT_RUNNING', code: 3 },
  LOOPBACK: { name: 'LOOPBACK_ONLY_VERIFIED', code: 0 },
  EXPOSED: { name: 'EXTERNALLY_EXPOSED', code: 1 },
  UNKNOWN: { name: 'UNKNOWN_OR_INCOMPLETE', code: 2 },
};

function finish(verdict, lines) {
  console.log('\n========================================================');
  console.log(`RESULT: ${verdict.name}`);
  for (const l of lines) console.log(l);
  console.log(
    '\nThis is a diagnostic, not a security gate, and CI does not run it.\n' +
      'See docs/LOCAL-NETWORK-EXPOSURE.md.'
  );
  process.exit(verdict.code);
}

const project = projectId();
if (!project) {
  finish(CLASS.UNKNOWN, ['Could not read project_id from supabase/config.toml.']);
}
console.log(`Project: ${project}`);

let discovered;
try {
  discovered = discoverBindings(project);
} catch (error) {
  finish(CLASS.UNKNOWN, [
    `Docker could not be queried: ${String(error.message).split('\n')[0]}`,
    'Without the published port bindings there is nothing to verify.',
  ]);
}

if (discovered.containers.length === 0) {
  finish(CLASS.NOT_RUNNING, [
    'No containers are running for this project, so nothing could be measured.',
    '',
    'This is NOT evidence that the configuration is safe. It says only that the',
    'stack is stopped. How it will bind when started depends on the Docker',
    'daemon defaults in force at that moment, and on this repository being unable',
    'to influence them at all.',
    '',
    'Start it with `npm run db:start` and run this again to get a real answer.',
  ]);
}

console.log(`Containers: ${discovered.containers.length}`);
console.log(`Published bindings: ${discovered.bindings.length}\n`);

if (discovered.bindings.length === 0) {
  finish(CLASS.UNKNOWN, [
    'Containers are running but no published port bindings were readable.',
    'Cannot conclude anything about exposure.',
  ]);
}

/* ------------------------------------------------- 1. declared bindings */

console.log('=== Published port bindings, as Docker reports them ===');
const wildcardV4 = [];
const wildcardV6 = [];
for (const b of discovered.bindings.sort((a, c) => a.hostPort - c.hostPort)) {
  const wildcard = b.hostIp === '0.0.0.0' || b.hostIp === '::' || b.hostIp === '';
  if (wildcard) (b.family === 6 ? wildcardV6 : wildcardV4).push(b);
  console.log(
    `  ${String(b.hostIp || '(unset)').padEnd(10)}:${String(b.hostPort).padEnd(6)}` +
      ` <- ${b.containerPort.padEnd(9)} ${b.container}${wildcard ? '   [WILDCARD]' : ''}`
  );
}
console.log(
  `\n  IPv4 wildcard bindings: ${wildcardV4.length}` +
    `   IPv6 wildcard bindings: ${wildcardV6.length}`
);

const ports = [...new Set(discovered.bindings.map((b) => b.hostPort))].sort((a, b) => a - b);

/* ------------------------------------------------------- 2. loopback */

console.log('\n=== Loopback (expected reachable; this is how the tests connect) ===');
const loopback = { v4: [], v6: [] };
for (const p of ports) {
  const okV4 = await probe('127.0.0.1', p, 4);
  const okV6 = await probe('::1', p, 6);
  if (okV4) loopback.v4.push(p);
  if (okV6) loopback.v6.push(p);
  console.log(`  ${String(p).padEnd(6)} IPv4 ${okV4 ? 'OPEN' : 'closed'}   IPv6 ${okV6 ? 'OPEN' : 'closed'}`);
}

/* --------------------------------------------------- 3. non-loopback */

const { v4, v6 } = hostAddresses();

console.log('\n=== Non-loopback IPv4 (ideally all closed) ===');
const exposedV4 = [];
if (v4.length === 0) console.log('  (no non-loopback IPv4 interfaces)');
for (const { name, address } of v4) {
  const open = [];
  for (const p of ports) if (await probe(address, p, 4)) open.push(p);
  if (open.length) exposedV4.push({ address, name, open });
  console.log(`  ${address.padEnd(16)} ${open.length ? `OPEN: ${open.join(', ')}` : 'none'}   (${name})`);
}

console.log('\n=== Non-loopback IPv6 (ideally all closed) ===');
const exposedV6 = [];
let v6Testable = true;
if (v6.length === 0) {
  v6Testable = false;
  console.log('  (no routable non-loopback IPv6 addresses on this host)');
  console.log('  IPv6 LAN reachability could NOT be tested here.');
}
for (const { name, address } of v6) {
  const open = [];
  for (const p of ports) if (await probe(address, p, 6)) open.push(p);
  if (open.length) exposedV6.push({ address, name, open });
  console.log(`  ${address.padEnd(40)} ${open.length ? `OPEN: ${open.join(', ')}` : 'none'}   (${name})`);
}

/* ------------------------------------------------------ 4. classify */

const notes = [];
const exposedCount =
  exposedV4.reduce((n, e) => n + e.open.length, 0) + exposedV6.reduce((n, e) => n + e.open.length, 0);

if (exposedCount > 0) {
  notes.push(
    `${exposedCount} port binding(s) answered on a non-loopback address of this host.`,
    exposedV4.length ? `  IPv4: ${exposedV4.map((e) => e.address).join(', ')}` : '  IPv4: none',
    exposedV6.length ? `  IPv6: ${exposedV6.map((e) => e.address).join(', ')}` : '  IPv6: none'
  );
  const pg = discovered.bindings.find((b) => b.containerPort.startsWith('5432/'));
  if (pg) {
    notes.push(
      '',
      `Port ${pg.hostPort} is PostgreSQL, and the local stack's password is the`,
      'well-known default. Anything that can route to this host can open a',
      'superuser connection to the development database.'
    );
  }
  notes.push(
    '',
    'Reachability from another machine additionally depends on the host firewall,',
    'which this tool does not evaluate. Mitigations: docs/LOCAL-NETWORK-EXPOSURE.md'
  );
  finish(CLASS.EXPOSED, notes);
}

if (wildcardV4.length > 0 || wildcardV6.length > 0) {
  notes.push(
    'Nothing answered on a non-loopback address, but Docker still reports',
    `${wildcardV4.length} IPv4 and ${wildcardV6.length} IPv6 WILDCARD binding(s).`,
    'A wildcard binding that is currently unreachable is being blocked by',
    'something outside the binding itself — most likely a firewall — so this is',
    'not the same as being bound to loopback. Treating it as verified would',
    'overstate the evidence.'
  );
  finish(CLASS.UNKNOWN, notes);
}

if (loopback.v4.length === 0 && loopback.v6.length === 0) {
  finish(CLASS.UNKNOWN, [
    'Containers are running and bindings exist, but nothing answered on loopback',
    'either. The stack may still be starting. Nothing can be concluded.',
  ]);
}

if (!v6Testable) {
  notes.push(
    'Every binding is loopback-scoped and nothing answered externally on IPv4.',
    'IPv6 could not be tested: this host has no routable non-loopback IPv6',
    'address. The IPv4 result is real; the IPv6 result is simply absent, so the',
    'overall answer is incomplete rather than verified.'
  );
  finish(CLASS.UNKNOWN, notes);
}

finish(CLASS.LOOPBACK, [
  'Every published binding is loopback-scoped, and no port answered on any',
  `non-loopback address of this host across ${v4.length} IPv4 and ${v6.length} IPv6 interface(s).`,
  '',
  'This describes THIS host at THIS moment. It is not a property of the',
  'repository: nothing here can pin the bind address, so a different machine,',
  'or this one after a Docker settings change, can differ.',
]);
