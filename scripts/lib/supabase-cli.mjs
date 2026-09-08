/**
 * The Supabase CLI, pinned and repository-local.
 *
 * Everything that shells out to the CLI goes through here. Nothing anywhere
 * else may invoke `npx supabase`.
 *
 * WHY `npx supabase` WAS A REPRODUCIBILITY HOLE
 *
 * `supabase` was not a dependency of this project, so `npx supabase` resolved
 * nothing locally and silently downloaded whatever the registry called latest
 * at that moment. Two machines, or the same machine on two days, could run
 * different CLIs against the same migrations — and CI pinned a version the
 * local scripts never used, so "CI is green" said nothing about what a
 * developer had just run.
 *
 * The CLI is now an exact devDependency. `dist/supabase.js` is a small wrapper
 * that resolves a platform-specific `@supabase/cli-*` optional dependency out
 * of node_modules; all eight platform binaries are recorded in the lockfile at
 * the same version, so `npm ci` produces the pinned CLI on Windows, macOS and
 * Linux without reaching the network at run time.
 *
 * Invocation is `node <wrapper> …` rather than `node_modules/.bin/supabase`,
 * because that shim is a shell script on POSIX and a `.cmd` on Windows — using
 * it needs `shell: true`, which drags quoting rules into every call site. The
 * wrapper is plain JavaScript, so `process.execPath` runs it identically
 * everywhere with no shell at all.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** The one version source. CI asserts the executed CLI reports exactly this. */
export const SUPABASE_CLI_VERSION = '2.117.0';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_ENTRY = path.join(ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js');

/**
 * Absolute path to the pinned CLI entry point.
 *
 * Throws rather than falling back. A fallback to `npx` is precisely the
 * behaviour this module exists to remove: it would quietly download a
 * different version and carry on, which is worse than stopping.
 */
export function cliEntry() {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `The pinned Supabase CLI is not installed.\n` +
        `  expected: ${CLI_ENTRY}\n` +
        `  fix     : npm ci\n` +
        `Refusing to fall back to \`npx supabase\`, which would download a ` +
        `different version instead of failing.`
    );
  }
  return CLI_ENTRY;
}

/** Run the pinned CLI and return stdout. Throws on a non-zero exit. */
export function supabase(args, options = {}) {
  return execFileSync(process.execPath, [cliEntry(), ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

/** Run the pinned CLI without throwing; the caller inspects `status`. */
export function supabaseSpawn(args, options = {}) {
  return spawnSync(process.execPath, [cliEntry(), ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

/** The version the pinned CLI actually reports when executed. */
export function installedVersion() {
  return supabase(['--version']).trim();
}

/**
 * Fail unless the CLI that actually runs is exactly the pinned version.
 *
 * Checking what executes, not what package.json asks for: a stale
 * node_modules, a partial install or a lockfile edited by hand all produce a
 * package.json that says one thing and a binary that does another.
 */
export function assertPinnedVersion() {
  const actual = installedVersion();
  if (actual !== SUPABASE_CLI_VERSION) {
    throw new Error(
      `Supabase CLI version mismatch: expected exactly ${SUPABASE_CLI_VERSION}, got ${actual}. ` +
        `Run \`npm ci\` to restore the pinned version.`
    );
  }
  return actual;
}

/**
 * `supabase status -o env`, as raw text.
 *
 * Every suite parses this itself; this only guarantees the CLI that produced
 * it was the pinned one.
 */
export function statusEnvRaw() {
  return supabase(['status', '-o', 'env']);
}

/**
 * `supabase status -o env`, parsed, with the local-stack guarantee enforced.
 *
 * The loopback assertion lives here rather than in each caller so that no
 * suite can forget it: a test that would happily run against a hosted project
 * if the environment pointed there is a test that can mutate production.
 */
export function localStatusEnv() {
  const env = {};
  for (const line of statusEnvRaw().split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\r]*)"?/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.API_URL || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(env.API_URL)) {
    throw new Error(
      `Local Supabase is not running, or its API URL is not loopback: ${env.API_URL ?? '(none)'}`
    );
  }
  return env;
}
