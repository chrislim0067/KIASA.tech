import { NextResponse } from 'next/server';

import { isSupabaseConfigured } from '@/lib/supabase/env';
import { authenticateWorker, submitProfileDraft } from '@/lib/worker/endpoints';
import { authStatus, noStore, operationStatus, readJson } from '@/lib/worker/http';
import { createPairingStore } from '@/lib/worker/store';

/**
 * POST /api/worker/task/draft — "here is the profile draft."
 *
 * The worker sends the fence it was given and the draft it produced on the
 * candidate's own machine. The draft goes to `profile_drafts`; it does not
 * touch any profile table, and it cannot, because the boundary function has no
 * path to one. The candidate confirms it field by field afterwards.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'unconfigured' }, { status: 503, headers: noStore });
  }

  const store = createPairingStore();
  const auth = await authenticateWorker(store, request.headers.get('authorization'), new Date());
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, reason: auth.reason },
      { status: authStatus(auth.reason), headers: noStore }
    );
  }

  const body = await readJson(request);
  if (!body.ok) {
    return NextResponse.json({ ok: false, reason: 'malformed_request' }, { status: 400, headers: noStore });
  }

  const result = await submitProfileDraft(
    store,
    { credentialId: auth.credentialId, tokenHash: auth.tokenHash },
    body.body
  );
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, reason: result.reason },
      { status: operationStatus(result.reason), headers: noStore }
    );
  }

  return NextResponse.json({ ok: true }, { status: 200, headers: noStore });
}
