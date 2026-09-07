import 'server-only';

/**
 * Candidate-profile data-access layer.
 *
 * Every function takes an already-authenticated Supabase client plus the
 * `userId` that `supabase.auth.getUser()` returned, and returns a `Result`.
 * Nothing here creates a client, reads cookies or touches the environment, so
 * a UI route handler and an autonomous agent runtime call exactly the same
 * functions with the same guarantees.
 *
 * Security posture:
 *   - RLS is the boundary. The layer never uses a service-role key and cannot
 *     bypass a policy; `userId` scoping is defence in depth so the layer is not
 *     trivially misusable, not a substitute for the policy.
 *   - `user_id` is always taken from the authenticated identity and never from
 *     caller input, so row donation is impossible by construction.
 *   - Candidate text is passed through untouched. No trimming, no case folding,
 *     no whitespace collapsing, no inferred defaults.
 *
 * A note on UPDATE semantics that shaped this file: an UPDATE filtered out by
 * RLS is a SILENT NO-OP — PostgREST returns success with zero rows, not an
 * error (measured, not assumed). Every mutation therefore requests the affected
 * rows back and treats "zero rows" as `not_found`, so writing to another user's
 * row can never be reported as success.
 */
import { fail, mapPostgrestError, ok, type PostgrestLikeError, type Result } from './errors';
import { validateWrite, type ValidationIssue } from './validation';
import { CLIENT_WRITABLE_SOURCE, COLLECTION_ORDER } from './schema';
import type {
  AutomationSettingsRow, CandidateSnapshot, CertificationRow, CreateInput, EducationEntryRow,
  JobPreferencesRow, LanguageRow, ProfileClient, ProfileRow, ProjectRow, Row, SkillRow,
  TableName, UpdateInput, VerifiedAnswerRow, WorkAuthorizationRow, WorkExperienceRow,
} from './types';

/* ------------------------------------------------- generic table access */

/**
 * A minimal structural view of the query builder.
 *
 * supabase-js resolves a table name through a deeply conditional type. That
 * works well for a literal name but collapses when the name is a type parameter
 * (`T extends TableName`), because the conditional cannot be evaluated until
 * `T` is instantiated — so `.eq('user_id', …)` fails to typecheck inside a
 * generic helper even though every concrete instantiation is valid.
 *
 * Rather than weaken the public API, the generic helpers below address the
 * client through this view and each restores the concrete row type in its own
 * signature. Payloads are `unknown`, not `any`, so every result still has to be
 * narrowed deliberately at exactly one place per helper — the cast is visible
 * rather than silently inferred, and callers of the exported functions see
 * fully concrete types throughout.
 */
interface QueryResult {
  data: unknown;
  error: PostgrestLikeError | null;
}

interface LooseQuery extends PromiseLike<QueryResult> {
  select(columns?: string): LooseQuery;
  insert(values: unknown): LooseQuery;
  update(values: unknown): LooseQuery;
  upsert(values: unknown, options?: { onConflict?: string }): LooseQuery;
  delete(): LooseQuery;
  eq(column: string, value: unknown): LooseQuery;
  order(column: string, options: { ascending: boolean; nullsFirst: boolean }): LooseQuery;
  single(): PromiseLike<QueryResult>;
  maybeSingle(): PromiseLike<QueryResult>;
}

interface LooseClient {
  from(table: string): LooseQuery;
}

const loose = (client: ProfileClient): LooseClient => client as unknown as LooseClient;

/* ------------------------------------------------------------------ guards */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fails closed on a missing or malformed identity. RLS would refuse anyway;
 * this turns a confusing database error into an explicit `unauthenticated`
 * result and stops a caller from accidentally passing an empty string.
 */
function requireUserId(userId: string | null | undefined): Result<string> {
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    return fail('unauthenticated', 'missing_user_id',
      'No authenticated user. Establish identity with getUser() before calling the profile layer.');
  }
  return ok(userId);
}

function invalid(issues: ValidationIssue[]): Result<never> {
  const first = issues[0];
  return fail('invalid_input', 'validation_failed', first.message, {
    field: first.field,
    detail: issues.map((i) => `${i.field}: ${i.code}`).join('; '),
  });
}

/**
 * Strips keys whose value is `undefined` so a partial update does not blank a
 * column the caller never mentioned. An explicit `null` is preserved: that is a
 * deliberate "clear this field", which is different from omitting it.
 */
function definedOnly<T extends object>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

function applyOrder(query: LooseQuery, table: keyof typeof COLLECTION_ORDER): LooseQuery {
  let out = query;
  for (const column of COLLECTION_ORDER[table]) {
    out = out.order(column, { ascending: true, nullsFirst: false });
  }
  return out;
}

