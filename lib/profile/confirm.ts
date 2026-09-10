import { z } from 'zod';

import {
  PROFILE_DRAFT_FIELDS,
  ProfileDraft,
  validateDraftAgainstFacts,
  type ProfileDraftField,
} from '@/lib/profile/draft';
import { DraftTaskInput } from '@/lib/profile/drafting';

/**
 * Turning a reviewed draft into profile writes — or refusing to.
 *
 * NOTHING A MODEL PRODUCED REACHES A PROFILE THROUGH HERE UNCHECKED.
 *
 * The draft was validated on the worker against the facts it was given. It is
 * validated AGAIN here, against the facts stored with the task, because the
 * two validations answer different questions: the first asks whether the model
 * behaved, the second asks whether what is now in the database is still
 * supported by what the résumé actually said. A row edited in between fails the
 * second.
 *
 * The candidate's edits are validated too. A person may correct a value the
 * model proposed — that is the point of a review screen — but the corrected
 * value still has to fit the column it is going into.
 */

/** What the candidate sends back after reading the draft. */
export const ConfirmRequest = z
  .object({
    draft_id: z.uuid(),
    action: z.enum(['confirm', 'reject']),
    /** Fields the candidate accepted. Absent fields are simply not written. */
    accept: z
      .array(
        z
          .object({
            field: z.enum(PROFILE_DRAFT_FIELDS),
            /**
             * The candidate's own value, when they edited the proposal.
             *
             * Absent means "as proposed". Present means the person typed it,
             * and it is treated as candidate-entered data from then on — not
             * as something a model said.
             */
            edited_value: z.string().max(200).nullable().optional(),
          })
          .strict()
      )
      .max(PROFILE_DRAFT_FIELDS.length),
  })
  .strict()
  .refine((r) => r.action === 'confirm' || r.accept.length === 0, {
    message: 'a rejection accepts nothing',
    path: ['accept'],
  })
  .refine((r) => new Set(r.accept.map((a) => a.field)).size === r.accept.length, {
    message: 'each field may be accepted once',
    path: ['accept'],
  });
export type ConfirmRequest = z.infer<typeof ConfirmRequest>;

export type ConfirmRefusal =
  | 'draft_not_found'
  | 'draft_not_ready'
  | 'profile_changed'
  | 'draft_expired'
  | 'unsupported_claim'
  | 'value_too_long'
  | 'nothing_accepted';

/** The stored row, as the candidate's own session reads it. */
export interface StoredDraft {
  id: string;
  user_id: string;
  status: string;
  profile_version: string;
  expires_at: string;
  input: unknown;
  result: unknown;
}

const FIELD_LIMIT: Record<ProfileDraftField, number> = {
  legal_first_name: 100,
  legal_middle_name: 100,
  legal_last_name: 100,
  preferred_name: 100,
  contact_email: 320,
  phone_e164: 16,
  city: 100,
  state_region: 100,
  country_code: 2,
  linkedin_url: 2048,
  github_url: 2048,
  portfolio_url: 2048,
};

/**
 * Decide what should be written, without writing anything.
 *
 * Pure, so every rule below is testable without a database — and so the route
 * that performs the write has no judgement of its own to get wrong.
 */
export function planConfirmation(
  draft: StoredDraft,
  request: ConfirmRequest,
  currentProfileVersion: string,
  now: Date
):
  | { ok: true; action: 'reject' }
  | { ok: true; action: 'confirm'; writes: Partial<Record<ProfileDraftField, string | null>> }
  | { ok: false; reason: ConfirmRefusal; field?: string } {
  if (draft.status === 'confirmed' || draft.status === 'rejected') {
    /*
     * IDEMPOTENT. A second confirmation of a draft already reviewed is not an
     * error and not a second write — it is the same answer again. A refresh, a
     * double-click and a retried request all land here.
     */
    return draft.status === 'confirmed'
      ? { ok: true, action: 'confirm', writes: {} }
      : { ok: true, action: 'reject' };
  }
  if (draft.status !== 'drafted') return { ok: false, reason: 'draft_not_ready' };
  if (Date.parse(draft.expires_at) <= now.getTime()) {
    return { ok: false, reason: 'draft_expired' };
  }

  if (request.action === 'reject') return { ok: true, action: 'reject' };

  /*
   * OPTIMISTIC CONCURRENCY. The draft was written against the profile as it
   * stood when the task was created. If the candidate has edited their profile
   * since, applying it would overwrite newer work with older proposals.
   */
  if (draft.profile_version !== currentProfileVersion) {
    return { ok: false, reason: 'profile_changed' };
  }

  const parsedInput = DraftTaskInput.safeParse(draft.input);
  const parsedResult = ProfileDraft.safeParse(draft.result);
  if (!parsedInput.success || !parsedResult.success) {
    return { ok: false, reason: 'draft_not_ready' };
  }

  // Re-checked against the facts stored with the task, not against the facts
  // the worker happened to hold.
  const supported = validateDraftAgainstFacts(parsedResult.data, parsedInput.data.facts);
  if (!supported.ok) return { ok: false, reason: 'unsupported_claim', field: supported.field };

  const proposed = new Map(parsedResult.data.fields.map((f) => [f.field, f]));
  const writes: Partial<Record<ProfileDraftField, string | null>> = {};

  for (const accepted of request.accept) {
    const proposal = proposed.get(accepted.field);
    if (proposal === undefined) {
      // Accepting a field the draft never proposed would be the candidate
      // writing through a review screen rather than through the profile form.
      return { ok: false, reason: 'unsupported_claim', field: accepted.field };
    }

    const edited = accepted.edited_value;
    if (edited !== undefined) {
      /*
       * A CANDIDATE'S OWN EDIT NEEDS NO FACT TO SUPPORT IT.
       *
       * They are the source. It still has to fit the column, and it is
       * recorded as their value rather than as a model's proposal.
       */
      if (edited !== null && edited.length > FIELD_LIMIT[accepted.field]) {
        return { ok: false, reason: 'value_too_long', field: accepted.field };
      }
      writes[accepted.field] = edited;
      continue;
    }

    // Unedited: exactly what was proposed, which the fact check just cleared.
    writes[accepted.field] = proposal.value;
  }

  if (Object.keys(writes).length === 0) return { ok: false, reason: 'nothing_accepted' };
  return { ok: true, action: 'confirm', writes };
}
