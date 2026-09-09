/**
 * Validating a job URL a candidate pasted.
 *
 * NOTHING HERE FETCHES ANYTHING. This milestone defines and tests the rules;
 * the fetcher is a later, separately reviewed piece. That order is deliberate:
 * a fetcher written first would have its safety rules discovered afterwards,
 * by which point something has already made the request.
 *
 * THE THREAT THIS EXISTS FOR
 *
 * A candidate-supplied URL is attacker-controlled input that our SERVER will
 * later request. That is server-side request forgery in its textbook form. A
 * URL pointing at `169.254.169.254`, `127.0.0.1:54322` or `10.0.0.5` is not a
 * job posting — it is an attempt to make our infrastructure fetch something on
 * the attacker's behalf and hand back the result.
 *
 * So the rules below are allow-list shaped and fail closed: HTTPS only, public
 * destinations only, no credentials, no redirect to anywhere the original URL
 * would not have been allowed to go.
 *
 * WHAT THIS CANNOT DO, STATED PLAINLY
 *
 * A hostname is not an address. `evil.example.com` may resolve to
 * `127.0.0.1` today and something else tomorrow, and a check performed here is
 * a check performed before DNS. Literal private addresses are rejected here;
 * DNS-based rebinding must ALSO be defended at fetch time, by resolving first
 * and validating the resolved address immediately before connecting. That is
 * recorded in docs/AGENT-CONTROL-PLANE.md as a requirement of the fetcher, not
 * an optional extra.
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
  | { ok: true; canonical: string; host: string }
  | { ok: false; reason: UrlRejectReason; detail: string };

/** Only 443. A job posting on an unusual port is not worth the SSRF surface. */
const ALLOWED_PORTS = new Set(['', '443']);

/**
 * TLDs that never route to a public employer.
 * RFC 2606 and RFC 6761 reserved names, plus mDNS.
 */
const RESERVED_TLDS = ['localhost', 'local', 'internal', 'invalid', 'test', 'example', 'home.arpa'];

/** Tracking parameters, removed so the same posting canonicalises identically. */
const STRIPPED_PARAMS = [
  /^utm_/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^mc_[ce]id$/i,
  /^ref$/i,
  /^referrer$/i,
  /^source$/i,
  /^trk$/i,
  /^trackingId$/i,
];

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

  const canonical = new URL(url.toString());
  canonical.hostname = host;
  canonical.hash = '';
  canonical.username = '';
  canonical.password = '';
  if (canonical.port === '443') canonical.port = '';

  const keep: [string, string][] = [];
  for (const [k, v] of canonical.searchParams.entries()) {
    if (!STRIPPED_PARAMS.some((re) => re.test(k))) keep.push([k, v]);
  }
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  canonical.search = '';
  for (const [k, v] of keep) canonical.searchParams.append(k, v);

  // A trailing slash on a bare origin only; deeper paths keep their shape.
  let out = canonical.toString();
  if (canonical.pathname === '/' && keep.length === 0) out = out.replace(/\/$/, '');

  return { ok: true, canonical: out, host };
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