/* --------------------------------------------------------------- bootstrap */

/**
 * Creates the caller's `profiles` row if it does not exist. Idempotent, and
 * safe to call on every authenticated request and concurrently.
 *
 * Lazy by design: there is deliberately no trigger on `auth.users`, so the row
 * appears at first authenticated use. Only `user_id` is supplied — every other
 * column keeps its schema default, and nothing about the person is invented.
 *
 * Concurrency: two parallel first-calls both attempt the INSERT; one wins and
 * the other gets 23505. A unique violation here means "the row exists", which
 * is the caller's desired end state, so it is reported as success. The row is
 * then re-read so both callers receive identical data.
 */
export async function ensureProfile(client: ProfileClient, userId: string): Promise<Result<ProfileRow>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;

  const existing = await client.from('profiles').select('*').eq('user_id', id.data).maybeSingle();
  if (existing.error) return mapPostgrestError(existing.error, { table: 'profiles', operation: 'select' });
  if (existing.data) return ok(existing.data);

  const created = await client.from('profiles').insert({ user_id: id.data }).select().single();
  if (!created.error) return ok(created.data);

  if (created.error.code === '23505') {
    // Lost the race. That is success: re-read what the winner wrote.
    const reread = await client.from('profiles').select('*').eq('user_id', id.data).maybeSingle();
    if (reread.error) return mapPostgrestError(reread.error, { table: 'profiles', operation: 'select' });
    if (reread.data) return ok(reread.data);
    return fail('unknown', 'bootstrap_race_unresolved',
      'The profile row could not be read back after a concurrent creation.');
  }
  return mapPostgrestError(created.error, { table: 'profiles', operation: 'insert' });
}

/* -------------------------------------------------------------------- reads */

/**
 * Reads a singleton row, or `null` when it has never been written.
 *
 * `null` means UNKNOWN. It is never a default and never means "no".
 */
async function readSingleton<T extends 'profiles' | 'job_preferences' | 'automation_settings'>(
  client: ProfileClient, userId: string, table: T,
): Promise<Result<Row<T> | null>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const { data, error } = await loose(client).from(table).select('*').eq('user_id', id.data).maybeSingle();
  if (error) return mapPostgrestError(error, { table, operation: 'select' });
  return ok((data as Row<T> | null) ?? null);
}

export const getProfile = (c: ProfileClient, u: string) => readSingleton(c, u, 'profiles');
export const getJobPreferences = (c: ProfileClient, u: string) => readSingleton(c, u, 'job_preferences');
export const getAutomationSettings = (c: ProfileClient, u: string) => readSingleton(c, u, 'automation_settings');

/** Reads a collection in a deterministic order (see `COLLECTION_ORDER`). */
async function readCollection<T extends keyof typeof COLLECTION_ORDER & TableName>(
  client: ProfileClient, userId: string, table: T,
): Promise<Result<Row<T>[]>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const query = applyOrder(loose(client).from(table).select('*').eq('user_id', id.data), table);
  const { data, error } = await query;
  if (error) return mapPostgrestError(error, { table, operation: 'select' });
  return ok((data ?? []) as Row<T>[]);
}

export const listWorkAuthorizations = (c: ProfileClient, u: string) => readCollection(c, u, 'work_authorizations');
export const listWorkExperiences = (c: ProfileClient, u: string) => readCollection(c, u, 'work_experiences');
export const listEducationEntries = (c: ProfileClient, u: string) => readCollection(c, u, 'education_entries');
export const listSkills = (c: ProfileClient, u: string) => readCollection(c, u, 'skills');
export const listCertifications = (c: ProfileClient, u: string) => readCollection(c, u, 'certifications');
export const listProjects = (c: ProfileClient, u: string) => readCollection(c, u, 'projects');
export const listLanguages = (c: ProfileClient, u: string) => readCollection(c, u, 'languages');
export const listVerifiedAnswers = (c: ProfileClient, u: string) => readCollection(c, u, 'verified_answers');

/**
 * The complete candidate model in one structured, serialisable object.
 *
 * All eleven reads are issued concurrently; they are independent SELECTs under
 * RLS, so there is no ordering requirement between them. If any fails the whole
 * snapshot fails rather than returning a partially-populated model that a
 * caller might mistake for "these facts are absent".
 *
 * `capturedAt` is the only value the layer generates. It is metadata about the
 * read, never candidate data, and is excluded from any equality comparison a
 * caller makes between two snapshots.
 */
