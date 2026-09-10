import { NextResponse } from 'next/server';

import { randomUUID } from 'node:crypto';

import { PROFILE_DRAFT_FIELDS, PROFILE_DRAFT_SCHEMA_VERSION } from '@/lib/profile/draft';
import { DraftTaskInput } from '@/lib/profile/drafting';
import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { ResumeExtraction } from '@/lib/resume/schema';

/**
 * POST /api/profile/draft — "draft my profile from my résumé, on my computer."
 *
 * EVERY WRITE HERE IS THE CANDIDATE'S OWN, under their session and their RLS
 * policies. There is no elevated client on this path: creating a task and a
 * draft row is something they could do from the profile forms, so it goes
 * through the same door.
 *
 * THREE THINGS ARE REQUIRED, AND NONE OF THEM IS ASSUMED
 *
 *   a session          ownership comes from it, never from the body
 *   claude_max_assisted the candidate chose local processing
 *   local consent      stated in this request, for this request
 *
 * The task is born `queued`. The intake pipeline that walks a job application
 * from `received` to `queued` is about reading a job posting; a profile draft
 * has no posting and nothing to validate, so it starts where the work starts.
 */

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' };

const refuse = (reason: string, status: number) =>
  NextResponse.json({ ok: false, reason }, { status, headers: noStore });

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) return refuse('unconfigured', 503);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return refuse('unauthenticated', 401);

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return refuse('malformed_request', 400);
  }

  const payload = body as Record<string, unknown> | null;
  if (payload?.mode !== 'claude_max_assisted') return refuse('mode_required', 400);
  /*
   * CONSENT IS STATED HERE AND CHECKED AGAIN LATER.
   *
   * This is the candidate agreeing that a task may be created for local
   * processing. The worker checks consent a second time, on their machine,
   * immediately before it starts a process — because that is where the process
   * actually starts and a stale agreement is not consent.
   */
  if (payload?.local_consent !== true) return refuse('consent_required', 400);

  const { data: latest } = await supabase
    .from('resume_imports')
    .select('id, extracted, status')
    .in('status', ['parsed', 'confirmed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest?.extracted) return refuse('no_resume_facts', 409);

  const facts = ResumeExtraction.safeParse(latest.extracted);
  if (!facts.success) return refuse('resume_facts_invalid', 409);

  const { data: profile } = await supabase
    .from('profiles')
    // One literal, not a concatenation: the client infers the row type from
    // this string, and it cannot infer anything from an expression.
    .select(
      'updated_at, legal_first_name, legal_middle_name, legal_last_name, preferred_name, contact_email, phone_e164, city, state_region, country_code, linkedin_url, github_url, portfolio_url'
    )
    .maybeSingle();

  if (!profile?.updated_at) return refuse('profile_missing', 409);

  const snapshot = Object.fromEntries(
    PROFILE_DRAFT_FIELDS.map((field) => [
      field,
      ((profile as Record<string, unknown>)[field] as string | null) ?? null,
    ])
  );

  const input = DraftTaskInput.safeParse({
    schema_version: PROFILE_DRAFT_SCHEMA_VERSION,
    facts: facts.data,
    current: snapshot,
  });
  if (!input.success) return refuse('malformed_request', 400);

  /*
   * IDEMPOTENT BY RÉSUMÉ AND PROFILE VERSION.
   *
   * `automation_tasks_one_per_idempotency_key` is a unique index on
   * (user_id, idempotency_key), so asking twice for a draft of the same résumé
   * against the same profile collides in the database rather than producing a
   * second task and a second worker run.
   */
  const idempotencyKey = `profile-draft:${latest.id}:${Date.parse(profile.updated_at)}`;

  const { data: task, error: taskError } = await supabase
    .from('automation_tasks')
    .insert({
      user_id: user.id,
      job_id: null,
      kind: 'candidate_profile_drafting',
      status: 'queued',
      mode: 'claude_max_assisted',
      idempotency_key: idempotencyKey,
      correlation_id: randomUUID(),
    })
    .select('id')
    .maybeSingle();

  if (taskError || !task) {
    // A collision is the idempotency key doing its job, not a failure.
    return refuse('already_requested', 409);
  }

  const { error: draftError } = await supabase.from('profile_drafts').insert({
    user_id: user.id,
    task_id: task.id,
    resume_import_id: latest.id,
    profile_version: profile.updated_at,
    input: input.data,
  });

  if (draftError) return refuse('draft_not_created', 500);

  return NextResponse.json(
    { ok: true, task_id: task.id },
    { status: 200, headers: noStore }
  );
}
