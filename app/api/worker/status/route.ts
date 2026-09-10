import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { visibleStatus, WorkerStatusView } from '@/lib/worker/pairing';

/**
 * GET /api/worker/status — "is my worker running?"
 *
 * The candidate's OWN session, so the read goes through their own RLS
 * policies: they can only ever learn about their own worker. No elevated
 * client is involved, which is why this route needs no ownership check of its
 * own — RLS is the check.
 *
 * It returns status and nothing else. The hash columns are not merely omitted
 * here: migration 24 does not grant `authenticated` the privilege to read
 * them, so a browser querying PostgREST directly cannot obtain them either.
 * The response shape is validated against `WorkerStatusView`, which rejects
 * any credential-shaped field.
 */

export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store, max-age=0, must-revalidate' };

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, reason: 'unconfigured' }, { status: 503, headers: noStore });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: 'unauthenticated' }, { status: 401, headers: noStore });
  }

  const { data: credential } = await supabase
    .from('worker_credentials')
    .select('supervisor_id, slot_id, issued_at, expires_at, revoked_at')
    .is('revoked_at', null)
    .order('issued_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let lastHeartbeatAt: string | null = null;
  let slotIndex: number | null = null;
  let readiness: string | null = null;
  let pauseReason: string | null = null;
  let stopReason: string | null = null;
  if (credential?.supervisor_id) {
    const { data: supervisor } = await supabase
      .from('worker_supervisors')
      .select('last_heartbeat_at')
      .eq('id', credential.supervisor_id)
      .maybeSingle();
    lastHeartbeatAt = supervisor?.last_heartbeat_at ?? null;

    if (credential.slot_id) {
      const { data: slot } = await supabase
        .from('worker_slots')
        .select('slot_index, readiness, pause_reason, stop_reason')
        .eq('id', credential.slot_id)
        .maybeSingle();
      slotIndex = slot?.slot_index ?? null;
      /*
       * READINESS IS A SLOT FACT, NOT A PAIRING FACT. An online worker whose
       * slot is paused is still online and still reporting, so the two are
       * shown side by side rather than one overriding the other.
       *
       * Only these three columns, and each is a value from a CHECK-constrained
       * vocabulary — there is no free text on a slot for a browser to render.
       */
      readiness = slot?.readiness ?? null;
      pauseReason = slot?.pause_reason ?? null;
      stopReason = slot?.stop_reason ?? null;
    }
  }

  const view = {
    status: visibleStatus(
      {
        hasCredential: Boolean(credential),
        revokedAt: credential?.revoked_at ?? null,
        expiresAt: credential?.expires_at ?? null,
        lastHeartbeatAt,
      },
      new Date()
    ),
    supervisor_id: credential?.supervisor_id ?? null,
    slot_index: slotIndex,
    slot_readiness: readiness,
    pause_reason: pauseReason,
    stop_reason: stopReason,
    last_heartbeat_at: lastHeartbeatAt,
    paired_at: credential?.issued_at ?? null,
    expires_at: credential?.expires_at ?? null,
  };

  // Validated on the way out: a field that should not be here is a 500, not a
  // disclosure.
  const checked = WorkerStatusView.safeParse(view);
  if (!checked.success) {
    return NextResponse.json({ ok: false, reason: 'invalid_view' }, { status: 500, headers: noStore });
  }
  return NextResponse.json({ ok: true, worker: checked.data }, { status: 200, headers: noStore });
}
