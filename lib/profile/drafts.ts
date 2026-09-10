import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/supabase/database.types';
import { ProfileDraft, PROFILE_DRAFT_FIELDS, type ProfileDraftField } from '@/lib/profile/draft';
import { DraftTaskInput } from '@/lib/profile/drafting';

/**
 * Reading `profile_drafts` for the candidate who owns them.
 *
 * ONE CLIENT ONLY, AND IT IS THE CANDIDATE'S. Unlike `lib/resume/imports.ts`,
 * nothing in this file needs an elevated client: a candidate creates their own
 * draft row and reads their own draft rows, both of which their RLS policies
 * already permit. The row is WRITTEN by the worker boundary — `result` is not
 * a column a browser holds UPDATE on — so there is no elevated write to make
 * here either.
 *
 * NOTHING THIS FILE RETURNS HAS TOUCHED A PROFILE. A draft is a proposal
 * sitting in its own table, and no profile query reads that table. The only
 * path across is `POST /api/profile/draft/confirm`, after a person has looked
 * at it.
 */

type DraftTable = Database['public']['Tables']['profile_drafts'];

/**
 * The status vocabulary, narrowed past what the generator can express.
 *
 * `profile_drafts_status_allowed` is a CHECK constraint, which the type
 * generator emits as `string`. The narrowing is real and enforced by the
 * database; it is repeated here so a `switch` over it can be exhaustive.
 */
export const PROFILE_DRAFT_STATUSES = [
  'pending',
  'drafted',
  'confirmed',
  'rejected',
  'expired',
] as const;
export type ProfileDraftStatus = (typeof PROFILE_DRAFT_STATUSES)[number];

export interface ProfileDraftRow extends Omit<DraftTable['Row'], 'status'> {
  status: ProfileDraftStatus;
}

/** A draft, its task's progress, and the profile it was drawn against. */
export interface DraftView {
  id: string;
  status: ProfileDraftStatus;
  created_at: string;
  expires_at: string;
  profile_version: string;
  /** The task's own status, which is how "still waiting" is told from "failed". */
  task_status: string | null;
  /** Present only once the worker has submitted something that parsed. */
  draft: ProfileDraft | null;
  /** The profile as it stood when the task was made — for "was → proposed". */
  current: Partial<Record<ProfileDraftField, string | null>>;
}

const isStatus = (value: string): value is ProfileDraftStatus =>
  (PROFILE_DRAFT_STATUSES as readonly string[]).includes(value);

/**
 * The most recent draft that has not been reviewed, if there is one.
 *
 * `confirmed` and `rejected` rows are deliberately excluded: they are history,
 * and showing a confirmed draft as though it were still a decision invites
 * someone to make it twice.
 */
export async function getActiveDraft(
  supabase: SupabaseClient<Database>
): Promise<DraftView | null> {
  const { data } = await supabase
    .from('profile_drafts')
    .select('id, status, created_at, expires_at, profile_version, task_id, input, result')
    .in('status', ['pending', 'drafted'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data || !isStatus(data.status)) return null;

  const { data: task } = await supabase
    .from('automation_tasks')
    .select('status')
    .eq('id', data.task_id)
    .maybeSingle();

  /*
   * A ROW THAT DOES NOT PARSE IS SHOWN AS "NOT READY", NEVER AS ITSELF.
   *
   * `result` is bounded and constrained in the database, but this is the last
   * point before it reaches a screen, and the schema is what decides that the
   * thing on the screen is a draft. Anything else — a shape from an older
   * schema version, a row edited by hand — becomes `null` and the page says it
   * is not ready. It does not render whatever happened to be in the column.
   */
  const parsed = data.result === null ? null : ProfileDraft.safeParse(data.result);
  const input = DraftTaskInput.safeParse(data.input);

  return {
    id: data.id,
    status: data.status,
    created_at: data.created_at,
    expires_at: data.expires_at,
    profile_version: data.profile_version,
    task_status: task?.status ?? null,
    draft: parsed?.success ? parsed.data : null,
    current: input.success ? input.data.current : {},
  };
}

/** The candidate's own profile scalars, for the "before" column. */
export async function readProfileScalars(
  supabase: SupabaseClient<Database>
): Promise<{ updated_at: string; values: Partial<Record<ProfileDraftField, string | null>> } | null> {
  const { data } = await supabase
    .from('profiles')
    // One literal, not a concatenation: the client infers the row type from
    // this string, and it cannot infer anything from an expression.
    .select(
      'updated_at, legal_first_name, legal_middle_name, legal_last_name, preferred_name, contact_email, phone_e164, city, state_region, country_code, linkedin_url, github_url, portfolio_url'
    )
    .maybeSingle();

  if (!data?.updated_at) return null;

  const values = Object.fromEntries(
    PROFILE_DRAFT_FIELDS.map((field) => [
      field,
      ((data as Record<string, unknown>)[field] as string | null) ?? null,
    ])
  ) as Partial<Record<ProfileDraftField, string | null>>;

  return { updated_at: data.updated_at, values };
}

/** Whether the candidate has résumé facts a draft could be made from. */
export async function hasResumeFacts(supabase: SupabaseClient<Database>): Promise<boolean> {
  const { data } = await supabase
    .from('resume_imports')
    .select('id')
    .in('status', ['parsed', 'confirmed'])
    .not('extracted', 'is', null)
    .limit(1)
    .maybeSingle();
  return Boolean(data);
}
