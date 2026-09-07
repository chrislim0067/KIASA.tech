/**
 * URL canonicalisation for job deduplication.
 *
 * Pure and deterministic: no network, no clock, no DNS. The same input always
 * produces the same canonical form, which is what makes the unique constraint
 * on (user_id, md5(canonical_url)) a reliable dedupe key.
 *
 * The rule is deliberately conservative. Canonicalisation decides whether two
 * submissions are the SAME job, so over-normalising silently merges two
 * genuinely different postings — a much worse outcome than storing a duplicate.
 * Anything that could carry meaning is therefore preserved: the path is left
 * exactly as given (case included), and only parameters that are known tracking
 * noise are removed.
 */

/**
 * Query parameters removed during canonicalisation.
 *
 * Every entry is analytics or referral metadata that cannot identify a posting.
 * Parameters that DO identify one — `gh_jid`, `jobId`, `id`, `lever-source`
 * style ids — are deliberately absent from this list and are preserved.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
  'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'twclid', 'igshid',
  'mc_cid', 'mc_eid', 'ref', 'referrer', 'referer', 'source',
  'trk', 'trkInfo', 'originalSubdomain', 'src', 'from',
  '_hsenc', '_hsmi', 'hsCtaTracking', 'vero_id', 'vero_conv',
  'yclid', 'ttclid', 'li_fat_id', 's_kwcid', 'ScCid',
]);

export interface CanonicalUrl {
  /** The URL exactly as the caller supplied it, unmodified. */
  readonly submitted: string;
  /** The deduplication form. */
  readonly canonical: string;
  /** Recognised applicant-tracking-system vendor, or null when unrecognised. */
  readonly atsVendor: string | null;
  /** Vendor job id when the URL states one deterministically, else null. */
  readonly externalJobId: string | null;
}

export type UrlRejection =
  | 'not_a_url'
  | 'unsupported_scheme'
  | 'missing_host'
  | 'too_long'
  | 'credentials_in_url';

export type CanonicalResult =
  | { ok: true; value: CanonicalUrl }
  | { ok: false; reason: UrlRejection };

const MAX_URL_LENGTH = 2048;

/**
 * Canonicalises a submitted URL.
 *
 * What is normalised, and why each is safe:
 *   - scheme and host are lower-cased (both are case-insensitive by RFC 3986);
 *   - a default port (80 for http, 443 for https) is dropped;
 *   - the fragment is dropped (never sent to a server, so it cannot select a
 *     different posting);
 *   - known tracking parameters are removed;
 *   - remaining query parameters are sorted by name, so the same parameters in
 *     a different order collapse together;
 *   - a single trailing slash on a non-root path is removed.
 *
 * What is deliberately NOT normalised:
 *   - path case, because many ATS hosts serve case-sensitive paths;
 *   - `www.` versus the bare host, because they are not guaranteed to be the
 *     same server;
 *   - http versus https, because they are different origins;
 *   - percent-encoding, beyond what the URL parser already does.
 */
export function canonicaliseUrl(input: string): CanonicalResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'not_a_url' };
  }
  if (input.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }
  if (!url.hostname) {
    return { ok: false, reason: 'missing_host' };
  }
  // Credentials in a URL would end up stored in plain text and sent to a third
  // party. Refuse rather than silently stripping them, so the caller learns.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials_in_url' };
  }

  const canonical = new URL(url.toString());
  canonical.protocol = scheme;
  canonical.hostname = url.hostname.toLowerCase();
  canonical.hash = '';
  if (
    (scheme === 'http:' && canonical.port === '80')
    || (scheme === 'https:' && canonical.port === '443')
  ) {
    canonical.port = '';
  }

  const kept: [string, string][] = [];
  for (const [key, value] of canonical.searchParams) {
    if (!TRACKING_PARAMS.has(key)) kept.push([key, value]);
  }
  // Sort by name, then value, so parameter order never creates a second job.
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  canonical.search = '';
  for (const [key, value] of kept) canonical.searchParams.append(key, value);

  if (canonical.pathname.length > 1 && canonical.pathname.endsWith('/')) {
    canonical.pathname = canonical.pathname.slice(0, -1);
  }

  const canonicalString = canonical.toString();
  if (canonicalString.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }

  const identified = identifyAts(canonical);
  return {
    ok: true,
    value: {
      submitted: input,
      canonical: canonicalString,
      atsVendor: identified.vendor,
      externalJobId: identified.jobId,
    },
  };
}

