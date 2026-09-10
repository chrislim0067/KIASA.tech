import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/supabase/database.types';
import { visibleStatus, WorkerStatusView } from '@/lib/worker/pairing';

/**
 * "Is my worker running?", answered once, for everyone who asks.
 *
 * THE CANDIDATE'S OWN SESSION, ALWAYS. Every read below goes through their own
 * RLS policies, so they can only ever learn about their own worker. No elevated
 * client is involved, which is why nothing here does an ownership check of its
 * own — RLS is the check.
 *
 * IT RETURNS STATUS AND NOTHING ELSE. The hash columns are not merely omitted:
 * migration 24 does not grant `authenticated` the privilege to read them, so a
 * browser querying PostgREST directly cannot obtain them either. What this
 * function returns is validated against `WorkerStatusView` — a `.strict()`
 * schema with no field a credential could occupy — so a column added later
 * fails the parse rather than arriving on a page.
 *
 * This lives in a module rather than in the route because two callers need it:
 * `GET /api/worker/status` and the server-rendered drafting page, which would
 * otherwise fetch its own API over HTTP to learn something it can read
 * directly.
 */
export async function readWorkerStatus(
  supabase: SupabaseClient<Database>
): Promise<WorkerStatusView | null> {
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
       * carried side by side rather than one overriding the other.
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

  /*
   * Validated on the way out. A field that should not be here is a refusal,
   * not a disclosure — `null`, which every caller renders as "we cannot tell",
   * rather than the object that failed.
   */
  const checked = WorkerStatusView.safeParse(view);
  return checked.success ? checked.data : null;
}