export async function getCandidateSnapshot(
  client: ProfileClient, userId: string,
): Promise<Result<CandidateSnapshot>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;

  const [
    profile, jobPreferences, automationSettings, workAuthorizations, workExperiences,
    educationEntries, skills, certifications, projects, languages, verifiedAnswers,
  ] = await Promise.all([
    getProfile(client, id.data), getJobPreferences(client, id.data), getAutomationSettings(client, id.data),
    listWorkAuthorizations(client, id.data), listWorkExperiences(client, id.data),
    listEducationEntries(client, id.data), listSkills(client, id.data), listCertifications(client, id.data),
    listProjects(client, id.data), listLanguages(client, id.data), listVerifiedAnswers(client, id.data),
  ]);

  for (const part of [
    profile, jobPreferences, automationSettings, workAuthorizations, workExperiences,
    educationEntries, skills, certifications, projects, languages, verifiedAnswers,
  ]) {
    if (!part.ok) return part;
  }

  return ok({
    userId: id.data,
    capturedAt: new Date().toISOString(),
    profile: (profile as Result<ProfileRow | null> & { ok: true }).data,
    jobPreferences: (jobPreferences as Result<JobPreferencesRow | null> & { ok: true }).data,
    automationSettings: (automationSettings as Result<AutomationSettingsRow | null> & { ok: true }).data,
    workAuthorizations: (workAuthorizations as Result<WorkAuthorizationRow[]> & { ok: true }).data,
    workExperiences: (workExperiences as Result<WorkExperienceRow[]> & { ok: true }).data,
    educationEntries: (educationEntries as Result<EducationEntryRow[]> & { ok: true }).data,
    skills: (skills as Result<SkillRow[]> & { ok: true }).data,
    certifications: (certifications as Result<CertificationRow[]> & { ok: true }).data,
    projects: (projects as Result<ProjectRow[]> & { ok: true }).data,
    languages: (languages as Result<LanguageRow[]> & { ok: true }).data,
    verifiedAnswers: (verifiedAnswers as Result<VerifiedAnswerRow[]> & { ok: true }).data,
  });
}

/* ------------------------------------------------------------------- writes */

/**
 * Upserts a singleton row, keyed on `user_id`.
 *
 * Only caller-supplied keys are written. `user_id` is stamped from the
 * authenticated identity, so it can never be redirected at another user.
 */
async function upsertSingleton<T extends 'profiles' | 'job_preferences' | 'automation_settings'>(
  client: ProfileClient, userId: string, table: T, input: UpdateInput<T>,
): Promise<Result<Row<T>>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;

  const patch = definedOnly(input as object);
  const issues = validateWrite(table, patch);
  if (issues.length > 0) return invalid(issues);

  const { data, error } = await loose(client)
    .from(table)
    .upsert({ ...patch, user_id: id.data }, { onConflict: 'user_id' })
    .select()
    .single();
  if (error) return mapPostgrestError(error, { table, operation: 'upsert' });
  return ok(data as Row<T>);
}

export const upsertProfile = (c: ProfileClient, u: string, input: UpdateInput<'profiles'>) =>
  upsertSingleton(c, u, 'profiles', input);
export const upsertJobPreferences = (c: ProfileClient, u: string, input: UpdateInput<'job_preferences'>) =>
  upsertSingleton(c, u, 'job_preferences', input);

/**
 * Automation settings.
 *
 * There is no convenience "enable automation" path and no implicit default:
 * every permission flag and every `stop_on_*` guard changes only when the
 * caller passes an explicit value. Omitting a flag leaves the stored value
 * alone, and on a first write the schema defaults apply — permissions off,
 * all eight stop conditions on.
 */
export const upsertAutomationSettings = (c: ProfileClient, u: string, input: UpdateInput<'automation_settings'>) =>
  upsertSingleton(c, u, 'automation_settings', input);

/** Inserts a row into a collection table. */
async function createInCollection<T extends keyof typeof COLLECTION_ORDER & TableName>(
  client: ProfileClient, userId: string, table: T, input: CreateInput<T>,
): Promise<Result<Row<T>>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;

  const payload = definedOnly(input as object);
  const issues = validateWrite(table, payload);
  if (issues.length > 0) return invalid(issues);

  const { data, error } = await loose(client)
    .from(table)
    .insert({ ...payload, user_id: id.data })
    .select()
    .single();
  if (error) return mapPostgrestError(error, { table, operation: 'insert' });
  return ok(data as Row<T>);
}

/**
 * Updates one row of a collection table by id.
 *
 * Scoped by `user_id` as well as `id`, so a caller holding another user's row
 * id still cannot reach it even if a policy were relaxed. Zero rows affected is
 * reported as `not_found`, which is what makes an RLS-filtered no-op visible.
 */
