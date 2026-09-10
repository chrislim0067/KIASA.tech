import { canonicaliseUrl } from '@/lib/jobs/url';

/**
 * DESTINATION POLICY for a job URL a candidate pasted.
 *
 * NOTHING HERE FETCHES ANYTHING, and — since Milestone 2B — nothing here
 * CANONICALISES anything either. Read that second part carefully, because it
 * is the whole point of this file's shape:
 *
 *   THERE IS EXACTLY ONE CANONICAL URL NORMALIZER, AND IT IS
 *   `canonicaliseUrl()` IN `lib/jobs/url.ts`.
 *
 * This module used to have its own. The two agreed on most inputs and
 * disagreed on some — this one stripped a trailing slash from a bare origin,
 * sorted parameters by name only, and removed a slightly different tracking
 * list. That divergence was not cosmetic. The database's uniqueness constraint
 * is built on `md5(canonical_url)` from `lib/jobs/url.ts`, so a second
 * normalizer producing a second spelling of the same posting would defeat
 * deduplication entirely — and in THIS system, a duplicate job row means a
 * second real application, to the same employer, in the candidate's name.
 *
 * So `validateJobUrl()` now decides only WHETHER a destination is allowed, and
 * delegates WHAT THE URL IS to the one normalizer.
 *
 * THE THREAT THIS STILL EXISTS FOR
 *
 * A candidate-supplied URL is attacker-controlled input that our SERVER will
 * later request. That is server-side request forgery in its textbook form. A
 * URL pointing at `169.254.169.254`, `127.0.0.1:54322` or `10.0.0.5` is not a
 * job posting — it is an attempt to make our infrastructure fetch something on
 * the attacker's behalf and hand back the result. `lib/jobs/url.ts` does not
 * check any of that, by design: it answers "which posting is this", not "may
 * we go there". Both questions need an answer, and they are different
 * questions.
 *
 * So the rules below are allow-list shaped and fail closed: HTTPS only, public
 * destinations only, no credentials, no redirect to anywhere the original URL
 * would not have been allowed to go.
 *
 * WHAT THIS CANNOT DO, STATED PLAINLY
 *
 * A hostname is not an address. `evil.example.com` may resolve to `127.0.0.1`
 * today and something else tomorrow, and a check performed here is a check
 * performed before DNS. Literal private addresses are rejected here; DNS-based
 * rebinding is defended at fetch time by `lib/jobs/fetcher.ts`, which resolves
 * the hostname and validates EVERY resolved address immediately before
 * connecting, and re-checks each redirect hop.
 */

export const MAX_URL_LENGTH = 2048;

export type UrlRejectReason =
  | 'empty'
  | 'too_long'
  | 'not_a_url'
  | 'scheme_not_https'
  | 'credentials_in_url'
  | 'no_hostname'
  | 'hostname_not_public'
  | 'ip_literal_not_allowed'
  | 'loopback'
  | 'private_network'
  | 'link_local'
  | 'unique_local'
  | 'reserved_tld'
  | 'port_not_allowed';

export type UrlValidation =
  | {
      ok: true;
      /** Produced by `canonicaliseUrl()` in lib/jobs/url.ts. The only spelling. */
      canonical: string;
      host: string;
      atsVendor: string | null;
      externalJobId: string | null;
    }
  | { ok: false; reason: UrlRejectReason; detail: string };

/** Only 443. A job posting on an unusual port is not worth the SSRF surface. */
const ALLOWED_PORTS = new Set(['', '443']);

/**
 * TLDs that never route to a public employer.
 * RFC 2606 and RFC 6761 reserved names, plus mDNS.
 */
const RESERVED_TLDS = ['localhost', 'local', 'internal', 'invalid', 'test', 'example', 'home.arpa'];

/*
 * The tracking-parameter list that used to live here has been DELETED, not
 * moved. It is `TRACKING_PARAMS` in `lib/jobs/url.ts` and there is one of it.
 * Two lists would drift, and a drifted list is a duplicate job row.
 */

const isIpv4 = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

function ipv4Reason(host: string): UrlRejectReason | null {
  const parts = host.split('.').map(Number);
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return 'not_a_url';
  const [a, b] = parts;
  if (a === 127) return 'loopback';
  if (a === 10) return 'private_network';
  if (a === 172 && b >= 16 && b <= 31) return 'private_network';
  if (a === 192 && b === 168) return 'private_network';
  // 169.254.0.0/16 — the cloud metadata service lives at 169.254.169.254.
  if (a === 169 && b === 254) return 'link_local';
  if (a === 100 && b >= 64 && b <= 127) return 'private_network'; // CGNAT
  if (a === 0 || a >= 224) return 'private_network'; // this-network, multicast, reserved
  return null;
}

function ipv6Reason(raw: string): UrlRejectReason | null {
  const h = raw.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return 'loopback';
  if (h === '::' ) return 'private_network';
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    return 'link_local';
  }
  if (/^f[cd]/.test(h)) return 'unique_local';
  /*
   * IPv4-mapped addresses inherit the IPv4 verdict — and they must be matched
   * in the form the URL parser actually produces.
   *
   * `new URL('https://[::ffff:127.0.0.1]/')` normalises the host to
   * `[::ffff:7f00:1]`: the trailing 32 bits are re-serialised as hex groups,
   * not as a dotted quad. Matching only the dotted form therefore let
   * `::ffff:127.0.0.1` through as an unrecognised address — measured, and
   * caught by its own test. Both spellings are decoded here.
   */
  const dotted = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return ipv4Reason(dotted[1]) ?? 'ip_literal_not_allowed';

  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const quad = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    return ipv4Reason(quad) ?? 'ip_literal_not_allowed';
  }
  return null;
}

