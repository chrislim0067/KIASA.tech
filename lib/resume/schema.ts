import { z } from 'zod';

// Imported from `lib/profile/schema` directly rather than through the barrel.
// The barrel also re-exports the data layer, and this module is reachable from
// a Client Component — going through it would compile every query function into
// the JavaScript a candidate downloads. `schema` is nothing but constants.
import {
  EXPERIENCE_EMPLOYMENT_TYPES,
  WORK_MODES,
  SKILL_PROFICIENCIES,
  TEXT_LIMITS,
  PATTERNS,
} from '@/lib/profile/schema';

/**
 * The shape a resume is read into.
 *
 * Two rules govern every field here, and they are the reason this file exists
 * rather than a free-form "extract the resume" prompt:
 *
 * 1. NULL MEANS THE RESUME DID NOT SAY. It never means "no", never means
 *    "none", and is never a default. This mirrors the candidate schema, where a
 *    missing row is unknown rather than negative — the distinction the whole
 *    data layer is built around. A model that guesses a country because the
 *    phone number looks American produces a fact the person never stated, and a
 *    review step is not a reliable filter for a plausible-looking guess.
 *
 * 2. EVERY VOCABULARY AND LENGTH IS THE DATABASE'S. Nothing is restated by
 *    hand: the enums and limits come from `lib/profile/schema.ts`, which mirrors
 *    the CHECK constraints. An extraction that validates here is one the profile
 *    tables will accept, so a bad parse fails at the boundary instead of halfway
 *    through writing a person's history.
 *
 * The schema is also the prompt. `.describe()` text is sent to the model as part
 * of the JSON schema, so the instruction for a field sits next to the field
 * rather than in a wall of prose that drifts away from it.
 */

const email = z
  .string()
  .max(TEXT_LIMITS.profiles.contact_email)
  .regex(PATTERNS.email)
  .nullable()
  .describe('Email address exactly as printed. null if the resume shows none.');

const phone = z
  .string()
  .regex(PATTERNS.phoneE164)
  .nullable()
  .describe(
    'Phone in E.164 form: a plus sign, country code, then digits — "+14155550123". ' +
      'Reformat spacing and punctuation, but NEVER invent a country code that is not ' +
      'on the page. If the number has no country code, return null.'
  );

const countryCode = z
  .string()
  .regex(PATTERNS.countryCode)
  .nullable()
  .describe(
    'ISO 3166-1 alpha-2, uppercase, e.g. "GB". Only when the country is stated or ' +
      'written out in full ("London, United Kingdom"). Do NOT infer a country from a ' +
      'city, an area code, or a currency.'
  );

const url = (what: string) =>
  z
    .string()
    .max(2048)
    .regex(PATTERNS.httpUrl)
    .nullable()
    .describe(
      what +
        ' Include the scheme: "https://…". If the resume prints a bare handle or a ' +
        'domain without one, add "https://" but change nothing else. null if absent.'
    );

/**
 * Dates on a resume are rarely full dates.
 *
 * "Jan 2020 – Present" is a month, and "2018" is a year. The database columns are
 * `date`, so something has to supply the missing precision, and the honest place
 * to do it is here, in the open: the model reports the date it read AND how
 * precise the page actually was, so the review screen can say "the resume said
 * 2018 — this will be stored as 1 January 2018" instead of quietly presenting a
 * day nobody wrote down.
 *
 * `precision` never reaches the profile tables. It exists so the person
 * reviewing can see which dates are approximations of their own history.
 */
const isoDate = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
  .nullable()
  .describe(
    'Date as YYYY-MM-DD. When the resume gives only a month and year use the first ' +
      'of that month; when it gives only a year use 1 January. Record what the page ' +
      'actually specified in the matching *_precision field. null if the resume gives ' +
      'no date at all.'
  );

const datePrecision = z
  .enum(['day', 'month', 'year'])
  .nullable()
  .describe(
    'How precise the resume itself was for the matching date: "day" if it printed a ' +
      'day, "month" for a month and year, "year" for a bare year. null when the date ' +
      'is null.'
  );

export const ResumeExperience = z.object({
  company_name: z
    .string()
    .min(1)
    .max(TEXT_LIMITS.work_experiences.company_name)
    .describe('The employer name as printed.'),
  job_title: z
    .string()
    .min(1)
    .max(TEXT_LIMITS.work_experiences.job_title)
    .describe('The role title as printed.'),
  employment_type: z
    .enum(EXPERIENCE_EMPLOYMENT_TYPES)
    .nullable()
    .describe('Only when the resume states it, e.g. "(Contract)" or "Internship". Otherwise null.'),
  work_mode: z
    .enum(WORK_MODES)
    .nullable()
    .describe('Only when the resume says remote, hybrid or on-site. Otherwise null.'),
  location_city: z
    .string()
    .max(TEXT_LIMITS.work_experiences.location_city)
    .nullable()
    .describe('City only — no country, no state. null if not given.'),
  location_country_code: countryCode,
  start_date: isoDate,
  start_date_precision: datePrecision,
  end_date: isoDate.describe(
    'The end date, using the same rules as start_date. null when the role is current ' +
      'or the resume gives no end.'
  ),
  end_date_precision: datePrecision,
  is_current: z
    .boolean()
    .describe('True only when the resume marks this role as ongoing — "Present", "Current".'),
  description: z
    .string()
    .max(TEXT_LIMITS.work_experiences.description)
    .nullable()
    .describe(
      'The bullet points or paragraph for this role, kept as written, one bullet per ' +
        'line. Do not summarise, rewrite or improve it — this is the candidate’s own ' +
        'account of their work. null if the entry has no detail.'
    ),
});

