/**
 * Types derived from the generated `Database` type.
 *
 * Nothing here restates a column by hand: every row, insert and update type is
 * projected from `lib/supabase/database.types.ts`, so regenerating types after
 * a schema change surfaces as a compile error rather than as silent drift.
 *
 * The input types omit the columns the database owns, which makes writing them
 * a type error rather than a runtime rejection.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';

export type ProfileClient = SupabaseClient<Database>;

type Public = Database['public'];
export type TableName = keyof Public['Tables'];

export type Row<T extends TableName> = Public['Tables'][T]['Row'];
type InsertOf<T extends TableName> = Public['Tables'][T]['Insert'];

/**
 * Columns no caller may supply.
 *
 * `user_id` comes from the authenticated identity inside the layer, so row
 * donation is impossible by construction rather than by review. The timestamps
 * are stamped by the migration-9 trigger, `requires_human_approval` is a
 * generated column (writing it raises 428C9), and `verified_at` is derived from
 * `is_verified` by the provenance guard.
 */
type ManagedColumn = 'user_id' | 'created_at' | 'updated_at' | 'requires_human_approval' | 'verified_at';

/** Payload for creating a row: managed columns and the surrogate key removed. */
export type CreateInput<T extends TableName> = Omit<InsertOf<T>, ManagedColumn | 'id'>;

/**
 * Payload for updating a row. Every remaining column is optional, and `id` is
 * excluded so a caller cannot repoint a row at a different primary key.
 */
export type UpdateInput<T extends TableName> = Partial<Omit<InsertOf<T>, ManagedColumn | 'id'>>;

export type ProfileRow = Row<'profiles'>;
export type JobPreferencesRow = Row<'job_preferences'>;
export type AutomationSettingsRow = Row<'automation_settings'>;
export type WorkAuthorizationRow = Row<'work_authorizations'>;
export type WorkExperienceRow = Row<'work_experiences'>;
export type EducationEntryRow = Row<'education_entries'>;
export type SkillRow = Row<'skills'>;
export type CertificationRow = Row<'certifications'>;
export type ProjectRow = Row<'projects'>;
export type LanguageRow = Row<'languages'>;
export type VerifiedAnswerRow = Row<'verified_answers'>;

/**
 * The complete candidate model as one serialisable object.
 *
 * Singleton tables are `T | null`, where **null means UNKNOWN** — the row has
 * never been written. It never means "the user answered no" and it is never a
 * fabricated default. Collections are arrays; `[]` means "nothing recorded",
 * which is likewise UNKNOWN rather than "none apply".
 *
 * `profiles` is non-null because `ensureProfile` creates it, but every field
 * inside it is nullable and starts null.
 */
export interface CandidateSnapshot {
  readonly userId: string;
  /** ISO-8601 UTC instant at which this snapshot was assembled. */
  readonly capturedAt: string;
  readonly profile: ProfileRow | null;
  readonly jobPreferences: JobPreferencesRow | null;
  readonly automationSettings: AutomationSettingsRow | null;
  readonly workAuthorizations: readonly WorkAuthorizationRow[];
  readonly workExperiences: readonly WorkExperienceRow[];
  readonly educationEntries: readonly EducationEntryRow[];
  readonly skills: readonly SkillRow[];
  readonly certifications: readonly CertificationRow[];
  readonly projects: readonly ProjectRow[];
  readonly languages: readonly LanguageRow[];
  readonly verifiedAnswers: readonly VerifiedAnswerRow[];
}

/** One `{ label, url }` entry in `profiles.other_links`. */
export interface OtherLink {
  label: string;
  url: string;
}
