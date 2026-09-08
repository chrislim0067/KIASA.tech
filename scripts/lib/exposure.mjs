/**
 * Exposure discovery and classification — pure, injectable, testable.
 *
 * Split out of scripts/check-local-exposure.mjs so the decision logic can be
 * exercised offline: no Docker, no sockets, no machine state. The runner
 * supplies real implementations; the tests supply fakes.
 *
 * WHY THIS EXISTS, AND WHAT IT FIXES
 *
 * The previous discovery silently swallowed failures:
 *
 *     try { raw = docker(...) } catch { continue; }      // container skipped
 *     try { ports = JSON.parse(raw) } catch { continue; } // container skipped
 *
 * With several containers running and only some inspectable, it classified the
 * subset it happened to read and ignored the rest — so it could report
 * LOOPBACK_ONLY_VERIFIED while holding no evidence at all about a container
 * publishing Postgres on 0.0.0.0. A security diagnostic that fails open is
 * worse than none, because it is believed.
 *
 * Everything here FAILS CLOSED. Any candidate container that cannot be fully
 * inspected, any unparseable output, any malformed binding, any nonsense port
 * — each one forces UNKNOWN_OR_INCOMPLETE. Only complete evidence can produce
 * a clean result.
 */

import { isIP } from 'node:net';

export const CLASSES = {
  NOT_RUNNING: { name: 'STACK_NOT_RUNNING', code: 3 },
  LOOPBACK: { name: 'LOOPBACK_ONLY_VERIFIED', code: 0 },
  EXPOSED: { name: 'EXTERNALLY_EXPOSED', code: 1 },
  UNKNOWN: { name: 'UNKNOWN_OR_INCOMPLETE', code: 2 },
};

/** Docker's own spelling for "every interface". */
const isWildcardHostIp = (ip) => ip === '0.0.0.0' || ip === '::' || ip === '[::]' || ip === '';

/**
 * Parse a Docker `HostIp` with a REAL address parser.
 *
 * The previous version tested loopback with `/^127\./`, which is a string
 * prefix and not an address check: `127.evil` matched, was recorded as
 * loopback, and could carry a run to LOOPBACK_ONLY_VERIFIED. Family was
 * decided by "does it contain a colon", which is the same class of guess.
 *
 * Returns `{ ok: true, … }` or `{ ok: false, reason }`. Anything that is not a
 * string, or is a non-empty string that `net.isIP` refuses, fails closed —
 * unparseable evidence is missing evidence, never benign.
 */
export function parseHostIp(hostIp) {
  if (typeof hostIp !== 'string') {
    return {
      ok: false,
      reason: `HostIp is ${hostIp === undefined ? 'missing' : typeof hostIp}, expected a string`,
    };
  }
  if (isWildcardHostIp(hostIp)) {
    // '' is Docker's "all interfaces"; family is unknown from the string alone.
    const family = hostIp === '::' || hostIp === '[::]' ? 6 : hostIp === '0.0.0.0' ? 4 : 0;
    return { ok: true, hostIp, family, wildcard: true, loopback: false };
  }

  // A bracketed IPv6 literal is valid in a host:port context.
  const bare = hostIp.startsWith('[') && hostIp.endsWith(']') ? hostIp.slice(1, -1) : hostIp;
  const family = isIP(bare);
  if (family !== 4 && family !== 6) {
    return { ok: false, reason: `HostIp ${JSON.stringify(hostIp)} is not a valid IP address` };
  }

  const loopback =
    family === 4
      ? bare.split('.')[0] === '127'
      : bare === '::1' || bare.toLowerCase() === '0:0:0:0:0:0:0:1';

  return { ok: true, hostIp, family, wildcard: false, loopback };
}

/**
 * Collect published bindings for every candidate container.
 *
 * `listContainers()` returns container names (may throw).
 * `inspectContainer(name)` returns the raw `.NetworkSettings.Ports` JSON
 * string (may throw, may return malformed JSON, may return null for a
 * container that has since disappeared).
 *
 * Returns `{ candidates, inspected, bindings, errors }`. `errors` is the
 * load-bearing field: it is never discarded, and any entry in it forces an
 * incomplete verdict downstream.
 */
