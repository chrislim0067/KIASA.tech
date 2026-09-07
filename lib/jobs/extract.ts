/**
 * Deterministic extraction of job facts from a fetched page.
 *
 * A PURE function of the snapshot body: no network, no clock, no randomness, no
 * AI. The same bytes always produce the same facts, which is what lets a
 * re-extraction be idempotent and lets a reviewer reproduce any stored fact.
 *
 * It reads ONLY structured data the page explicitly publishes:
 *   1. JSON-LD  — <script type="application/ld+json"> containing schema.org
 *                 JobPosting, including inside an @graph;
 *   2. microdata — itemscope/itemtype ending in schema.org/JobPosting, with
 *                 itemprop attributes;
 *   3. meta      — og: and standard <meta name> tags, for title/description only.
 *
 * Anything the page does not state is NULL. There is no inference: employment
 * type is never guessed from prose, seniority is never guessed from a title,
 * and a salary is never derived from a number mentioned in the description.
 * Heuristic and model-based extraction are a later, separately reviewed step.
 *
 * Text is stored exactly as published. Nothing is trimmed, case-folded or
 * whitespace-collapsed. HTML character references ARE decoded, because `&amp;`
 * in markup *is* the character `&` — decoding recovers the published text
 * rather than altering it.
 *
 * No HTML parser dependency: the three sources above are locatable with bounded
 * scanning over the markup, and adding a parser would pull a large transitive
 * tree in for a job this narrow. Where markup is too irregular to read without
 * one, extraction reports the field as absent rather than guessing.
 */

/** Which structured source produced a field. No confidence scores. */
export type ExtractionMethod = 'json_ld' | 'microdata' | 'meta';

export type ExtractionReason =
  | 'no_structured_data'
  | 'malformed_structured_data'
  | 'partial_structured_data';

/** Every field is nullable. Absent in the source means null here. */
export interface ExtractedFacts {
  title: string | null;
  company_name: string | null;
  location_raw: string | null;
  employment_type: string | null;
  date_posted: string | null;
  valid_through: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: string | null;
  remote_type: string | null;
  description_text: string | null;
  apply_url: string | null;
  identifier: string | null;
}

export interface ExtractionResult {
  readonly facts: ExtractedFacts;
  /** One entry per field actually found, naming the method that produced it. */
  readonly provenance: Readonly<Record<string, ExtractionMethod>>;
  readonly status: 'extracted' | 'extraction_incomplete';
  readonly reason: ExtractionReason | null;
}

const EMPTY_FACTS: ExtractedFacts = {
  title: null, company_name: null, location_raw: null, employment_type: null,
  date_posted: null, valid_through: null, salary_min: null, salary_max: null,
  salary_currency: null, salary_period: null, remote_type: null,
  description_text: null, apply_url: null, identifier: null,
};

/** schema.org employmentType values mapped to the column's vocabulary. */
const EMPLOYMENT_TYPE_VALUES = new Set([
  'FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN',
  'VOLUNTEER', 'PER_DIEM', 'OTHER',
]);

const SALARY_PERIODS: Record<string, string> = {
  HOUR: 'hourly', HOURLY: 'hourly',
  DAY: 'daily', DAILY: 'daily',
  WEEK: 'weekly', WEEKLY: 'weekly',
  MONTH: 'monthly', MONTHLY: 'monthly',
  YEAR: 'annual', YEARLY: 'annual', ANNUAL: 'annual',
};

/**
 * Decodes HTML character references. Named entities are limited to the five
 * that are mandatory in markup plus nbsp; anything else is left exactly as
 * written rather than guessed at.
 */
function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    switch (body.toLowerCase()) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return ' ';
      default: return whole;
    }
  });
}

/** A usable string value: present, a string, and not empty. Never trimmed. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A JSON-LD number may legitimately arrive as a string; accept only a value
  // that is entirely numeric, never a number pulled out of surrounding prose.
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** schema.org fields are frequently either a value or an array of values. */
const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);

/* ------------------------------------------------------------- JSON-LD */

/** Collects every <script type="application/ld+json"> block's raw contents. */
function jsonLdBlocks(html: string): string[] {
  const blocks: string[] = [];
  const pattern = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) blocks.push(match[1]);
  return blocks;
}