/**
 * Validate and canonicalise.
 *
 * Canonical form: lowercase host, no credentials, no default port, no
 * fragment, tracking parameters removed, remaining query parameters sorted. So
 * the same posting shared two ways produces one key, and duplicate detection
 * works on intent rather than on spelling.
 */
export function validateJobUrl(input: unknown): UrlValidation {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, reason: 'empty', detail: 'no url supplied' };
  }
  const raw = input.trim();
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'too_long', detail: `${raw.length} characters` };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not_a_url', detail: 'unparseable' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme_not_https', detail: url.protocol.replace(':', '') };
  }

  // A URL carrying credentials is either a mistake or an attempt to make our
  // server authenticate somewhere on someone's behalf.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials_in_url', detail: 'userinfo present' };
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: 'port_not_allowed', detail: url.port };
  }

  const host = url.hostname.toLowerCase();
  if (host === '') return { ok: false, reason: 'no_hostname', detail: 'empty host' };

  if (host.startsWith('[')) {
    const reason = ipv6Reason(host);
    if (reason) return { ok: false, reason, detail: 'ipv6 literal' };
    return { ok: false, reason: 'ip_literal_not_allowed', detail: 'ipv6 literal' };
  }

  if (isIpv4(host)) {
    const reason = ipv4Reason(host);
    if (reason) return { ok: false, reason, detail: 'ipv4 literal' };
    // A public IP literal is still refused: a real posting has a hostname, and
    // a bare address defeats any later certificate or allow-list reasoning.
    return { ok: false, reason: 'ip_literal_not_allowed', detail: 'ipv4 literal' };
  }

  if (host === 'localhost' || RESERVED_TLDS.some((t) => host === t || host.endsWith(`.${t}`))) {
    return { ok: false, reason: 'reserved_tld', detail: host };
  }

  // A public hostname has a dot and a plausible TLD. `intranet` does not.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(host)) {
    return { ok: false, reason: 'hostname_not_public', detail: host };
  }

  /*
   * The destination is allowed. WHAT the URL is, is not this module's
   * question — hand it to the one normalizer.
   *
   * Its rejections are re-mapped rather than passed through, so a caller sees
   * this module's vocabulary throughout. In practice they cannot fire: every
   * rejection it can produce (scheme, host, credentials, length) has already
   * been checked above, and the fallback exists so that a future change to
   * either module fails closed instead of returning an un-canonicalised URL.
   */
  const normalised = canonicaliseUrl(raw);
  if (!normalised.ok) {
    const mapped: Record<string, UrlRejectReason> = {
      not_a_url: 'not_a_url',
      unsupported_scheme: 'scheme_not_https',
      missing_host: 'no_hostname',
      too_long: 'too_long',
      credentials_in_url: 'credentials_in_url',
    };
    return {
      ok: false,
      reason: mapped[normalised.reason] ?? 'not_a_url',
      detail: `canonicaliser: ${normalised.reason}`,
    };
  }

  return {
    ok: true,
    canonical: normalised.value.canonical,
    host,
    atsVendor: normalised.value.atsVendor,
    externalJobId: normalised.value.externalJobId,
  };
}

/**
 * The deduplication key for a canonical URL.
 *
 * ONE FUNCTION, used by every ingestion path, so that two routes to the same
 * posting cannot produce two keys. It mirrors the database's
 * `md5(canonical_url)` uniqueness constraint — the database is the authority,
 * and this exists so a caller can check before writing rather than discovering
 * the collision from an error code.
 *
 * Takes a CANONICAL url. Passing a raw one is the mistake this whole
 * reconciliation exists to prevent, so it canonicalises defensively and
 * returns null rather than hashing something that was never normalised.
 */
export function jobDedupeKey(canonicalOrRaw: string): string | null {
  const r = canonicaliseUrl(canonicalOrRaw);
  return r.ok ? r.value.canonical : null;
}

/**
 * Is a redirect safe to follow?
 *
 * The destination must independently satisfy every rule above — a redirect is
 * a fresh request to a fresh URL, and "we already validated the first one" is
 * exactly the reasoning an open redirect exploits. Cross-host redirects are
 * permitted (`greenhouse.io` → `boards.greenhouse.io` is normal) but only to
 * a destination that would have been accepted on its own.
 */
export type RedirectVerdict =
  | { ok: true; canonical: string; host: string; crossHost: boolean }
  | { ok: false; reason: UrlRejectReason | 'too_many_redirects'; detail: string };

export const MAX_REDIRECTS = 5;

export function validateRedirect(
  fromUrl: string,
  toUrl: unknown,
  hop: number
): RedirectVerdict {
  if (hop > MAX_REDIRECTS) {
    return { ok: false, reason: 'too_many_redirects', detail: `hop ${hop}` };
  }
  const target = validateJobUrl(toUrl);
  if (!target.ok) return target;

  let fromHost = '';
  try {
    fromHost = new URL(fromUrl).hostname.toLowerCase();
  } catch {
    /* the caller's own URL was already validated; treat as cross-host */
  }
  return {
    ok: true,
    canonical: target.canonical,
    host: target.host,
    crossHost: fromHost !== target.host,
  };
}