export function discoverBindings({ listContainers, inspectContainer }) {
  const result = { candidates: [], inspected: [], bindings: [], errors: [] };

  let names;
  try {
    names = listContainers();
  } catch (error) {
    result.errors.push({
      kind: 'docker-unavailable',
      detail: String(error?.message ?? error).split('\n')[0],
    });
    return result;
  }

  if (!Array.isArray(names)) {
    result.errors.push({ kind: 'docker-unavailable', detail: 'container list was not an array' });
    return result;
  }

  result.candidates = names.filter(Boolean);

  for (const name of result.candidates) {
    let raw;
    try {
      raw = inspectContainer(name);
    } catch (error) {
      // Includes the container disappearing mid-discovery: docker inspect
      // exits non-zero, and that is missing evidence, not an absent container.
      result.errors.push({
        kind: 'inspect-failed',
        container: name,
        detail: String(error?.message ?? error).split('\n')[0],
      });
      continue;
    }

    if (raw === null || raw === undefined || String(raw).trim() === '') {
      result.errors.push({
        kind: 'inspect-empty',
        container: name,
        detail: 'no output; the container may have been removed during discovery',
      });
      continue;
    }

    let ports;
    try {
      ports = JSON.parse(String(raw));
    } catch (error) {
      result.errors.push({
        kind: 'malformed-json',
        container: name,
        detail: String(error?.message ?? error).split('\n')[0],
      });
      continue;
    }

    if (ports === null) {
      // A container with no port section at all. Recorded as inspected with
      // zero bindings rather than treated as an error.
      result.inspected.push(name);
      continue;
    }

    if (typeof ports !== 'object' || Array.isArray(ports)) {
      result.errors.push({
        kind: 'malformed-ports',
        container: name,
        detail: `expected an object, got ${Array.isArray(ports) ? 'array' : typeof ports}`,
      });
      continue;
    }

    let containerHadProblem = false;
    const pending = [];

    for (const [containerPort, hostList] of Object.entries(ports)) {
      if (hostList === null || hostList === undefined) continue; // exposed, not published
      if (!Array.isArray(hostList)) {
        result.errors.push({
          kind: 'malformed-binding',
          container: name,
          detail: `${containerPort}: expected an array of host bindings`,
        });
        containerHadProblem = true;
        continue;
      }
      for (const b of hostList) {
        if (!b || typeof b !== 'object') {
          result.errors.push({
            kind: 'malformed-binding',
            container: name,
            detail: `${containerPort}: binding entry is not an object`,
          });
          containerHadProblem = true;
          continue;
        }
        const hostPort = Number(b.HostPort);
        if (
          b.HostPort === undefined ||
          b.HostPort === null ||
          String(b.HostPort).trim() === '' ||
          !Number.isInteger(hostPort) ||
          hostPort <= 0 ||
          hostPort > 65535
        ) {
          result.errors.push({
            kind: 'invalid-host-port',
            container: name,
            detail: `${containerPort}: HostPort ${JSON.stringify(b.HostPort)}`,
          });
          containerHadProblem = true;
          continue;
        }
        const parsed = parseHostIp(b.HostIp);
        if (!parsed.ok) {
          result.errors.push({
            kind: 'invalid-host-ip',
            container: name,
            detail: `${containerPort}: ${parsed.reason}`,
          });
          containerHadProblem = true;
          continue;
        }
        pending.push({
          container: name,
          containerPort,
          hostIp: parsed.hostIp,
          hostPort,
          family: parsed.family,
          wildcard: parsed.wildcard,
          loopback: parsed.loopback,
        });
      }
    }

    result.bindings.push(...pending);
    if (!containerHadProblem) result.inspected.push(name);
  }

  return result;
}

/**
 * Turn evidence into a verdict.
 *
 * `evidence`:
 *   projectId        string | null
 *   discovery        the object from discoverBindings
 *   loopbackOpen     { v4: number[], v6: number[] }  ports that answered
 *   externalOpen     [{ address, family, open: number[] }]
 *   externalTested   { v4: number, v6: number }  interface counts actually probed
 */
