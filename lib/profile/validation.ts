/**
 * Advisory, client-safe mirror of the database constraints.
 *
 * Purpose: fast feedback and a cheaper round trip. NOT a security boundary and
 * NOT the authority. Anything that slips past these checks is still rejected by
 * the database and surfaces as `constraint_violation`, so a gap here is a
 * usability bug, never a correctness or safety one.
 *
 * These functions inspect. They never trim, case-fold, collapse whitespace or
 * otherwise "clean" candidate input — the database stores values byte-for-byte
 * and the application layer must behave identically, or the two would disagree
 * about what was actually saved.
 */
import { isBlankOrInvisible } from './invisible';
import {
  ARRAY_LIMITS, OTHER_LINKS_LIMITS, PATTERNS, SENSITIVITIES, TEXT_LIMITS,
} from './schema';
import type { OtherLink } from './types';

export interface ValidationIssue {
  readonly field: string;
  readonly code:
    | 'blank_or_invisible'
    | 'too_long'
    | 'too_many_items'
    | 'not_allowed_value'
    | 'bad_format'
    | 'not_an_array'
    | 'out_of_range';
  readonly message: string;
}

/** Uses code points, matching PostgreSQL's `length()` on a UTF-8 text column. */
const codePointLength = (value: string): number => [...value].length;

/**
 * Validates one text-array column against its `text_array_ok(col, n, len)`
 * bounds plus the shared invisible-value rule.
 */
export function validateTextArray(
  field: string,
  value: readonly string[] | null | undefined,
  limits: { maxItems: number; maxLen: number },
): ValidationIssue[] {
  if (value === null || value === undefined) return [];
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(value)) {
    return [{ field, code: 'not_an_array', message: `${field} must be an array.` }];
  }
  if (value.length > limits.maxItems) {
    issues.push({
      field,
      code: 'too_many_items',
      message: `${field} accepts at most ${limits.maxItems} entries (received ${value.length}).`,
    });
  }
  value.forEach((element, index) => {
    const at = `${field}[${index}]`;
    if (isBlankOrInvisible(element)) {
      issues.push({
        field: at,
        code: 'blank_or_invisible',
        message: `${at} must contain at least one visible character.`,
      });
      return;
    }
    if (codePointLength(element) > limits.maxLen) {
      issues.push({
        field: at,
        code: 'too_long',
        message: `${at} may be at most ${limits.maxLen} characters.`,
      });
    }
  });
  return issues;
}

/** Validates `profiles.other_links` against `jsonb_links_ok(other_links, 20, 2048, 200)`. */
export function validateOtherLinks(value: unknown): ValidationIssue[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    return [{ field: 'other_links', code: 'not_an_array', message: 'other_links must be an array.' }];
  }
  const issues: ValidationIssue[] = [];
  if (value.length > OTHER_LINKS_LIMITS.maxItems) {
    issues.push({
      field: 'other_links',
      code: 'too_many_items',
      message: `other_links accepts at most ${OTHER_LINKS_LIMITS.maxItems} entries.`,
    });
  }
  value.forEach((entry, index) => {
    const at = `other_links[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push({ field: at, code: 'bad_format', message: `${at} must be an object.` });
      return;
    }
    const { label, url } = entry as Partial<OtherLink>;
    // A missing label key is blank by the helper's definition, matching
    // `element ->> 'label'` returning NULL.
    if (isBlankOrInvisible(typeof label === 'string' ? label : null)) {
      issues.push({
        field: `${at}.label`,
        code: 'blank_or_invisible',
        message: `${at}.label must contain at least one visible character.`,
      });
    } else if (codePointLength(label as string) > OTHER_LINKS_LIMITS.maxLabelLen) {
      issues.push({
        field: `${at}.label`,
        code: 'too_long',
        message: `${at}.label may be at most ${OTHER_LINKS_LIMITS.maxLabelLen} characters.`,
      });
    }
    if (typeof url !== 'string' || !PATTERNS.httpUrl.test(url)) {
      issues.push({
        field: `${at}.url`,
        code: 'bad_format',
        message: `${at}.url must begin with http:// or https://.`,
      });
    } else if (codePointLength(url) > OTHER_LINKS_LIMITS.maxUrlLen) {
      issues.push({
        field: `${at}.url`,
        code: 'too_long',
        message: `${at}.url may be at most ${OTHER_LINKS_LIMITS.maxUrlLen} characters.`,
      });
    }
  });
  return issues;
}

