import { z } from 'zod';

import { TEXT_LIMITS } from '@/lib/profile/schema';
import type { ResumeExtraction } from '@/lib/resume/schema';

/**
 * The candidate-profile draft contract.
 *
 * WHAT A MODEL MAY PROPOSE, AND — MORE IMPORTANTLY — WHAT IT CANNOT
 *
 * This schema has no field for an employer, a role, a date, a degree, a
 * certification, a skill, a salary, a work authorization, or a legal answer.
 * Not "those are validated"; there is nowhere to put them. A model working
 * against this contract cannot invent a job it has no evidence for, because
 * the shape it must produce has no slot for one.
 *
 * Work history, education and skills keep coming from the existing résumé
 * import path, which adds entries with dedupe under the candidate's own
 * session (`lib/resume/apply.ts`). This slice drafts the twelve scalar profile
 * fields and nothing else.
 *
 * NOR CAN IT CLAIM ANYTHING IS TRUE
 *
 * There is no `verified`, no `source`, no `confirmed_at`, no `user_id`, no
 * timestamp and no provenance field. Those belong to the database and to the
 * candidate. The migration-9 triggers remain their only author.
 *
 * NOR CAN IT SMUGGLE TEXT
 *
 * Evidence is a FACT PATH — `contact_email`, `work_experiences[0].employer` —
 * not a quotation. The regex below admits nothing else, so no résumé prose can
 * ride into the draft, into an event, or onto a review screen through a field
 * meant to justify a value.
 */

/** The twelve scalar profile fields a draft may propose. */
export const PROFILE_DRAFT_FIELDS = [
  'legal_first_name',
  'legal_middle_name',
  'legal_last_name',
  'preferred_name',
  'contact_email',
  'phone_e164',
  'city',
  'state_region',
  'country_code',
  'linkedin_url',
  'github_url',
  'portfolio_url',
] as const;
export type ProfileDraftField = (typeof PROFILE_DRAFT_FIELDS)[number];

/**
 * Fields that always need the candidate to say yes, one at a time.
 *
 * A legal name, an email address, a phone number and a country are identity.
 * Getting one wrong is not a typo a person shrugs at — it is an application
 * submitted under the wrong name, or a reply that never arrives. These are
 * excluded from any "accept the safe ones" action.
 */
export const EXPLICIT_CONFIRMATION_FIELDS: readonly ProfileDraftField[] = [
  'legal_first_name',
  'legal_middle_name',
  'legal_last_name',
  'contact_email',
  'phone_e164',
  'country_code',
];

/**
 * A reference INTO the supplied facts. A path, never a quotation.
 *
 * `contact_email`, `city`, `work_experiences[3].employer`. Two digits of index
 * at most, one level of nesting, lower-case identifiers only.
 */
const FACT_PATH = /^[a-z_]{2,40}(\[\d{1,2}\])?(\.[a-z_]{2,40})?$/;

export const FactReference = z.string().max(60).regex(FACT_PATH);

export const FieldProposal = z
  .object({
    field: z.enum(PROFILE_DRAFT_FIELDS),
    /**
     * The proposed value, or null for "the résumé does not say".
     *
     * Null is a real answer here, not an absence. A model that cannot find a
     * middle name should say so rather than guess one, and the review screen
     * shows the difference.
     */
    value: z.string().max(200).nullable(),
    /** Where in the supplied facts the value came from. Empty only when null. */
    source_facts: z.array(FactReference).max(4),
    /** Set for identity and legal fields; the UI must not bulk-accept these. */
    requires_confirmation: z.boolean(),
    /** Short, bounded, and about the DRAFT — never a quotation of the résumé. */
    warnings: z.array(z.string().max(160)).max(3),
  })
  .strict()
  .refine((p) => p.value === null || p.source_facts.length > 0, {
    message: 'a proposed value must cite the fact it came from',
    path: ['source_facts'],
  })
  .refine((p) => p.value !== null || p.source_facts.length === 0, {
    message: 'an unknown value cites nothing',
    path: ['source_facts'],
  });
export type FieldProposal = z.infer<typeof FieldProposal>;

export const PROFILE_DRAFT_SCHEMA_VERSION = 1;

export const ProfileDraft = z
  .object({
    schema_version: z.literal(PROFILE_DRAFT_SCHEMA_VERSION),
    fields: z.array(FieldProposal).max(PROFILE_DRAFT_FIELDS.length),
    /** Draft-level notes, bounded. Not a place for résumé content. */
    warnings: z.array(z.string().max(160)).max(5),
  })
  .strict()
  .refine((d) => new Set(d.fields.map((f) => f.field)).size === d.fields.length, {
    message: 'each field may be proposed at most once',
    path: ['fields'],
  });