async function updateInCollection<T extends keyof typeof COLLECTION_ORDER & TableName>(
  client: ProfileClient, userId: string, table: T, rowId: string, input: UpdateInput<T>,
): Promise<Result<Row<T>>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  if (!UUID.test(rowId)) {
    return fail('invalid_input', 'bad_row_id', 'The record id is not a valid identifier.', { field: 'id' });
  }

  const patch = definedOnly(input as object);
  if (Object.keys(patch).length === 0) {
    return fail('invalid_input', 'empty_update', 'No fields were supplied to update.');
  }
  const issues = validateWrite(table, patch);
  if (issues.length > 0) return invalid(issues);

  const { data, error } = await loose(client)
    .from(table)
    .update(patch)
    .eq('id', rowId)
    .eq('user_id', id.data)
    .select();
  if (error) return mapPostgrestError(error, { table, operation: 'update' });
  const rows = (data ?? []) as Row<T>[];
  if (rows.length === 0) {
    return fail('not_found', 'row_not_found', 'The record does not exist or is not yours to modify.');
  }
  return ok(rows[0]);
}

/** Deletes one row of a collection table. Zero rows affected is `not_found`. */
async function deleteFromCollection<T extends keyof typeof COLLECTION_ORDER & TableName>(
  client: ProfileClient, userId: string, table: T, rowId: string,
): Promise<Result<{ id: string }>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  if (!UUID.test(rowId)) {
    return fail('invalid_input', 'bad_row_id', 'The record id is not a valid identifier.', { field: 'id' });
  }
  const { data, error } = await loose(client)
    .from(table).delete().eq('id', rowId).eq('user_id', id.data).select('id');
  if (error) return mapPostgrestError(error, { table, operation: 'delete' });
  const rows = (data ?? []) as { id: string }[];
  if (rows.length === 0) {
    return fail('not_found', 'row_not_found', 'The record does not exist or is not yours to delete.');
  }
  return ok({ id: rows[0].id });
}

const collection = <T extends keyof typeof COLLECTION_ORDER & TableName>(table: T) => ({
  create: (c: ProfileClient, u: string, input: CreateInput<T>) => createInCollection(c, u, table, input),
  update: (c: ProfileClient, u: string, rowId: string, input: UpdateInput<T>) =>
    updateInCollection(c, u, table, rowId, input),
  remove: (c: ProfileClient, u: string, rowId: string) => deleteFromCollection(c, u, table, rowId),
});

export const workExperiences = collection('work_experiences');
export const educationEntries = collection('education_entries');
export const skills = collection('skills');
export const certifications = collection('certifications');
export const projects = collection('projects');
export const languages = collection('languages');

/* ------------------------------------------------- work authorization */

/**
 * Records work authorization for one country.
 *
 * The three booleans are NOT NULL in the schema precisely so a half-specified
 * row cannot exist: a caller must state all three or none. Passing only some of
 * them reaches the database and returns `constraint_violation` (23502) rather
 * than being silently completed with invented values.
 *
 * Absence of a row for a country is UNKNOWN. It never means "not authorized".
 */
export const workAuthorizations = {
  ...collection('work_authorizations'),
  /**
   * Upserts on the natural key `(user_id, country_code)`, so re-stating an
   * authorization is idempotent rather than a conflict.
   */
  async set(
    client: ProfileClient, userId: string, input: CreateInput<'work_authorizations'>,
  ): Promise<Result<WorkAuthorizationRow>> {
    const id = requireUserId(userId);
    if (!id.ok) return id;
    const payload = definedOnly(input as object);
    const issues = validateWrite('work_authorizations', payload);
    if (issues.length > 0) return invalid(issues);

    const { data, error } = await client
      .from('work_authorizations')
      .upsert({ ...payload, user_id: id.data } as never, { onConflict: 'user_id,country_code' })
      .select()
      .single();
    if (error) return mapPostgrestError(error, { table: 'work_authorizations', operation: 'upsert' });
    return ok(data as WorkAuthorizationRow);
  },
};

/* ----------------------------------------------------- verified answers */

/**
 * Creates or replaces an answer, keyed on `(user_id, question_key)`.
 *
 * `source` is forced to `user_entered`, the only value the migration-9
 * provenance guard permits an API client to assert. The two trusted values are
 * reserved for server-side workflows; sending one returns `forbidden`.
 *
 * `is_verified` is NOT settable here. Verification represents a real human
 * decision and has its own named operation, so a bulk save can never quietly
 * mark an answer as approved. New answers are therefore unverified, which makes
 * the generated `requires_human_approval` true — the database-level expression
 * of "stop and ask the human".
 */
