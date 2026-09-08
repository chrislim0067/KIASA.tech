/**
 * Report which interfaces the local Supabase stack is reachable on.
 *
 *   npm run check:exposure
 *
 * A DIAGNOSTIC, NOT A GATE. It always exits 0 when the stack is running,
 * because the condition worth asserting — loopback only — cannot be satisfied
 * by anything in this repository: Supabase CLI 2.117.0 has no bind-address
 * setting, so every published port lands on 0.0.0.0 on a clean checkout. A
 * check that fails for everyone is a check that gets deleted.
 *
 * See docs/LOCAL-NETWORK-EXPOSURE.md for the measurement this automates and
 * the two machine-level mitigations that do work.
 */
import { networkInterfaces } from 'node:os';
import { Socket } from 'node:net';

const PORTS = [
  [54321, 'API gateway (Kong)'],
  [54322, 'PostgreSQL  <- superuser, well-known local password'],
  [54323, 'Studio'],
  [54324, 'Mailpit'],
  [54327, 'Analytics (Logflare)'],
];

const probe = (host, port, timeout = 2000) =>
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
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, host);
  });

const external = [];
for (const [name, addrs] of Object.entries(networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === 'IPv4' && !a.internal) external.push({ name, address: a.address });
  }
}

console.log('\n=== Loopback (expected: reachable) ===');
let running = false;
for (const [port, label] of PORTS) {
  const open = await probe('127.0.0.1', port);
  if (open) running = true;
  console.log(`  127.0.0.1:${port}  ${open ? 'OPEN' : 'closed'}   ${label}`);
}

if (!running) {
  console.log('\nThe local stack does not appear to be running. Start it with `npm run db:start`.');
  process.exit(0);
}

console.log('\n=== Non-loopback interfaces (ideally: all closed) ===');
if (external.length === 0) console.log('  (no external IPv4 interfaces)');

let exposed = 0;
for (const { name, address } of external) {
  const open = [];
  for (const [port] of PORTS) if (await probe(address, port)) open.push(port);
  exposed += open.length;
  console.log(
    `  ${address.padEnd(16)} ${open.length ? `OPEN: ${open.join(', ')}` : 'none'}   (${name})`
  );
}

console.log('\n========================================================');
if (exposed === 0) {
  console.log('Loopback only. Nothing answers on a non-loopback interface.');
} else {
  console.log(
    `EXPOSED: ${exposed} port binding(s) answer on non-loopback interfaces.\n` +
      `Port 54322 is Postgres with the well-known local password, so anything that\n` +
      `can route to this host can open a superuser connection to the dev database.\n\n` +
      `This is expected on a clean checkout and cannot be fixed from repository\n` +
      `configuration. Mitigations: docs/LOCAL-NETWORK-EXPOSURE.md`
  );
}
process.exit(0);
