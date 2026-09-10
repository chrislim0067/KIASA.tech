import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveLocalModel, type LocalClaudeAvailability } from '@/lib/agent/ai-mode';
import {
  LocalClaudeRequest,
  validateLocalOutput,
  type LocalClaudeOutcome,
  type LocalClaudeTransport,
} from '@/lib/local-claude/transport';

/**
 * The one adapter that actually talks to the candidate's local Claude.
 *
 * WHAT MAKES THIS A SUPPORTED PATH
 *
 * It spawns the official command-line interface as a child process and reads
 * its documented machine-readable output. Specifically:
 *
 *   - `claude auth status` reports login state as JSON. Documented subcommand.
 *   - `claude -p --output-format json` runs one non-interactive turn and
 *     prints a documented envelope. `-p/--print` exists precisely for
 *     non-interactive use.
 *   - `--model` takes the candidate's own selection.
 *
 * The interface owns its credential and manages its own login. THIS FILE NEVER
 * READS, STORES, FORWARDS OR EVEN OBSERVES IT. There is no cookie access, no
 * browser storage, no session token, no undocumented endpoint, no traffic
 * interception, and nothing pretending to be a person. If any of that were
 * required, the honest answer would be that no supported path exists — see
 * `PERMANENTLY_OUT_OF_SCOPE`.
 *
 * WHERE THIS RUNS
 *
 * On the candidate's own machine, inside their own worker, only. It is
 * imported by `worker/`, never by a route handler, a server action or anything
 * that executes on Vercel. The server has no local Claude and must never
 * pretend to.
 *
 * WHAT IS STILL OPEN
 *
 * Whether the candidate's subscription terms permit programmatic use at the
 * volume this product envisages is NOT a technical question, was not settled
 * by this adapter working, and is not ours to answer. `requireConsent` is its
 * enforcement point: without recorded consent the probe reports
 * `manual_required` and the paste console is used instead.
 */

/** The minimum interface version this adapter has been tested against. */
export const MIN_CLI_VERSION = '2.0.0';

/** How long the probe may take before it counts as absent. */
const PROBE_TIMEOUT_MS = 20_000;

export interface CliAdapterOptions {
  /** The executable. Overridable for tests; never taken from a request. */
  command?: string;
  /**
   * The candidate's chosen model.
   *
   * DELIBERATELY HAS NO DEFAULT MODEL CONSTANT. Their subscription, their
   * quota, their preference. An unset or unrecognised value makes the probe
   * report `unsupported`, which is a configuration error worth surfacing
   * rather than a reason to pick the most expensive model on their behalf.
   */
  model: string;
  /**
   * Whether the candidate has recorded consent to use their own subscription
   * this way. Required — there is no default, so it cannot be forgotten into
   * being true.
   */
  consented: boolean;
  /** Optional cap the caller has already evaluated. */
  dailyCapReached?: boolean;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * What to actually execute. Sometimes the interpreter, sometimes the binary.
 */
export interface ResolvedExecutable {
  command: string;
  /** Prefixed to every invocation. Non-empty when we resolved a script. */
  prefixArgs: readonly string[];
  /** How it was found. Reported in diagnostics; never a credential hint. */
  via: 'configured' | 'path_exe' | 'cmd_shim' | 'npm_global' | 'path_plain';
}

/**
 * Find the executable, WITHOUT using a shell.
 *
 * WHY THIS IS NOT JUST `spawn('claude')`
 *
 * On Windows the thing on PATH is a `.cmd` shim, and `CreateProcess` cannot
 * run a batch file — so a plain spawn fails with a misleading "not installed",
 * which is exactly what the first version of this adapter reported on a
 * machine where the interface was working fine.
 *
 * The obvious fix is `shell: true`. IT IS NOT TAKEN, deliberately. The prompt
 * we pass contains employer-controlled text from a job posting, and a shell
 * turns quotes, backticks and semicolons in that text into command execution
 * on the candidate's own computer. The prompt goes over stdin and the
 * arguments go as an array, so there is no command line to inject into — and
 * that property is worth more than the convenience.
 *
 * So the shim is RESOLVED to the real binary instead: the `.cmd` is read and
 * the path inside it extracted. A `.js` target is run with this process's own
 * Node rather than by association.
 */
export function resolveClaudeExecutable(configured?: string): ResolvedExecutable | null {
  if (configured) return { command: configured, prefixArgs: [], via: 'configured' };

  if (process.platform !== 'win32') {
    // POSIX shims are executable scripts with a shebang; spawn runs them.
    return { command: 'claude', prefixArgs: [], via: 'path_plain' };
  }

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const appData = process.env.APPDATA;
  if (appData) dirs.push(path.join(appData, 'npm'));

  for (const dir of dirs) {
    const exe = path.join(dir, 'claude.exe');
    if (existsSync(exe)) return { command: exe, prefixArgs: [], via: 'path_exe' };

    const cmd = path.join(dir, 'claude.cmd');
    if (!existsSync(cmd)) continue;

    let target: string | null = null;
    try {
      // The shim names its target in quotes, with %dp0% standing for its own
      // directory. Resolve that rather than guessing the layout.
      const body = readFileSync(cmd, 'utf8');
      const m = body.match(/"([^"]*\.(?:exe|js))"/i);
      if (m) target = m[1].replace(/%~?dp0%?/gi, `${dir}${path.sep}`);
    } catch {
      /* unreadable shim: fall through to the next PATH entry */
    }
    if (!target) continue;

    const resolved = path.normalize(target);
    if (!existsSync(resolved)) continue;
    return resolved.toLowerCase().endsWith('.js')
      ? { command: process.execPath, prefixArgs: [resolved], via: 'cmd_shim' }
      : { command: resolved, prefixArgs: [], via: 'cmd_shim' };
  }