/**
 * Recognises an applicant-tracking system from the URL alone.
 *
 * Purely structural: host suffix plus a path shape. When the host is not one we
 * recognise, or the path does not match the vendor's documented shape, BOTH
 * values are null. Nothing is inferred from page content, and no id is invented
 * from a URL segment that merely looks numeric.
 */
function identifyAts(url: URL): { vendor: string | null; jobId: string | null } {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const hostIs = (suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

  if (hostIs('greenhouse.io')) {
    // /<board>/jobs/<id>  or  ?gh_jid=<id>
    const m = /\/jobs\/(\d+)(?:$|\/)/.exec(path) ?? null;
    const q = url.searchParams.get('gh_jid');
    return { vendor: 'greenhouse', jobId: m ? m[1] : (q && /^\d+$/.test(q) ? q : null) };
  }
  if (hostIs('lever.co')) {
    // /<company>/<uuid>
    const m = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|\/)/i.exec(path);
    return { vendor: 'lever', jobId: m ? m[1] : null };
  }
  if (hostIs('ashbyhq.com')) {
    const m = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:$|\/)/i.exec(path);
    return { vendor: 'ashby', jobId: m ? m[1] : null };
  }
  if (hostIs('myworkdayjobs.com') || hostIs('workday.com')) {
    // Workday encodes a requisition id as the final _R-prefixed segment.
    const m = /_(R-?\d+)(?:$|\/)/.exec(path);
    return { vendor: 'workday', jobId: m ? m[1] : null };
  }
  if (hostIs('smartrecruiters.com')) {
    const m = /\/(\d{6,})(?:$|\/)/.exec(path);
    return { vendor: 'smartrecruiters', jobId: m ? m[1] : null };
  }
  if (hostIs('workable.com')) {
    const m = /\/j\/([0-9A-F]{8,})(?:$|\/)/i.exec(path);
    return { vendor: 'workable', jobId: m ? m[1] : null };
  }
  if (hostIs('recruitee.com')) return { vendor: 'recruitee', jobId: null };
  if (hostIs('personio.de') || hostIs('jobs.personio.com')) {
    const m = /\/job\/(\d+)(?:$|\/)/.exec(path);
    return { vendor: 'personio', jobId: m ? m[1] : null };
  }
  if (hostIs('teamtailor.com')) return { vendor: 'teamtailor', jobId: null };
  if (hostIs('bamboohr.com')) return { vendor: 'bamboohr', jobId: null };
  if (hostIs('jobvite.com')) return { vendor: 'jobvite', jobId: null };
  if (hostIs('icims.com')) return { vendor: 'icims', jobId: null };
  if (hostIs('taleo.net')) return { vendor: 'taleo', jobId: null };
  if (hostIs('successfactors.com') || hostIs('successfactors.eu')) {
    return { vendor: 'successfactors', jobId: null };
  }
  if (hostIs('linkedin.com')) {
    const m = /\/jobs\/view\/(?:[^/]*-)?(\d{6,})(?:$|\/)/.exec(path);
    const q = url.searchParams.get('currentJobId');
    return { vendor: 'linkedin', jobId: m ? m[1] : (q && /^\d+$/.test(q) ? q : null) };
  }
  if (hostIs('indeed.com')) {
    const q = url.searchParams.get('jk');
    return { vendor: 'indeed', jobId: q && /^[0-9a-f]{8,}$/i.test(q) ? q : null };
  }
  return { vendor: null, jobId: null };
}