/** Checks a nullable text column's length. Blank-but-visible text is allowed. */
export function validateTextLength(field: string, value: unknown, maxLen: number): ValidationIssue[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'string') {
    return [{ field, code: 'bad_format', message: `${field} must be text.` }];
  }
  return codePointLength(value) > maxLen
    ? [{ field, code: 'too_long', message: `${field} may be at most ${maxLen} characters.` }]
    : [];
}

export function validatePattern(field: string, value: unknown, pattern: RegExp): ValidationIssue[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'string' || !pattern.test(value)) {
    return [{ field, code: 'bad_format', message: `${field} is not in the expected format.` }];
  }
  return [];
}

export function validateEnum(field: string, value: unknown, allowed: readonly string[]): ValidationIssue[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return [{
      field,
      code: 'not_allowed_value',
      message: `${field} must be one of: ${allowed.join(', ')}.`,
    }];
  }
  return [];
}

export function validateEnumArray(field: string, value: unknown, allowed: readonly string[]): ValidationIssue[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    return [{ field, code: 'not_an_array', message: `${field} must be an array.` }];
  }
  return value.flatMap((element, index) => validateEnum(`${field}[${index}]`, element, allowed));
}

export function validateRange(
  field: string, value: unknown, bounds: { min: number; max: number },
): ValidationIssue[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    return [{
      field,
      code: 'out_of_range',
      message: `${field} must be between ${bounds.min} and ${bounds.max}.`,
    }];
  }
  return [];
}

type Record_ = Record<string, unknown>;

/** Applies every `TEXT_LIMITS` entry defined for a table to the supplied keys. */
function textLengthIssues(table: keyof typeof TEXT_LIMITS, input: Record_): ValidationIssue[] {
  const limits = TEXT_LIMITS[table] as Record<string, number>;
  return Object.entries(limits).flatMap(([column, maxLen]) =>
    column in input ? validateTextLength(column, input[column], maxLen) : []);
}

/** Applies every `ARRAY_LIMITS` entry defined for a table to the supplied keys. */
function arrayIssues(table: keyof typeof ARRAY_LIMITS, input: Record_): ValidationIssue[] {
  const limits = ARRAY_LIMITS[table] as Record<string, { maxItems: number; maxLen: number }>;
  return Object.entries(limits).flatMap(([column, bounds]) =>
    column in input
      ? validateTextArray(column, input[column] as string[] | null | undefined, bounds)
      : []);
}

/**
 * Validates a partial write for one table. Only keys actually present are
 * checked, so this works for both creates and partial updates.
 *
 * Deliberately incomplete by design: it covers the mechanical constraints
 * (length, cardinality, blankness, vocabulary, format, range). Cross-column
 * rules such as `end_date >= start_date` are left to the database, which is the
 * authority and evaluates them atomically with the write.
 */