  // The documented npm global layout, as a last resort.
  if (appData) {
    const guess = path.join(
      appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'
    );
    if (existsSync(guess)) return { command: guess, prefixArgs: [], via: 'npm_global' };
  }
  return null;
}

/**
 * Run the interface and collect its output.
 *
 * ARGUMENTS ARE PASSED AS AN ARRAY, never as a shell string, and `shell` is
 * left off. The prompt goes in over STDIN rather than as an argument. Both are
 * deliberate: the prompt contains candidate text and job-posting text, either
 * of which can contain quotes, newlines, backticks and semicolons, and a
 * shell-interpolated command line is how that becomes command execution.
 */
function runCli(
  exe: ResolvedExecutable,
  args: readonly string[],
  stdin: string,
  timeoutMs: number
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(exe.command, [...exe.prefixArgs, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // A killed process may not exit promptly; do not wait for it forever.
      setTimeout(() => finish(null), 2_000);
    }, timeoutMs);

    // Bounded, so a runaway process cannot exhaust the worker's memory.
    const cap = 4_000_000;
    child.stdout.on('data', (d) => {
      if (stdout.length < cap) stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < cap) stderr += String(d);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));

    child.stdin.on('error', () => {
      /* the process may exit before stdin is consumed; not fatal */
    });
    child.stdin.end(stdin);
  });
}

/** `2.1.266 (Claude Code)` -> `2.1.266`. Null when it does not look like one. */
function parseVersion(output: string): string | null {
  const m = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

const atLeast = (found: string, minimum: string): boolean => {
  const f = found.split('.').map(Number);
  const m = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((f[i] ?? 0) > (m[i] ?? 0)) return true;
    if ((f[i] ?? 0) < (m[i] ?? 0)) return false;
  }
  return true;
};

/**
 * Establish whether this machine really has the capability.
 *
 * ORDER MATTERS, and it is cheapest-and-most-decisive first: consent, then
 * model, then the executable, then its version, then login. Each step returns
 * a NAMED reason, because "local Claude unavailable" is useless to a candidate
 * trying to fix it, while "you are not signed in" is actionable.
 *
 * Consent is checked FIRST, before anything is executed. A machine that has
 * the capability but no recorded consent must not be probed for it — running
 * the interface to find out would already be the use that was not consented to.
 */
export async function probeLocalClaude(
  options: CliAdapterOptions
): Promise<LocalClaudeAvailability> {
  if (!options.consented) {
    return { status: 'manual_required', reason: 'candidate_has_not_consented' };
  }
  if (options.dailyCapReached) {
    return { status: 'manual_required', reason: 'daily_local_cap_reached' };
  }

  const model = resolveLocalModel(options.model);
  if (!model) return { status: 'unsupported', reason: 'disabled_by_candidate' };

  const exe = resolveClaudeExecutable(options.command);
  if (!exe) return { status: 'unsupported', reason: 'cli_not_installed' };

  const version = await runCli(exe, ['--version'], '', PROBE_TIMEOUT_MS);
  if (version.code !== 0) return { status: 'unsupported', reason: 'cli_not_installed' };

  const found = parseVersion(version.stdout);
  if (!found) return { status: 'unsupported', reason: 'cli_not_installed' };
  if (!atLeast(found, MIN_CLI_VERSION)) {
    return { status: 'unsupported', reason: 'cli_version_too_old' };
  }

  const auth = await runCli(exe, ['auth', 'status'], '', PROBE_TIMEOUT_MS);
  if (auth.code !== 0) return { status: 'unsupported', reason: 'cli_not_authenticated' };

  let status: { loggedIn?: boolean; subscriptionType?: string };
  try {
    status = JSON.parse(auth.stdout);
  } catch {
    return { status: 'unsupported', reason: 'probe_failed' };
  }
  if (status.loggedIn !== true) {
    return { status: 'unsupported', reason: 'cli_not_authenticated' };
  }
  /*
   * The subscription type is READ, never stored and never sent anywhere. It
   * decides only whether this machine can do the work; the email, org id and
   * everything else in that payload are ignored on purpose.
   */
  if (!status.subscriptionType) {
    return { status: 'unsupported', reason: 'no_subscription' };
  }

  return { status: 'supported', adapter: 'claude_code_cli', version: found, model };
}

