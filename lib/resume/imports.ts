import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AdminClient } from '@/lib/supabase/admin';
import type { ExtractFailureClass } from '@/lib/resume/extract';
import { parseExtraction, type ResumeExtraction } from '@/lib/resume/schema';

/**
 * Reading and writing `resume_imports`.
 *
 * Two clients appear in this file and the split is the security design, not an
 * accident:
 *
 *   * The CANDIDATE'S OWN SESSION does everything a candidate does — read their
 *     imports, correct a draft, discard one. Every such call is checked by RLS,
 *     so a wrong id in a URL returns nothing rather than someone else's résumé.
 *
 *   * The ADMIN CLIENT does only the three things RLS deliberately forbids a
 *     browser: create the row (so an import cannot be conjured without a stored
 *     file, and so the decision to spend a paid model call stays on the server),
 *     record the parse result, and mark a confirmation (which asserts that rows
 *     were written to the profile tables, something only the writer can know).
 *
 * Nothing here writes to `profiles`, `work_experiences`, `education_entries` or
 * `skills`. That is the confirm action's job, and it does it under the
 * candidate's own session.
 */

/* -------------------------------------------------------------------- types */

/**
 * The row shape.
 *
 * HAND-WRITTEN, TEMPORARILY. Everywhere else in this codebase a row type is
 * projected from `lib/supabase/database.types.ts` so that a schema change
 * surfaces as a compile error. That file is regenerated from a running
 * database, and the local stack is unreachable at the time of writing
 * (see docs/ADMIN.md), so this mirrors migration 20 by hand instead.
 *
 * It is not left to trust: `scripts/test-resume-import.mjs` reads
 * `information_schema.columns` and fails if this list and the table disagree in
 * either direction. Regenerate the types and delete this block as soon as a
 * database is reachable.
 */