export function validateWrite(table: string, input: Record_): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (table in TEXT_LIMITS) issues.push(...textLengthIssues(table as keyof typeof TEXT_LIMITS, input));
  if (table in ARRAY_LIMITS) issues.push(...arrayIssues(table as keyof typeof ARRAY_LIMITS, input));

  const has = (key: string) => key in input;
  const value = (key: string) => input[key];

  switch (table) {
    case 'profiles':
      if (has('contact_email')) issues.push(...validatePattern('contact_email', value('contact_email'), PATTERNS.email));
      if (has('phone_e164')) issues.push(...validatePattern('phone_e164', value('phone_e164'), PATTERNS.phoneE164));
      if (has('country_code')) issues.push(...validatePattern('country_code', value('country_code'), PATTERNS.countryCode));
      if (has('timezone')) issues.push(...validatePattern('timezone', value('timezone'), PATTERNS.timezone));
      for (const url of ['linkedin_url', 'github_url', 'portfolio_url', 'website_url']) {
        if (has(url)) issues.push(...validatePattern(url, value(url), PATTERNS.httpUrl));
      }
      if (has('other_links')) issues.push(...validateOtherLinks(value('other_links')));
      break;

    case 'job_preferences':
      if (has('work_modes')) issues.push(...validateEnumArray('work_modes', value('work_modes'), ['remote', 'hybrid', 'onsite']));
      if (has('employment_types')) {
        issues.push(...validateEnumArray('employment_types', value('employment_types'),
          ['full_time', 'part_time', 'contract', 'internship', 'temporary']));
      }
      if (has('salary_period')) issues.push(...validateEnum('salary_period', value('salary_period'), ['hourly', 'daily', 'monthly', 'annual']));
      if (has('salary_currency')) issues.push(...validatePattern('salary_currency', value('salary_currency'), PATTERNS.currency));
      if (has('travel_willingness')) {
        issues.push(...validateEnum('travel_willingness', value('travel_willingness'), ['none', 'occasional', 'frequent', 'extensive']));
      }
      if (has('desired_experience_level')) {
        issues.push(...validateEnum('desired_experience_level', value('desired_experience_level'),
          ['internship', 'entry', 'associate', 'mid', 'senior', 'lead', 'principal', 'executive']));
      }
      break;

    case 'automation_settings':
      if (has('always_require_approval_categories')) {
        issues.push(...validateEnumArray('always_require_approval_categories',
          value('always_require_approval_categories'), SENSITIVITIES));
      }
      if (has('absolute_salary_period')) {
        issues.push(...validateEnum('absolute_salary_period', value('absolute_salary_period'), ['hourly', 'daily', 'monthly', 'annual']));
      }
      if (has('absolute_salary_currency')) {
        issues.push(...validatePattern('absolute_salary_currency', value('absolute_salary_currency'), PATTERNS.currency));
      }
      if (has('min_match_score')) issues.push(...validateRange('min_match_score', value('min_match_score'), { min: 0, max: 100 }));
      if (has('max_applications_per_day')) {
        issues.push(...validateRange('max_applications_per_day', value('max_applications_per_day'), { min: 0, max: 1000 }));
      }
      if (has('allowed_country_codes')) {
        const codes = value('allowed_country_codes');
        if (Array.isArray(codes)) {
          issues.push(...codes.flatMap((c, i) => validatePattern(`allowed_country_codes[${i}]`, c, PATTERNS.countryCode)));
        }
      }
      break;

    case 'work_authorizations':
      if (has('country_code')) issues.push(...validatePattern('country_code', value('country_code'), PATTERNS.countryCode));
      break;

    case 'work_experiences':
      if (has('employment_type')) {
        issues.push(...validateEnum('employment_type', value('employment_type'),
          ['full_time', 'part_time', 'contract', 'internship', 'temporary', 'freelance']));
      }
      if (has('work_mode')) issues.push(...validateEnum('work_mode', value('work_mode'), ['remote', 'hybrid', 'onsite']));
      if (has('location_country_code')) {
        issues.push(...validatePattern('location_country_code', value('location_country_code'), PATTERNS.countryCode));
      }
      break;

    case 'education_entries':
      if (has('location_country_code')) {
        issues.push(...validatePattern('location_country_code', value('location_country_code'), PATTERNS.countryCode));
      }
      break;

    case 'skills':
      if (has('proficiency')) {
        issues.push(...validateEnum('proficiency', value('proficiency'), ['beginner', 'intermediate', 'advanced', 'expert']));
      }
      break;

    case 'certifications':
      if (has('credential_url')) issues.push(...validatePattern('credential_url', value('credential_url'), PATTERNS.httpUrl));
      break;

    case 'projects':
      if (has('url')) issues.push(...validatePattern('url', value('url'), PATTERNS.httpUrl));
      if (has('repository_url')) issues.push(...validatePattern('repository_url', value('repository_url'), PATTERNS.httpUrl));
      break;

    case 'languages':
      if (has('language_code')) issues.push(...validatePattern('language_code', value('language_code'), PATTERNS.languageCode));
      if (has('proficiency')) {
        issues.push(...validateEnum('proficiency', value('proficiency'),
          ['elementary', 'limited_working', 'professional_working', 'full_professional', 'native_bilingual']));
      }
      break;

    case 'verified_answers':
      if (has('question_key')) issues.push(...validatePattern('question_key', value('question_key'), PATTERNS.questionKey));
      if (has('sensitivity')) issues.push(...validateEnum('sensitivity', value('sensitivity'), SENSITIVITIES));
      if (has('answer_type')) {
        issues.push(...validateEnum('answer_type', value('answer_type'),
          ['text', 'boolean', 'number', 'date', 'single_choice', 'multi_choice']));
      }
      break;

    default:
      break;
  }

  return issues;
}