export const ResumeEducation = z.object({
  institution_name: z
    .string()
    .min(1)
    .max(TEXT_LIMITS.education_entries.institution_name)
    .describe('The school, college or university name as printed.'),
  degree: z
    .string()
    .max(TEXT_LIMITS.education_entries.degree)
    .nullable()
    .describe('e.g. "BSc", "MSc", "High School Diploma". null if not stated.'),
  field_of_study: z
    .string()
    .max(TEXT_LIMITS.education_entries.field_of_study)
    .nullable()
    .describe('e.g. "Computer Science". null if not stated.'),
  location_city: z.string().max(TEXT_LIMITS.education_entries.location_city).nullable(),
  location_country_code: countryCode,
  start_date: isoDate,
  start_date_precision: datePrecision,
  end_date: isoDate,
  end_date_precision: datePrecision,
  is_current: z.boolean().describe('True only if the resume marks the study as ongoing.'),
  grade: z
    .string()
    .max(TEXT_LIMITS.education_entries.grade)
    .nullable()
    .describe('The result exactly as printed, e.g. "First Class Honours", "3.8 GPA".'),
});

export const ResumeSkill = z.object({
  name: z
    .string()
    .min(1)
    .max(TEXT_LIMITS.skills.name)
    .describe('One skill, as written. Do not merge two skills into one entry or split one in two.'),
  proficiency: z
    .enum(SKILL_PROFICIENCIES)
    .nullable()
    .describe(
      'Only when the resume states a level in these words or an obvious synonym ' +
        '("Expert", "Proficient" → advanced). Never rank a skill yourself.'
    ),
  years_experience: z
    .number()
    .min(0)
    .max(80)
    .nullable()
    .describe('Only when the resume prints a number of years for this skill. Never compute it.'),
});

export const ResumeExtraction = z.object({
  legal_first_name: z
    .string()
    .max(TEXT_LIMITS.profiles.legal_first_name)
    .nullable()
    .describe('Given name, from the name at the top of the resume.'),
  legal_middle_name: z.string().max(TEXT_LIMITS.profiles.legal_middle_name).nullable(),
  legal_last_name: z
    .string()
    .max(TEXT_LIMITS.profiles.legal_last_name)
    .nullable()
    .describe(
      'Family name. If the resume prints a single name and you cannot tell which part ' +
        'is the family name, put the whole thing in legal_first_name and leave this ' +
        'null rather than splitting it wrongly.'
    ),
  preferred_name: z
    .string()
    .max(TEXT_LIMITS.profiles.preferred_name)
    .nullable()
    .describe('Only if the resume shows one explicitly, e.g. Robert "Bob" Smith.'),

  contact_email: email,
  phone_e164: phone,
  city: z
    .string()
    .max(TEXT_LIMITS.profiles.city)
    .nullable()
    .describe('The candidate’s own city, from the header. City only.'),
  state_region: z.string().max(TEXT_LIMITS.profiles.state_region).nullable(),
  country_code: countryCode,

  linkedin_url: url('The LinkedIn profile URL.'),
  github_url: url('The GitHub profile URL.'),
  portfolio_url: url('A personal site or portfolio URL — not LinkedIn or GitHub.'),

  work_experiences: z
    .array(ResumeExperience)
    .max(40)
    .describe('Every role on the resume, most recent first. [] if there is no work history.'),
  education_entries: z
    .array(ResumeEducation)
    .max(20)
    .describe('Every qualification on the resume, most recent first. [] if none.'),
  skills: z
    .array(ResumeSkill)
    .max(100)
    .describe(
      'Skills the resume lists as skills. Take them from a skills section, or from an ' +
        'explicit technologies line under a role. Do NOT mine prose for anything that ' +
        'sounds like a technology.'
    ),

  /**
   * The model's own account of what it could not read.
   *
   * A photographed resume, a two-column layout that interleaves badly, a section
   * in a script the rest is not — these produce a thin extraction that looks
   * successful. Saying so turns a silent under-read into something the review
   * screen can warn about.
   */
  unreadable_sections: z
    .array(z.string().max(300))
    .max(10)
    .describe(
      'Parts of the document you could not read reliably — a scanned image, a garbled ' +
        'column, an unsupported script. One short phrase each. [] if the whole document ' +
        'read cleanly.'
    ),
});

export type ResumeExtraction = z.infer<typeof ResumeExtraction>;
export type ResumeExperienceDraft = z.infer<typeof ResumeExperience>;
export type ResumeEducationDraft = z.infer<typeof ResumeEducation>;
export type ResumeSkillDraft = z.infer<typeof ResumeSkill>;

/**
 * Re-validate an extraction that has been round-tripped through the database.
 *
 * `resume_imports.extracted` is jsonb the owner may edit during review, so what
 * comes back out is untrusted input even though we are the ones who put it
 * there. Everything downstream — the review screen and the confirm action —
 * reads it through this rather than casting.
 */
export function parseExtraction(value: unknown): ResumeExtraction | null {
  const result = ResumeExtraction.safeParse(value);
  return result.success ? result.data : null;
}

/** Whether an extraction found anything at all worth reviewing. */
export function isEmptyExtraction(e: ResumeExtraction): boolean {
  return (
    e.work_experiences.length === 0 &&
    e.education_entries.length === 0 &&
    e.skills.length === 0 &&
    !e.legal_first_name &&
    !e.legal_last_name &&
    !e.contact_email &&
    !e.phone_e164
  );
}