export interface ResumeImportRow {
  id: string;
  user_id: string;
  source_kind: 'upload' | 'pasted';
  storage_path: string | null;
  file_name: string | null;
  file_size_bytes: number | null;
  status: ResumeImportStatus;
  failure_class: ExtractFailureClass | null;
  failure_code: string | null;
  extracted: unknown;
  model: string | null;
  parsed_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export const RESUME_IMPORT_STATUSES = [
  'uploaded',
  'parsing',
  'parsed',
  'confirmed',
  'discarded',
  'failed',
] as const;

export type ResumeImportStatus = (typeof RESUME_IMPORT_STATUSES)[number];

export function isResumeImportStatus(value: unknown): value is ResumeImportStatus {
  return typeof value === 'string' && (RESUME_IMPORT_STATUSES as readonly string[]).includes(value);
}

/** Every column, as one string literal — Supabase's typings require a literal. */
const COLUMNS =
  'id, user_id, source_kind, storage_path, file_name, file_size_bytes, status, failure_class, failure_code, extracted, model, parsed_at, confirmed_at, created_at, updated_at';

/**
 * An import with its draft already validated.
 *
 * `extracted` is jsonb the owner may edit during review, so what comes back out
 * of the database is untrusted input even though we put it there. Callers get
 * `draft: null` when it fails to validate rather than a half-parsed object, and
 * the review screen treats that the same as a failed parse.
 */
export interface ResumeImport extends Omit<ResumeImportRow, 'extracted'> {
  draft: ResumeExtraction | null;
}

function hydrate(row: ResumeImportRow): ResumeImport {
  const { extracted, ...rest } = row;
  return { ...rest, draft: extracted === null ? null : parseExtraction(extracted) };
}

/**
 * `resume_imports` is absent from the generated `Database` type until it is
 * regenerated, so the table is reached through a deliberately narrow untyped
 * view of the client. Confined to this file, and every read is re-validated by
 * `hydrate` on the way out.
 */
type AnyTableClient = SupabaseClient<never, 'public', never>;
const table = (client: unknown) =>
  (client as unknown as AnyTableClient).from('resume_imports' as never);

/* ------------------------------------------------------- candidate's session */

/** One import, if it belongs to the caller. RLS does the ownership check. */
export async function getImport(
  supabase: unknown,
  importId: string
): Promise<ResumeImport | null> {
  const { data, error } = await table(supabase)
    .select(COLUMNS)
    .eq('id', importId)
    .maybeSingle<ResumeImportRow>();

  if (error || !data) return null;
  return hydrate(data);
}

/** The caller's imports, newest first. */
export async function listImports(supabase: unknown, limit = 10): Promise<ResumeImport[]> {
  const { data, error } = await table(supabase)
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<ResumeImportRow[]>();

  if (error || !data) return [];
  return data.map(hydrate);
}

/**
 * The most recent import still worth showing — one under review, or one that
 * failed and the person has not dealt with. A confirmed or discarded import is
 * history, not an outstanding thing.
 */
export async function getActiveImport(supabase: unknown): Promise<ResumeImport | null> {
  const { data, error } = await table(supabase)
    .select(COLUMNS)
    .in('status', ['uploaded', 'parsing', 'parsed', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .returns<ResumeImportRow[]>();

  if (error || !data?.length) return null;
  return hydrate(data[0]);
}

/**
 * Save the candidate's corrections to a draft.
 *
 * Goes through the candidate's own session on purpose: this is their edit of
 * their own draft, and the RLS policy — which allows an update only while the
 * row is `parsed`, and never into `confirmed` — is exactly the rule that should
 * govern it.
 */
export async function saveDraft(
  supabase: unknown,
  importId: string,
  draft: ResumeExtraction
): Promise<boolean> {
  const { error } = await table(supabase)
    .update({ extracted: draft } as never)
    .eq('id', importId)
    .eq('status', 'parsed');

  return !error;
}

/**
 * The candidate rejecting an import — either a draft they do not want, or a
 * failed attempt they want off the screen.
 *
 * `failure_class` is cleared alongside the status because the table asserts
 * that a failure reason and the `failed` status imply each other. Leaving a
 * reason on a discarded row would violate that constraint, which is the check
 * doing its job: a row is not allowed to half-remember having failed.
 */
export async function discardImport(supabase: unknown, importId: string): Promise<boolean> {
  const { error } = await table(supabase)
    .update({ status: 'discarded', failure_class: null, failure_code: null } as never)
    .eq('id', importId)
    .in('status', ['parsed', 'failed']);

  return !error;
}

/* ----------------------------------------------------------- server-side only */

/**
 * Create the row.
 *
 * `storage_path` is required for an upload and forbidden for a paste — the
 * table states that as a biconditional, so getting it wrong here is a
 * constraint violation rather than a row that quietly claims a file it does not
 * have.
 */
export async function createImport(
  admin: AdminClient,
  userId: string,
  file: {
    sourceKind: 'upload' | 'pasted';
    storagePath: string | null;
    fileName: string | null;
    fileSizeBytes: number | null;
  }
): Promise<string | null> {
  const { data, error } = await table(admin)
    .insert({
      user_id: userId,
      source_kind: file.sourceKind,
      storage_path: file.storagePath,
      file_name: file.fileName,
      file_size_bytes: file.fileSizeBytes,
      status: 'parsing',
    } as never)
    .select('id')
    .maybeSingle<{ id: string }>();

  if (error || !data) return null;
  return data.id;
}

/** Record a successful read. The draft is a proposal; nothing is written elsewhere. */
export async function markParsed(
  admin: AdminClient,
  importId: string,
  draft: ResumeExtraction,
  model: string
): Promise<boolean> {
  const { error } = await table(admin)
    .update({
      status: 'parsed',
      extracted: draft,
      model,
      parsed_at: new Date().toISOString(),
      failure_class: null,
      failure_code: null,
    } as never)
    .eq('id', importId);

  return !error;
}

/**
 * Record a failure.
 *
 * `failureCode` is a fixed vocabulary from `lib/resume/extract.ts` — never a
 * provider message, and never anything derived from the document. A stored
 * failure reason must not become the route by which someone's employment
 * history reaches a log.
 */
export async function markFailed(
  admin: AdminClient,
  importId: string,
  failureClass: ExtractFailureClass,
  failureCode: string
): Promise<boolean> {
  const { error } = await table(admin)
    .update({
      status: 'failed',
      failure_class: failureClass,
      failure_code: failureCode.slice(0, 100),
    } as never)
    .eq('id', importId);

  return !error;
}

/**
 * Mark an import confirmed.
 *
 * Called only after the profile rows have actually been written, which is why a
 * browser cannot do it: `confirmed` is a claim about what happened in four
 * other tables, and only the code that wrote them can make it truthfully.
 */
export async function markConfirmed(admin: AdminClient, importId: string): Promise<boolean> {
  const { error } = await table(admin)
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() } as never)
    .eq('id', importId)
    .eq('status', 'parsed');

  return !error;
}
