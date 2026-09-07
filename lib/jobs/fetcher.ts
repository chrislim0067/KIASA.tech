/**
 * Safe fetching of user-supplied URLs.
 *
 * Fetching a URL a user chose, from our server, is server-side request forgery
 * exposure by construction: the attacker picks the destination and we hold the
 * credentials and the network position. Everything here exists to make that
 * safe, and the guard runs BEFORE any socket is opened rather than after.
 *
 * The fetcher is an injectable interface. Production supplies `createSafeFetcher`;
 * tests supply a fixture and never reach the network.
 *
 * Never sent to a third-party host: cookies, Authorization, any Supabase key or
 * header, or anything identifying the user. Requests are made with credentials
 * omitted and an explicit header set.
 */
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/** Machine-readable outcomes. Mirrors the CHECK on `job_snapshots.outcome`. */
export type FetchOutcome =
  | 'ok'
  | 'gone'
  | 'access_blocked'
  | 'login_required'
  | 'rate_limited'
  | 'render_required'
  | 'too_large'
  | 'unsupported_content_type'
  | 'timeout'
  | 'transport'
  | 'refused_by_policy';

export interface FetchAttempt {
  readonly outcome: FetchOutcome;
  readonly httpStatus: number | null;
  readonly finalUrl: string | null;
  readonly contentType: string | null;
  readonly byteSize: number;
  readonly contentHash: string | null;
  readonly body: string | null;
  /** Machine-readable detail for the event log. Never free-form prose. */
  readonly reason: string | null;
}

export interface FetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly userAgent?: string;
  readonly respectRobots?: boolean;
}

/** The injectable seam. Production and fixtures both satisfy this. */
export interface JobFetcher {
  fetch(url: string, options?: FetchOptions): Promise<FetchAttempt>;
}

export const FETCH_DEFAULTS = {
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  userAgent: 'KIASA-JobIntake/1.0 (+https://kiasa.tech/bot)',
  respectRobots: true,
} as const;

/** Only these are stored; anything else is refused before reading a body. */
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'application/json', 'text/plain'];

/* ------------------------------------------------------- address policy */

/**
 * True when an IP literal is one we must never connect to.
 *
 * Covers loopback, RFC 1918 private space, link-local (including the cloud
 * metadata address 169.254.169.254), carrier-grade NAT, benchmarking and
 * documentation ranges, multicast, broadcast, and the IPv6 equivalents
 * including unique-local, and IPv4-mapped IPv6 which would otherwise smuggle a
 * private v4 address past a v6 check.
 */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address.toLowerCase());
  return true; // not an IP literal at all: refuse rather than guess
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true;                        // "this network"
  if (a === 10) return true;                       // RFC 1918
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true;         // RFC 1918
  if (a === 192 && b === 0) return true;           // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true;          // TEST-NET-2
  if (a === 203 && b === 0) return true;           // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true;                       // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(address: string): boolean {
  if (address === '::' || address === '::1') return true;      // unspecified, loopback
  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (/^fe[89ab]/.test(address)) return true;   // link-local fe80::/10
  if (/^f[cd]/.test(address)) return true;      // unique-local fc00::/7
  if (/^ff/.test(address)) return true;         // multicast
  if (/^(0{0,4}:){1,7}0{0,4}$/.test(address)) return true; // all-zero forms
  return false;
}

export type HostVerdict =
  | { allowed: true; addresses: string[] }
  | { allowed: false; reason: 'blocked_address' | 'dns_failure' | 'no_addresses' };

/**
 * Hostname -> addresses. Injectable so the address policy can be tested
 * exhaustively without DNS and without the public internet; production uses the
 * real resolver.
 */
export type HostResolver = (hostname: string) => Promise<{ address: string }[]>;

const systemResolver: HostResolver = (hostname) => lookup(hostname, { all: true });

/**
 * Resolves a hostname and refuses if ANY resolved address is non-public.
 *
 * Every address is checked, not just the first: a host that resolves to both a
 * public and a private address must be refused, because which one is used is
 * not ours to control. A hostname that is already an IP literal is checked
 * directly without a lookup.
 */
export async function checkHost(hostname: string, resolver: HostResolver = systemResolver): Promise<HostVerdict> {
  if (isIP(hostname) !== 0) {
    return isBlockedAddress(hostname)
      ? { allowed: false, reason: 'blocked_address' }
      : { allowed: true, addresses: [hostname] };
  }
  // A bare hostname with no dot ("localhost", "metadata") is never public.
  if (!hostname.includes('.') || hostname.toLowerCase() === 'localhost') {
    return { allowed: false, reason: 'blocked_address' };
  }
  let resolved: { address: string }[];
  try {
    resolved = await resolver(hostname);
  } catch {
    return { allowed: false, reason: 'dns_failure' };
  }
  if (resolved.length === 0) return { allowed: false, reason: 'no_addresses' };
  if (resolved.some((entry) => isBlockedAddress(entry.address))) {
    return { allowed: false, reason: 'blocked_address' };
  }
  return { allowed: true, addresses: resolved.map((entry) => entry.address) };
}