export function classify(evidence) {
  const notes = [];
  const { projectId, discovery, loopbackOpen, externalOpen, externalTested } = evidence;

  if (!projectId) {
    return { ...CLASSES.UNKNOWN, notes: ['Could not read project_id from supabase/config.toml.'] };
  }

  const dockerDown = discovery.errors.some((e) => e.kind === 'docker-unavailable');
  if (dockerDown) {
    return {
      ...CLASSES.UNKNOWN,
      notes: [
        'Docker could not be queried, so no binding could be read.',
        ...discovery.errors.map((e) => `  ${e.kind}: ${e.detail}`),
      ],
    };
  }

  if (discovery.candidates.length === 0) {
    return { ...CLASSES.NOT_RUNNING, notes: [] };
  }

  // FAIL CLOSED. Any unreadable container is missing evidence, and a partial
  // read must never be presented as a clean result.
  if (discovery.errors.length > 0) {
    notes.push(
      `${discovery.candidates.length} candidate container(s), ` +
        `${discovery.inspected.length} fully inspected, ` +
        `${discovery.errors.length} problem(s):`
    );
    for (const e of discovery.errors) {
      notes.push(`  ${e.kind}${e.container ? ` [${e.container}]` : ''}: ${e.detail}`);
    }
    notes.push(
      '',
      'Evidence is incomplete, so no verdict is possible. A container that could',
      'not be inspected may be publishing a port on every interface.'
    );
    return { ...CLASSES.UNKNOWN, notes };
  }

  if (discovery.bindings.length === 0) {
    return {
      ...CLASSES.UNKNOWN,
      notes: [
        'Containers are running but none published a port binding.',
        'Nothing can be concluded about exposure.',
      ],
    };
  }

  const declaredNonLoopback = discovery.bindings.filter((b) => !b.loopback && !b.wildcard);
  const wildcard = discovery.bindings.filter((b) => b.wildcard);
  const externallyOpen = externalOpen.filter((e) => e.open.length > 0);

  // A binding declared on a specific non-loopback address is exposure by
  // declaration, whether or not that address appears in os.networkInterfaces().
  if (declaredNonLoopback.length > 0) {
    notes.push(
      `${declaredNonLoopback.length} binding(s) are declared on a non-loopback address:`,
      ...declaredNonLoopback.map((b) => `  ${b.hostIp}:${b.hostPort}  (${b.container})`)
    );
    return { ...CLASSES.EXPOSED, notes };
  }

  if (externallyOpen.length > 0) {
    notes.push(
      `${externallyOpen.reduce((n, e) => n + e.open.length, 0)} port(s) answered on a ` +
        'non-loopback address of this host:',
      ...externallyOpen.map((e) => `  ${e.address} (IPv${e.family}): ${e.open.join(', ')}`)
    );
    return { ...CLASSES.EXPOSED, notes };
  }

  if (wildcard.length > 0) {
    const v4 = wildcard.filter((b) => b.family === 4).length;
    const v6 = wildcard.filter((b) => b.family === 6).length;
    notes.push(
      `Nothing answered externally, but ${v4} IPv4 and ${v6} IPv6 WILDCARD binding(s) exist.`,
      'A wildcard binding that is currently unreachable is being blocked by',
      'something outside the binding itself — most likely a firewall — which is',
      'not the same as being bound to loopback, and can change without warning.'
    );
    return { ...CLASSES.UNKNOWN, notes };
  }

  if (loopbackOpen.v4.length === 0 && loopbackOpen.v6.length === 0) {
    return {
      ...CLASSES.UNKNOWN,
      notes: [
        'Bindings exist but nothing answered on loopback either; the stack may',
        'still be starting. Nothing can be concluded.',
      ],
    };
  }

  /*
   * EXIT 0 REQUIRES POSITIVE, VALID COVERAGE OF BOTH FAMILIES.
   *
   * The previous logic only rejected `v6 === 0` and the both-zero case, so
   * `{ v4: 0, v6: 1 }` fell through to LOOPBACK_ONLY_VERIFIED — announcing a
   * verified result while IPv4, the family every measurement on this machine
   * found exposed, had never been probed at all. A family that was not tested
   * is not a family that passed.
   */
  const counts = { v4: externalTested?.v4, v6: externalTested?.v6 };
  const badCount = (n) => !Number.isInteger(n) || n < 0;
  if (badCount(counts.v4) || badCount(counts.v6)) {
    return {
      ...CLASSES.UNKNOWN,
      notes: [
        'External-coverage counts are missing or not whole numbers, so how much',
        'of the host was actually probed is unknown.',
        `  IPv4: ${JSON.stringify(counts.v4)}   IPv6: ${JSON.stringify(counts.v6)}`,
      ],
    };
  }

  const untested = [];
  if (counts.v4 === 0) untested.push('IPv4');
  if (counts.v6 === 0) untested.push('IPv6');
  if (untested.length > 0) {
    return {
      ...CLASSES.UNKNOWN,
      notes: [
        `Every binding is loopback-scoped and nothing answered externally, but ` +
          `${untested.join(' and ')} ${untested.length > 1 ? 'were' : 'was'} never tested:`,
        `  IPv4 interfaces probed: ${counts.v4}`,
        `  IPv6 interfaces probed: ${counts.v6}`,
        '',
        'An untested family is not a passing family. Both must be positively',
        'covered before this can be called verified.',
      ],
    };
  }

  return {
    ...CLASSES.LOOPBACK,
    notes: [
      'Every published binding is loopback-scoped, and no port answered on any',
      `non-loopback address across ${counts.v4} IPv4 and ${counts.v6} IPv6 interface(s).`,
      '',
      'This describes THIS host at THIS moment. It is not a property of the',
      'repository: nothing here can pin the bind address.',
    ],
  };
}

/**
 * The stopped-stack guidance.
 *
 * Deliberately NOT "start it and run this again". On the machine this was
 * written for, the last measurement showed 0.0.0.0 and [::] bindings with
 * PostgreSQL reachable over the LAN, both active interfaces categorised
 * Public, and the Public firewall profile disabled. Telling someone to start
 * an uncontained stack is the diagnostic causing the exposure it reports.
 */
export const STOPPED_STACK_GUIDANCE = [
  'No containers are running for this project, so nothing could be measured.',
  '',
  'This is NOT evidence that the configuration is safe. It says only that the',
  'stack is stopped. How it binds when started depends on Docker daemon defaults',
  'that this repository cannot influence.',
  '',
  'DO NOT start the stack on this machine until ONE of the following is true:',
  '  * Windows Firewall protection is enabled and configured to block the',
  '    published ports inbound, or',
  '  * Docker loopback binding has been applied AND independently verified.',
  '',
  'The last recorded measurement found 0.0.0.0 and [::] bindings, PostgreSQL',
  'reachable over the LAN, both active interfaces categorised Public, and the',
  'Public firewall profile disabled.',
  '',
  'Read docs/LOCAL-NETWORK-EXPOSURE.md first. Changing Docker or firewall',
  'settings requires the machine owner’s approval; this tool changes nothing.',
];
