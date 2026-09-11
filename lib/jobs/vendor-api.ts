import type { ExtractedFacts, ExtractionResult } from '@/lib/jobs/extract';

/**
 * Reading a posting from a job board's own public JSON, instead of its HTML.
 *
 * WHY THIS EXISTS
 *
 * A Greenhouse posting came back `Partly read` with no description. The page
 * was fetched successfully; there was simply nothing in the HTML to read,
 * because modern Greenhouse boards render the description in the browser. A
 * server that only ever sees the first response gets a shell.
 *
 * The answer is not a headless browser and not a model. Greenhouse publishes
 * the same posting as JSON at a documented public endpoint, and this module
 * derives that endpoint from the URL the candidate already gave us.
 *
 * THE ENDPOINT IS DERIVED, NEVER SUPPLIED
 *
 * The API host is a literal in this file. The only values taken from the
 * candidate's URL are a board token and a numeric job id, each matched against
 * a strict pattern and then percent-encoded. Nothing from a query string, a
 * redirect, a response body or a form reaches the endpoint, so there is no
 * input that can point this at a host of someone else's choosing.
 *
 * AND IT STILL GOES THROUGH THE SAME FETCHER
 *
 * The derived URL is handed to `lib/jobs/fetcher.ts` exactly as the canonical
 * URL is, so the scheme policy, the DNS and address checks, the redirect limit,
 * the robots rules, the timeout, the size cap, the content-type allowlist and
 * the per-host rate limiting all apply unchanged. There is no second fetcher
 * and no exemption: our own derived endpoint is treated as untrusted, which is
 * what makes it safe to derive one at all.
 */

/** Fixed. Never read from a URL, a payload, a header or a redirect. */
const GREENHOUSE_API_HOST = 'boards-api.greenhouse.io';

/** A board token as Greenhouse writes them in a path segment. */
const BOARD_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;

/** A Greenhouse job id is decimal and short. */
const JOB_ID = /^[0-9]{1,20}$/;

export type EndpointRefusal =
  | 'not_a_url'
  | 'unsupported_vendor'
  | 'no_board_token'
  | 'no_job_id';

export type VendorEndpoint =
  | { readonly ok: true; readonly vendor: 'greenhouse'; readonly url: string }
  | { readonly ok: false; readonly reason: EndpointRefusal };

/**
 * The public JSON endpoint for a posting, or a reason there is none.
 *
 * Greenhouse: `https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}`,
 * derived only from `https://<any>.greenhouse.io/<board>/jobs/<id>`.
 *
 * A posting embedded on an employer's own site — `careers.example.test/?gh_jid=1`
 * — carries the job id but NOT the board token, and the board cannot be
 * inferred from the employer's hostname. That returns `no_board_token` and the
 * HTML path is used instead. Guessing a board token would mean requesting an
 * arbitrary board's posting and presenting the answer as this job.
 */
export function vendorApiEndpoint(canonicalUrl: string): VendorEndpoint {
  let url: URL;
  try {
    url = new URL(canonicalUrl);
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }

  const host = url.hostname.toLowerCase();
  const isGreenhouse = host === 'greenhouse.io' || host.endsWith('.greenhouse.io');
  if (!isGreenhouse) return { ok: false, reason: 'unsupported_vendor' };

  /*
   * `/<board>/jobs/<id>`, and nothing else. Matched positionally rather than
   * by searching the path, so a crafted path like
   * `/evil/jobs/1/../../realboard/jobs/2` cannot present a different pair —
   * `new URL` has already normalised `..` away, and anything with extra
   * segments simply does not match.
   */
  const segments = url.pathname.split('/').filter((s) => s !== '');
  if (segments.length !== 3 || segments[1] !== 'jobs') {
    return { ok: false, reason: 'no_board_token' };
  }

  const [board, , jobId] = segments;
  if (!BOARD_TOKEN.test(board)) return { ok: false, reason: 'no_board_token' };
  if (!JOB_ID.test(jobId)) return { ok: false, reason: 'no_job_id' };

  /*
   * Encoded even though both have just been matched against patterns that
   * admit no character needing encoding. The encoding is not what makes this
   * safe — the patterns are — but a later loosening of a pattern should not
   * silently become a path-traversal or an injected query.
   */
  return {
    ok: true,
    vendor: 'greenhouse',
    url:
      `https://${GREENHOUSE_API_HOST}/v1/boards/` +
      `${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}`,
  };
}

/**
 * Was this snapshot taken from a vendor API rather than a web page?
 *
 * Answered from the URL actually fetched — `job_snapshots.final_url`, which
 * the fetcher records after following redirects — rather than from a content
 * type. A page can serve JSON and an API can be redirected; what decides which
 * parser to use is where the bytes came from.
 */