/** Walks parsed JSON-LD for the first node whose @type includes JobPosting. */
function findJobPosting(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 12 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findJobPosting(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'jobposting')) {
    return record;
  }
  for (const key of ['@graph', 'mainEntity', 'itemListElement']) {
    if (key in record) {
      const found = findJobPosting(record[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function fromJsonLd(posting: Record<string, unknown>, facts: ExtractedFacts, provenance: Record<string, ExtractionMethod>): void {
  const put = <K extends keyof ExtractedFacts>(field: K, value: ExtractedFacts[K]) => {
    if (value === null || facts[field] !== null) return;
    facts[field] = value;
    provenance[field as string] = 'json_ld';
  };

  put('title', text(posting.title));
  put('identifier', text(first(posting.identifier)) ?? text((first(posting.identifier) as Record<string, unknown>)?.value));

  const org = first(posting.hiringOrganization) as Record<string, unknown> | undefined;
  put('company_name', text(org?.name));

  const location = first(posting.jobLocation) as Record<string, unknown> | undefined;
  const addr = location?.address as Record<string, unknown> | undefined;
  if (addr) {
    const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
      .map((p) => (typeof p === 'string' ? p : typeof p === 'object' && p !== null ? text((p as Record<string, unknown>).name) : null))
      .filter((p): p is string => p !== null && p.length > 0);
    if (parts.length > 0) put('location_raw', parts.join(', '));
  } else {
    put('location_raw', text(location?.name));
  }

  const employment = first(posting.employmentType);
  if (typeof employment === 'string') {
    const normalised = employment.toUpperCase().replace(/[\s-]+/g, '_');
    // Only a value the vocabulary actually defines is recorded. An unrecognised
    // string is left null rather than passed through as if it were meaningful.
    if (EMPLOYMENT_TYPE_VALUES.has(normalised)) put('employment_type', normalised);
  }

  const posted = text(posting.datePosted);
  if (posted) {
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(posted);
    if (date) put('date_posted', date[1]);
  }
  const until = text(posting.validThrough);
  if (until && !Number.isNaN(Date.parse(until))) put('valid_through', new Date(until).toISOString());

  const salary = first(posting.baseSalary) as Record<string, unknown> | undefined;
  if (salary) {
    const currency = text(salary.currency) ?? text(salary.salaryCurrency);
    if (currency && /^[A-Za-z]{3}$/.test(currency)) put('salary_currency', currency.toUpperCase());
    const value = first(salary.value) as Record<string, unknown> | undefined;
    if (value) {
      const min = numeric(value.minValue);
      const max = numeric(value.maxValue);
      const exact = numeric(value.value);
      put('salary_min', min ?? exact);
      put('salary_max', max ?? exact);
      const unit = text(value.unitText);
      if (unit) {
        const period = SALARY_PERIODS[unit.toUpperCase()];
        if (period) put('salary_period', period);
      }
    }
  }

  // Only an explicit schema.org TELECOMMUTE declaration counts as remote. The
  // word "remote" appearing in a title or description does not.
  const remote = first(posting.jobLocationType);
  if (typeof remote === 'string' && remote.toUpperCase() === 'TELECOMMUTE') {
    put('remote_type', 'remote');
  }

  put('description_text', text(posting.description));
  const applyUrl = text(posting.url) ?? text((first(posting.potentialAction) as Record<string, unknown>)?.target);
  if (applyUrl && /^https?:\/\//.test(applyUrl)) put('apply_url', applyUrl);
}

/* ----------------------------------------------------------- microdata */

function fromMicrodata(html: string, facts: ExtractedFacts, provenance: Record<string, ExtractionMethod>): void {
  if (!/itemtype\s*=\s*["'][^"']*schema\.org\/JobPosting["']/i.test(html)) return;

  const put = <K extends keyof ExtractedFacts>(field: K, value: ExtractedFacts[K]) => {
    if (value === null || facts[field] !== null) return;
    facts[field] = value;
    provenance[field as string] = 'microdata';
  };

  /** Reads an itemprop's value: `content` attribute, else element text. */
  const prop = (name: string): string | null => {
    const withContent = new RegExp(
      `<[^>]*\\bitemprop\\s*=\\s*["']${name}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*>`, 'i',
    ).exec(html);
    if (withContent) return decodeEntities(withContent[1]) || null;
    const withText = new RegExp(
      `<([a-z0-9]+)[^>]*\\bitemprop\\s*=\\s*["']${name}["'][^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'i',
    ).exec(html);
    if (!withText) return null;
    // Strip nested tags only; the remaining character data is the published
    // text and is decoded but never trimmed.
    const inner = decodeEntities(withText[2].replace(/<[^>]*>/g, ''));
    return inner.length > 0 ? inner : null;
  };

  put('title', prop('title'));
  put('description_text', prop('description'));
  put('identifier', prop('identifier'));
  const posted = prop('datePosted');
  if (posted) {
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(posted);
    if (date) put('date_posted', date[1]);
  }
  const employment = prop('employmentType');
  if (employment) {
    const normalised = employment.toUpperCase().replace(/[\s-]+/g, '_');
    if (EMPLOYMENT_TYPE_VALUES.has(normalised)) put('employment_type', normalised);
  }
  const org = prop('hiringOrganization') ?? prop('name');
  put('company_name', org);
}

/* ---------------------------------------------------------------- meta */

function fromMeta(html: string, facts: ExtractedFacts, provenance: Record<string, ExtractionMethod>): void {
  const put = <K extends keyof ExtractedFacts>(field: K, value: ExtractedFacts[K]) => {
    if (value === null || facts[field] !== null) return;
    facts[field] = value;
    provenance[field as string] = 'meta';
  };

  const meta = (attr: 'property' | 'name', key: string): string | null => {
    const pattern = new RegExp(
      `<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${key}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*>`, 'i',
    );
    const reversed = new RegExp(
      `<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\b${attr}\\s*=\\s*["']${key}["'][^>]*>`, 'i',
    );
    const found = pattern.exec(html) ?? reversed.exec(html);
    if (!found) return null;
    const value = decodeEntities(found[1]);
    return value.length > 0 ? value : null;
  };

  put('title', meta('property', 'og:title') ?? meta('name', 'title'));
  put('description_text', meta('property', 'og:description') ?? meta('name', 'description'));
  put('company_name', meta('property', 'og:site_name'));
}

/* -------------------------------------------------------------- entry */

/**
 * Extracts job facts from a page body.
 *
 * Precedence is JSON-LD, then microdata, then meta: the first source to supply
 * a field wins, and later sources only fill gaps. That ordering is by
 * specificity — JSON-LD JobPosting is an explicit machine-readable statement
 * about this job, whereas og:title is a general page title.
 *
 * Outcomes:
 *   extracted              at least one field was found
 *   extraction_incomplete  nothing usable, with a reason:
 *                            no_structured_data        nothing published
 *                            malformed_structured_data JSON-LD present but unparseable
 */
export function extractJobFacts(body: string | null | undefined): ExtractionResult {
  const facts: ExtractedFacts = { ...EMPTY_FACTS };
  const provenance: Record<string, ExtractionMethod> = {};

  if (typeof body !== 'string' || body.length === 0) {
    return { facts, provenance, status: 'extraction_incomplete', reason: 'no_structured_data' };
  }

  let sawJsonLd = false;
  let allJsonLdMalformed = true;
  for (const block of jsonLdBlocks(body)) {
    sawJsonLd = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      // Malformed JSON-LD is an extraction outcome, never a thrown error.
      continue;
    }
    allJsonLdMalformed = false;
    const posting = findJobPosting(parsed);
    if (posting) fromJsonLd(posting, facts, provenance);
  }

  fromMicrodata(body, facts, provenance);
  fromMeta(body, facts, provenance);

  const found = Object.keys(provenance).length;
  if (found === 0) {
    return {
      facts,
      provenance,
      status: 'extraction_incomplete',
      reason: sawJsonLd && allJsonLdMalformed ? 'malformed_structured_data' : 'no_structured_data',
    };
  }
  return { facts, provenance, status: 'extracted', reason: null };
}