export async function saveVerifiedAnswer(
  client: ProfileClient,
  userId: string,
  input: Omit<CreateInput<'verified_answers'>, 'source' | 'is_verified'>,
): Promise<Result<VerifiedAnswerRow>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;

  const payload = definedOnly(input as object);
  const issues = validateWrite('verified_answers', payload);
  if (issues.length > 0) return invalid(issues);

  const { data, error } = await client
    .from('verified_answers')
    .upsert(
      { ...payload, user_id: id.data, source: CLIENT_WRITABLE_SOURCE } as never,
      { onConflict: 'user_id,question_key' },
    )
    .select()
    .single();
  if (error) return mapPostgrestError(error, { table: 'verified_answers', operation: 'upsert' });
  return ok(data as VerifiedAnswerRow);
}

/**
 * Records an explicit human verification decision.
 *
 * Separate and explicitly named so it can never happen as a side effect of
 * saving content. `verified_at` is deliberately not sent: the migration-9
 * trigger derives it from `is_verified`, and sending it would be both
 * redundant and a chance to disagree with the database.
 *
 * A locked answer is refused. `is_locked` exists so a human can freeze an
 * answer, and the layer honours that rather than silently overriding it.
 */
export async function setAnswerVerification(
  client: ProfileClient, userId: string, questionKey: string, isVerified: boolean,
): Promise<Result<VerifiedAnswerRow>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;

  const current = await client
    .from('verified_answers').select('*')
    .eq('user_id', id.data).eq('question_key', questionKey).maybeSingle();
  if (current.error) return mapPostgrestError(current.error, { table: 'verified_answers', operation: 'select' });
  if (!current.data) return fail('not_found', 'row_not_found', 'No stored answer for that question.');
  if (current.data.is_locked) {
    return fail('forbidden', 'answer_locked',
      'This answer is locked. Unlock it before changing its verification state.', { field: 'is_locked' });
  }

  const { data, error } = await client
    .from('verified_answers')
    .update({ is_verified: isVerified })
    .eq('user_id', id.data).eq('question_key', questionKey)
    .select();
  if (error) return mapPostgrestError(error, { table: 'verified_answers', operation: 'update' });
  const rows = data ?? [];
  if (rows.length === 0) return fail('not_found', 'row_not_found', 'No stored answer for that question.');
  return ok(rows[0]);
}

/** Sets or clears the human lock on an answer. */
export async function setAnswerLock(
  client: ProfileClient, userId: string, questionKey: string, isLocked: boolean,
): Promise<Result<VerifiedAnswerRow>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;
  const { data, error } = await client
    .from('verified_answers').update({ is_locked: isLocked })
    .eq('user_id', id.data).eq('question_key', questionKey)
    .select();
  if (error) return mapPostgrestError(error, { table: 'verified_answers', operation: 'update' });
  const rows = data ?? [];
  if (rows.length === 0) return fail('not_found', 'row_not_found', 'No stored answer for that question.');
  return ok(rows[0]);
}

/**
 * Records that an answer was used in an application.
 *
 * Touches only `times_used` and `last_used_at`; answer content, verification
 * state and sensitivity are untouched. Safe to call repeatedly — but NOT
 * idempotent by design, since the count is meant to increase. It is read-then-
 * write rather than atomic, so concurrent calls may under-count; that is
 * acceptable for a usage statistic and is documented rather than papered over
 * with a database function, which this step is not permitted to add.
 */
export async function recordAnswerUsage(
  client: ProfileClient, userId: string, questionKey: string,
): Promise<Result<VerifiedAnswerRow>> {
  const id = requireUserId(userId);
  if (!id.ok) return id;

  const current = await client
    .from('verified_answers').select('id, times_used')
    .eq('user_id', id.data).eq('question_key', questionKey).maybeSingle();
  if (current.error) return mapPostgrestError(current.error, { table: 'verified_answers', operation: 'select' });
  if (!current.data) return fail('not_found', 'row_not_found', 'No stored answer for that question.');

  const { data, error } = await client
    .from('verified_answers')
    .update({ times_used: current.data.times_used + 1, last_used_at: new Date().toISOString() })
    .eq('id', current.data.id).eq('user_id', id.data)
    .select();
  if (error) return mapPostgrestError(error, { table: 'verified_answers', operation: 'update' });
  const rows = data ?? [];
  if (rows.length === 0) return fail('not_found', 'row_not_found', 'No stored answer for that question.');
  return ok(rows[0]);
}

export const deleteVerifiedAnswer = (c: ProfileClient, u: string, rowId: string) =>
  deleteFromCollection(c, u, 'verified_answers', rowId);
