import { NextResponse } from 'next/server';

import { ConfirmRequest, planConfirmation } from '@/lib/profile/confirm';
import { upsertProfile } from '@/lib/profile/operations';
import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';

/**
 * POST /api/profile/draft/confirm — the only path from a draft into a profile.
 *
 * NOTHING A MODEL PRODUCED IS WRITTEN UNTIL THIS RUNS, and it runs under the
 * candidate's own session. The draft has been sitting in `profile_drafts`,
 * which no profile query reads; confirming is what moves chosen values across,
 * one field at a time, through the same `upsertProfile` the profile forms use.
 *
 * The decision is made by `planConfirmation`, which is pure. This handler
 * fetches, calls it, and performs exactly what it returns — so the rules about
 * staleness, expiry, fabrication and idempotency live somewhere they can be
 * tested without a database, and this file has no judgement of its own.
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

  const parsed = ConfirmRequest.safeParse(body);
  if (!parsed.success) return refuse('malformed_request', 400);

  /*
   * RLS DOES THE OWNERSHIP CHECK, AND IT IS NOT THE ONLY ONE.
   *
   * The select runs under the candidate's session, so another candidate's
   * draft simply is not there. The explicit comparison below is a second
   * layer, and the one that would catch a policy edited wrongly in future.
   */
  const { data: draft } = await supabase
    .from('profile_drafts')
    .select('id, user_id, status, profile_version, expires_at, input, result')
    .eq('id', parsed.data.draft_id)
    .maybeSingle();

  if (!draft || draft.user_id !== user.id) return refuse('draft_not_found', 404);

  const { data: profile } = await supabase.from('profiles').select('updated_at').maybeSingle();
  if (!profile?.updated_at) return refuse('profile_missing', 409);

  const plan = planConfirmation(draft, parsed.data, profile.updated_at, new Date());
  if (!plan.ok) {
    return refuse(plan.reason, plan.reason === 'draft_not_found' ? 404 : 409);
  }

  if (plan.action === 'reject') {
    await supabase
      .from('profile_drafts')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
      .eq('id', draft.id);
    return NextResponse.json({ ok: true, applied: 0 }, { status: 200, headers: noStore });
  }

  const fields = Object.keys(plan.writes);
  if (fields.length > 0) {
    /*
     * THE SAME WRITE A PERSON MAKES BY HAND. `upsertProfile` under the
     * candidate's session, so every column constraint, every RLS policy and
     * every migration-9 trigger applies exactly as it does to the profile
     * forms. Provenance and timestamps are assigned there, not here.
     */
    const result = await upsertProfile(supabase, user.id, plan.writes);
    if (!result.ok) return refuse('profile_write_failed', 409);
  }

  await supabase
    .from('profile_drafts')
    .update({ status: 'confirmed', reviewed_at: new Date().toISOString() })
    .eq('id', draft.id);

  return NextResponse.json(
    { ok: true, applied: fields.length },
    { status: 200, headers: noStore }
  );
}