export type ProfileDraft = z.infer<typeof ProfileDraft>;

/** The per-field length ceiling the profile tables actually enforce. */
const FIELD_LIMIT: Record<ProfileDraftField, number> = {
  legal_first_name: TEXT_LIMITS.profiles.legal_first_name,
  legal_middle_name: TEXT_LIMITS.profiles.legal_middle_name,
  legal_last_name: TEXT_LIMITS.profiles.legal_last_name,
  preferred_name: TEXT_LIMITS.profiles.preferred_name,
  contact_email: TEXT_LIMITS.profiles.contact_email,
  // E.164 is at most fifteen digits and a plus. Not in TEXT_LIMITS because
  // the column is constrained by shape rather than by length.
  phone_e164: 16,
  city: TEXT_LIMITS.profiles.city,
  state_region: TEXT_LIMITS.profiles.state_region,
  country_code: 2,
  linkedin_url: TEXT_LIMITS.profiles.linkedin_url,
  github_url: TEXT_LIMITS.profiles.github_url,
  portfolio_url: TEXT_LIMITS.profiles.portfolio_url,
};

/** Case- and whitespace-insensitive, for comparing what a person wrote. */
const norm = (v: unknown) =>
  typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : null;

/** Read a fact path out of the supplied facts. Returns null for anything absent. */
function readFact(facts: ResumeExtraction, path: string): unknown {
  const match = path.match(/^([a-z_]+)(?:\[(\d{1,2})\])?(?:\.([a-z_]+))?$/);
  if (!match) return null;
  const [, root, index, leaf] = match;
  const base = (facts as unknown as Record<string, unknown>)[root];
  if (base === undefined) return null;
  if (index === undefined) return leaf === undefined ? base : null;
  if (!Array.isArray(base)) return null;
  const entry = base[Number(index)];
  if (entry === undefined || entry === null) return null;
  if (leaf === undefined) return entry;
  return (entry as Record<string, unknown>)[leaf] ?? null;
}

export type DraftRejection =
  | 'schema_invalid'
  | 'unsupported_claim'
  | 'value_too_long'
  | 'unknown_field'
  | 'confirmation_flag_wrong';

/**
 * The anti-invention check, and the reason this milestone can let a model near
 * a profile at all.
 *
 * Every proposed value must MATCH a value already present in the facts at the
 * path it cites. Not "be plausible given" — match. A model that returns a
 * confident, well-formed, entirely fabricated employer city is rejected here,
 * because `city` does not appear in the facts with that value.
 *
 * Comparison is case- and whitespace-insensitive, because a model that
 * title-cases a city has not invented anything.
 */
export function validateDraftAgainstFacts(
  draft: ProfileDraft,
  facts: ResumeExtraction
): { ok: true } | { ok: false; reason: DraftRejection; field?: string } {
  for (const proposal of draft.fields) {
    const limit = FIELD_LIMIT[proposal.field];
    if (limit === undefined) return { ok: false, reason: 'unknown_field', field: proposal.field };

    // The flag is not the model's to decide: it is a property of the field.
    const shouldConfirm = EXPLICIT_CONFIRMATION_FIELDS.includes(proposal.field);
    if (proposal.requires_confirmation !== shouldConfirm) {
      return { ok: false, reason: 'confirmation_flag_wrong', field: proposal.field };
    }

    if (proposal.value === null) continue;
    if (proposal.value.length > limit) {
      return { ok: false, reason: 'value_too_long', field: proposal.field };
    }

    const wanted = norm(proposal.value);
    const supported = proposal.source_facts.some((path) => {
      const actual = readFact(facts, path);
      return actual !== null && norm(actual) === wanted;
    });
    if (!supported) {
      return { ok: false, reason: 'unsupported_claim', field: proposal.field };
    }
  }
  return { ok: true };
}

/**
 * Parse and check in one step. Anything that is not a valid, fact-supported
 * draft comes back as a reason code — never as a partial draft.
 */
export function parseProfileDraft(
  value: unknown,
  facts: ResumeExtraction
): { ok: true; draft: ProfileDraft } | { ok: false; reason: DraftRejection; field?: string } {
  const parsed = ProfileDraft.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'schema_invalid' };
  const supported = validateDraftAgainstFacts(parsed.data, facts);
  if (!supported.ok) return supported;
  return { ok: true, draft: parsed.data };
}