export function isVendorApiUrl(finalUrl: string | null | undefined): 'greenhouse' | null {
  if (typeof finalUrl !== 'string' || finalUrl === '') return null;
  try {
    return new URL(finalUrl).hostname.toLowerCase() === GREENHOUSE_API_HOST ? 'greenhouse' : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- parsing */

const EMPTY: ExtractedFacts = {
  title: null, company_name: null, location_raw: null, employment_type: null,
  date_posted: null, valid_through: null, salary_min: null, salary_max: null,
  salary_currency: null, salary_period: null, remote_type: null,
  description_text: null, apply_url: null, identifier: null,
};

/** Bounds matching what the database columns accept. */
const MAX_TITLE = 300;
const MAX_LOCATION = 300;
const MAX_DESCRIPTION = 50_000;
const MAX_URL = 2048;

const bounded = (value: unknown, limit: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, limit);
};

/**
 * The five entities Greenhouse escapes in `content`, and nothing else.
 *
 * A general-purpose entity decoder is a liability here: it would happily turn
 * `&lt;script&gt;` into a real tag inside a string that is later rendered. This
 * decodes exactly what the API encodes, and the result is still only ever
 * rendered as text.
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    // Ampersand LAST, or `&amp;lt;` would decode twice into a real `<`.
    .replace(/&amp;/g, '&');
}

/**
 * Turn Greenhouse's HTML description into text.
 *
 * `content` arrives as escaped HTML. Script and style ELEMENTS are removed with
 * their contents — not merely unwrapped — before any other tag is dropped, so a
 * script body never survives as visible text. What remains is text, and it is
 * rendered as text: nothing downstream treats it as markup.
 */
function htmlToText(raw: string): string {
  const html = decodeEntities(raw);
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    // An unclosed script tag would otherwise leave its body behind.
    .replace(/<(script|style)\b[\s\S]*$/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Map a Greenhouse job payload onto the facts the rest of the system uses.
 *
 * WHAT IS DELIBERATELY LEFT NULL
 *
 * `company_name`. The job endpoint does not state it, and the board token is a
 * slug chosen by whoever set the board up — `acmecorp` is not a company name,
 * and presenting it as one would be this system inventing a fact about an
 * employer. Salary, employment type and remote status are absent from this
 * payload too, and stay null rather than being guessed from the description.
 *
 * Everything here is treated as hostile: a title, a location and a description
 * are all employer-controlled text, bounded here and rendered as text later.
 */
export function greenhouseFacts(body: string): ExtractionResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { facts: EMPTY, provenance: {}, status: 'extraction_incomplete', reason: 'malformed_structured_data' };
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { facts: EMPTY, provenance: {}, status: 'extraction_incomplete', reason: 'malformed_structured_data' };
  }

  const record = payload as Record<string, unknown>;
  const provenance: Record<string, 'json_ld'> = {};
  const facts: ExtractedFacts = { ...EMPTY };

  const title = bounded(record.title, MAX_TITLE);
  if (title !== null) {
    facts.title = title;
    provenance.title = 'json_ld';
  }

  const location = record.location;
  const locationName =
    location !== null && typeof location === 'object'
      ? bounded((location as Record<string, unknown>).name, MAX_LOCATION)
      : null;
  if (locationName !== null) {
    facts.location_raw = locationName;
    provenance.location_raw = 'json_ld';
  }

  if (typeof record.content === 'string') {
    const text = htmlToText(record.content).slice(0, MAX_DESCRIPTION);
    if (text !== '') {
      facts.description_text = text;
      provenance.description_text = 'json_ld';
    }
  }

  /*
   * The apply URL is accepted only when the board itself states an https URL on
   * its own domain. A payload naming somewhere else is a payload we do not put
   * in front of a candidate as "where to apply".
   */
  const absolute = bounded(record.absolute_url, MAX_URL);
  if (absolute !== null && /^https:\/\//i.test(absolute)) {
    try {
      const host = new URL(absolute).hostname.toLowerCase();
      if (host === 'greenhouse.io' || host.endsWith('.greenhouse.io')) {
        facts.apply_url = absolute;
        provenance.apply_url = 'json_ld';
      }
    } catch {
      /* Not a URL we can reason about; left null. */
    }
  }

  const id = record.id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
    facts.identifier = String(id);
    provenance.identifier = 'json_ld';
  } else {
    const asText = bounded(id, 100);
    if (asText !== null && JOB_ID.test(asText)) {
      facts.identifier = asText;
      provenance.identifier = 'json_ld';
    }
  }

  const updated = bounded(record.updated_at, 40);
  if (updated !== null && !Number.isNaN(Date.parse(updated))) {
    facts.date_posted = new Date(updated).toISOString().slice(0, 10);
    provenance.date_posted = 'json_ld';
  }

  /*
   * A posting with no title AND no description told us nothing worth calling a
   * successful read. Saying so is the difference between "partly read" and a
   * blank record presented as complete.
   */
  const complete = facts.title !== null && facts.description_text !== null;
  return {
    facts,
    provenance,
    status: complete ? 'extracted' : 'extraction_incomplete',
    reason: complete ? null : 'partial_structured_data',
  };
}