const refused = (reason: string): FetchAttempt => ({
  outcome: 'refused_by_policy',
  httpStatus: null, finalUrl: null, contentType: null,
  byteSize: 0, contentHash: null, body: null, reason,
});

/** Maps an HTTP status to a machine-readable outcome. */
export function outcomeForStatus(status: number): FetchOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'login_required';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429) return 'rate_limited';
  if (status === 451) return 'access_blocked';
  if (status >= 400 && status < 500) return 'access_blocked';
  return 'transport';
}

/* ------------------------------------------------------------- robots */

/**
 * Minimal robots.txt evaluation for our own user-agent token and `*`.
 *
 * Deliberately conservative: only `Disallow` is honoured, longest match wins,
 * and anything unparseable is treated as "allowed" rather than guessed at. A
 * refusal is a first-class outcome, not an error.
 */
export function isAllowedByRobots(robotsTxt: string, path: string, agentToken: string): boolean {
  const lines = robotsTxt.split(/\r?\n/);
  const groups: { agents: string[]; disallow: string[]; allow: string[] }[] = [];
  let current: { agents: string[]; disallow: string[]; allow: string[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '');
    const match = /^\s*([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (current && (field === 'disallow' || field === 'allow')) {
      lastWasAgent = false;
      if (field === 'disallow') current.disallow.push(value);
      else current.allow.push(value);
    }
  }

  const token = agentToken.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const group = specific ?? wildcard;
  if (!group) return true;

  const longest = (rules: string[]) =>
    rules.filter((r) => r !== '' && path.startsWith(r)).reduce((best, r) => (r.length > best ? r.length : best), -1);
  const disallowed = longest(group.disallow);
  const allowed = longest(group.allow);
  // An empty Disallow means "allow everything" and is skipped above.
  if (disallowed < 0) return true;
  return allowed >= disallowed;
}

/* ----------------------------------------------------- rate limiting */

/**
 * Per-host minimum spacing between requests. Process-local and best-effort: it
 * exists to keep KIASA from hammering a single host, not as a distributed
 * quota, and that limitation is deliberate rather than overlooked.
 */
class HostRateLimiter {
  private readonly lastRequestAt = new Map<string, number>();
  // An explicit field rather than a constructor parameter property: the latter
  // is not erasable, so it cannot be type-stripped, and the test suites load
  // these modules directly under Node.
  private readonly minIntervalMs: number;

  constructor(minIntervalMs: number) {
    this.minIntervalMs = minIntervalMs;
  }

  async wait(host: string, now: () => number = Date.now, sleep = defaultSleep): Promise<void> {
    const previous = this.lastRequestAt.get(host);
    const current = now();
    if (previous !== undefined) {
      const elapsed = current - previous;
      if (elapsed < this.minIntervalMs) await sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestAt.set(host, now());
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------ the fetcher */

/**
 * Production fetcher.
 *
 * Redirects are followed MANUALLY so the address policy can be re-applied to
 * every hop. Letting fetch follow them automatically would check only the URL
 * the user supplied, and a public host that redirects to 169.254.169.254 is
 * precisely the attack this must stop.
 */
export function createSafeFetcher(deps: {
  transport?: typeof globalThis.fetch;
  /** Injectable resolver; defaults to the system one. Tests supply a fixture. */
  resolver?: HostResolver;
  minHostIntervalMs?: number;
} = {}): JobFetcher {
  const transport = deps.transport ?? globalThis.fetch;
  const resolver = deps.resolver ?? systemResolver;
  const limiter = new HostRateLimiter(deps.minHostIntervalMs ?? 1000);
  const robotsCache = new Map<string, string | null>();

  async function readRobots(origin: string, userAgent: string, signal: AbortSignal): Promise<string | null> {
    if (robotsCache.has(origin)) return robotsCache.get(origin) ?? null;
    let text: string | null = null;
    try {
      const response = await transport(`${origin}/robots.txt`, {
        method: 'GET',
        redirect: 'follow',
        credentials: 'omit',
        headers: { 'user-agent': userAgent, accept: 'text/plain' },
        signal,
      });
      // A missing or server-errored robots.txt means "no rules stated".
      text = response.ok ? await response.text() : null;
    } catch {
      text = null;
    }
    robotsCache.set(origin, text);
    return text;
  }

  return {
    async fetch(rawUrl: string, options: FetchOptions = {}): Promise<FetchAttempt> {
      const timeoutMs = options.timeoutMs ?? FETCH_DEFAULTS.timeoutMs;
      const maxBytes = options.maxBytes ?? FETCH_DEFAULTS.maxBytes;
      const maxRedirects = options.maxRedirects ?? FETCH_DEFAULTS.maxRedirects;
      const userAgent = options.userAgent ?? FETCH_DEFAULTS.userAgent;
      const respectRobots = options.respectRobots ?? FETCH_DEFAULTS.respectRobots;

      let current: URL;
      try {
        current = new URL(rawUrl);
      } catch {
        return refused('not_a_url');
      }
      // Scheme allowlist, checked before any DNS lookup.
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return refused('unsupported_scheme');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let redirects = 0;
        for (;;) {
          const verdict = await checkHost(current.hostname, resolver);
          if (!verdict.allowed) return refused(verdict.reason);

          if (respectRobots) {
            const robots = await readRobots(current.origin, userAgent, controller.signal);
            if (robots !== null && !isAllowedByRobots(robots, current.pathname, userAgent)) {
              return refused('robots_disallowed');
            }
          }

          await limiter.wait(current.host);

          let response: Response;
          try {
            response = await transport(current.toString(), {
              method: 'GET',
              redirect: 'manual',       // re-check the address policy per hop
              credentials: 'omit',      // never send cookies
              headers: {
                'user-agent': userAgent,
                accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1',
              },
              signal: controller.signal,
            });
          } catch (error) {
            const aborted = (error as { name?: string })?.name === 'AbortError';
            return {
              outcome: aborted ? 'timeout' : 'transport',
              httpStatus: null, finalUrl: current.toString(), contentType: null,
              byteSize: 0, contentHash: null, body: null,
              reason: aborted ? 'timeout' : 'transport_error',
            };
          }

          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
              return { outcome: 'transport', httpStatus: response.status, finalUrl: current.toString(),
                contentType: null, byteSize: 0, contentHash: null, body: null, reason: 'redirect_without_location' };
            }
            if (redirects >= maxRedirects) return refused('too_many_redirects');
            redirects += 1;
            let next: URL;
            try {
              next = new URL(location, current);
            } catch {
              return refused('bad_redirect_target');
            }
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
              return refused('unsupported_scheme');
            }
            current = next;   // loop re-checks the address policy for this hop
            continue;
          }

          const contentType = response.headers.get('content-type');
          const status = response.status;
          const outcome = outcomeForStatus(status);
          if (outcome !== 'ok') {
            return { outcome, httpStatus: status, finalUrl: current.toString(), contentType,
              byteSize: 0, contentHash: null, body: null, reason: `http_${status}` };
          }

          const mediaType = (contentType ?? '').split(';')[0].trim().toLowerCase();
          if (mediaType !== '' && !ALLOWED_CONTENT_TYPES.includes(mediaType)) {
            return { outcome: 'unsupported_content_type', httpStatus: status,
              finalUrl: current.toString(), contentType, byteSize: 0, contentHash: null,
              body: null, reason: mediaType };
          }

          // Trust the declared length only to refuse early; the real limit is
          // enforced while streaming, because the header can lie.
          const declared = Number(response.headers.get('content-length') ?? '');
          if (Number.isFinite(declared) && declared > maxBytes) {
            return { outcome: 'too_large', httpStatus: status, finalUrl: current.toString(),
              contentType, byteSize: declared, contentHash: null, body: null, reason: 'content_length' };
          }

          const read = await readCapped(response, maxBytes);
          if (read === null) {
            return { outcome: 'too_large', httpStatus: status, finalUrl: current.toString(),
              contentType, byteSize: maxBytes, contentHash: null, body: null, reason: 'stream_exceeded_limit' };
          }
          return {
            outcome: 'ok',
            httpStatus: status,
            finalUrl: current.toString(),
            contentType,
            byteSize: read.byteSize,
            contentHash: createHash('sha256').update(read.bytes).digest('hex'),
            body: read.text,
            reason: null,
          };
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Reads a body, aborting as soon as the cap is exceeded rather than buffering
 * the whole response and checking afterwards. Returns null when the cap is hit.
 */
async function readCapped(
  response: Response, maxBytes: number,
): Promise<{ bytes: Buffer; text: string; byteSize: number } | null> {
  const stream = response.body;
  if (!stream) {
    const text = await response.text();
    const bytes = Buffer.from(text, 'utf8');
    return bytes.byteLength > maxBytes ? null : { bytes, text, byteSize: bytes.byteLength };
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, text: bytes.toString('utf8'), byteSize: bytes.byteLength };
}