/**
 * The tools the local call is forbidden from using.
 *
 * This is a TEXT GENERATION task. It has no business reading files, running
 * commands, or reaching the network, and the candidate's machine is not a
 * sandbox — it is where their documents live. Combined with
 * `--permission-prompts none`, which denies anything that would otherwise ask,
 * this keeps a prompt-injected instruction inside a job posting from becoming
 * an action on the candidate's own computer.
 *
 * That threat is real and specific: the prompt contains employer-controlled
 * text, and an employer page can contain whatever it likes.
 */
const DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'NotebookEdit',
] as const;

/**
 * The official-interface adapter.
 *
 * Every failure mode maps to a named outcome. Nothing throws: a worker that
 * crashes mid-task leaves a lease held until it expires, and an exception
 * escaping here would do exactly that.
 */
export function createCliTransport(options: CliAdapterOptions): LocalClaudeTransport {
  return {
    name: 'claude_code_cli',

    probe: () => probeLocalClaude(options),

    async run(request: LocalClaudeRequest): Promise<LocalClaudeOutcome> {
      const parsed = LocalClaudeRequest.safeParse(request);
      if (!parsed.success) {
        return { status: 'error', request_id: 'unknown', code: 'invalid_request' };
      }
      const req = parsed.data;

      const availability = await probeLocalClaude(options);
      if (availability.status === 'manual_required') {
        return { status: 'manual_required', reason: availability.reason };
      }
      if (availability.status !== 'supported') {
        return { status: 'unsupported', reason: availability.reason };
      }

      const model = resolveLocalModel(req.model) ?? availability.model;

      const exe = resolveClaudeExecutable(options.command);
      if (!exe) return { status: 'unsupported', reason: 'cli_not_installed' };

      const result = await runCli(
        exe,
        [
          '--print',
          '--output-format',
          'json',
          '--model',
          model,
          '--permission-prompts',
          'none',
          '--disallowedTools',
          ...DISALLOWED_TOOLS,
        ],
        req.prompt,
        req.timeout_ms
      );

      if (result.timedOut) {
        return { status: 'timeout', request_id: req.request_id, timeout_ms: req.timeout_ms };
      }
      if (result.code !== 0) {
        return { status: 'error', request_id: req.request_id, code: `exit_${result.code}` };
      }

      let envelope: {
        is_error?: boolean;
        subtype?: string;
        result?: unknown;
        duration_ms?: number;
        num_turns?: number;
        permission_denials?: unknown[];
        modelUsage?: Record<string, unknown>;
      };
      try {
        envelope = JSON.parse(result.stdout);
      } catch {
        return { status: 'invalid_output', request_id: req.request_id, detail: 'envelope not json' };
      }

      if (envelope.is_error === true) {
        // The subtype is a short documented code, safe to surface. The result
        // text is not, and is deliberately not included.
        return {
          status: 'error',
          request_id: req.request_id,
          code: String(envelope.subtype ?? 'unknown'),
        };
      }
      if (Array.isArray(envelope.permission_denials) && envelope.permission_denials.length > 0) {
        return {
          status: 'refused',
          request_id: req.request_id,
          detail: `${envelope.permission_denials.length} tool use(s) denied`,
        };
      }

      const checked = validateLocalOutput(req.capability, envelope.result, req.request_id);
      if (!('ok' in checked)) return checked;

      return {
        status: 'ok',
        request_id: req.request_id,
        capability: req.capability,
        output: checked.output,
        // What it says it used, not what we asked for. They can differ.
        model_reported: Object.keys(envelope.modelUsage ?? {}).join(',') || model,
        duration_ms: Number(envelope.duration_ms ?? 0),
        turns: Number(envelope.num_turns ?? 0),
      };
    },
  };
}
