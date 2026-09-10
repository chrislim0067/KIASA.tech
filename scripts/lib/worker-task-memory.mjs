/**
 * The task, lease and event half of an in-memory worker store.
 *
 * WHY THIS IS SHARED AND THE PAIRING HALF IS NOT
 *
 * Two suites need it — `test-worker-endpoints.mjs` and `probe-worker-e2e.mjs` —
 * and it is the part with actual logic: a claim that must be atomic, a fence
 * checked by equality, a lease that expires, three dispositions mapping to
 * three task states. Two copies of that would drift, and the copy that drifted
 * would be the one still passing.
 *
 * WHAT IT IS NOT
 *
 * It is not evidence. It models `worker_claim_task`, `worker_renew_lease` and
 * `worker_report_task` from migration 27 closely enough to test the protocol
 * ABOVE them, and no in-memory object can prove a row lock, a partial unique
 * index or a trigger. `scripts/test-worker-db-boundary.mjs` runs the same
 * lifecycle against real Postgres, and that is the run that proves anything.
 *
 * The one thing it deliberately does NOT model is a submission: there is no
 * disposition that reaches `ready_to_submit` or `submitted`, because there is
 * no such disposition in the database either.
 */

/** Exactly the reasons `worker_slots_pause_reason_allowed` permits. */
export const PAUSE_REASONS = [
  'employer_authentication_required',
  'claude_authentication_required',
  'captcha_detected',
  'anti_bot_challenge_detected',
  'mfa_required',
  'sensitive_information_requested',
  'unknown_page',
  'unknown_question',
  'unsupported_site',
  'control_plane_paused',
];

/** Exactly the reasons `worker_slots_stop_reason_allowed` permits. */
export const STOP_REASONS = [
  'candidate_requested',
  'kill_switch',
  'supervisor_shutdown',
  'slot_crashed',
  'lease_lost',
  'protocol_violation',
  'update_required',
];

const LEASE_MS = 2 * 60 * 1000;
const LEASE_CAP_MS = 60 * 60 * 1000;

/**
 * @param deps.credentials Map of credential id → row, as the pairing half holds it.
 * @param deps.uuid        Fresh id generator.
 * @param deps.now         Current time, as a Date.
 */
export function createTaskMemory({ credentials, uuid, now }) {
  /** Task id → row. `status` moves exactly as migration 22's table allows. */
  const tasks = new Map();
  /** Lease id → row. */
  const leases = new Map();
  /** Append-only, like the table. */
  const events = [];

  const at = () => (now ? now() : new Date());

  /** The same checks `worker_resolve_credential` makes, in the same order. */
  const resolve = (credentialId, tokenHash) => {
    const c = credentials.get(credentialId);
    if (!c || c.token_hash !== tokenHash) return { ok: false, reason: 'not_found' };
    if (c.revoked_at) return { ok: false, reason: 'revoked' };
    if (c.expires_at && Date.parse(c.expires_at) <= at().getTime()) {
      return { ok: false, reason: 'expired' };
    }
    if (c.audience !== 'kiasa-worker' || c.scope !== 'slot:heartbeat') {
      return { ok: false, reason: 'out_of_scope' };
    }
    return { ok: true, cred: c };
  };

  const record = (cred, kind, taskId, detail) => {
    events.push({
      id: uuid(),
      user_id: cred.user_id,
      supervisor_id: cred.supervisor_id,
      slot_id: cred.slot_id,
      task_id: taskId,
      kind,
      detail,
      occurred_at: at().toISOString(),
    });
  };

  const activeLeaseForSlot = (slotId) =>
    [...leases.values()].find((l) => l.slot_id === slotId && l.released_at === null) ?? null;

  return {
    tasks,
    leases,
    events,

    /** A synthetic approved task, the way a candidate's own session makes one. */
    seedTask(userId, overrides = {}) {
      const id = uuid();
      tasks.set(id, {
        id,
        user_id: userId,
        status: 'queued',
        // Defaults to the job-application meaning, exactly as the column does.
        kind: 'job_application',
        fence_token: 0,
        attempt: 0,
        max_attempts: 3,
        outcome: null,
        finished_at: null,
        created_at: at().toISOString(),
        ...overrides,
      });
      return id;
    },

    async claimTask({ credentialId, tokenHash }) {
      const refused = (reason) => ({
        ok: false,
        reason,
        taskId: null,
        leaseId: null,
        fenceToken: null,
        leaseExpiresAt: null,
        kind: null,
      });

      const r = resolve(credentialId, tokenHash);
      if (!r.ok) return refused(r.reason);
      const cred = r.cred;
      if (!cred.slot_id) return refused('no_slot');

      // Reclaim a dead lease first: both uniqueness indexes are on unreleased
      // rows, so an expired one still occupies the slot and its task.
      const held = activeLeaseForSlot(cred.slot_id);
      if (held && Date.parse(held.expires_at) <= at().getTime()) {
        held.released_at = at().toISOString();
        held.release_reason = 'expired';
        record(cred, 'lease_expired', held.task_id, {});
        const stale = tasks.get(held.task_id);
        if (stale && (stale.status === 'leased' || stale.status === 'processing')) {
          stale.status = 'queued';
        }
      }
      if (activeLeaseForSlot(cred.slot_id)) return refused('slot_busy');

      const task = [...tasks.values()]
        .filter((t) => t.user_id === cred.user_id && t.status === 'queued')
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      if (!task) return refused('no_task_available');
      if (task.attempt >= task.max_attempts) return refused('attempts_exhausted');

      task.fence_token += 1;
      task.attempt += 1;
      task.status = 'processing';

      const leaseId = uuid();
      const expiresAt = new Date(at().getTime() + LEASE_MS).toISOString();
      leases.set(leaseId, {
        id: leaseId,
        user_id: cred.user_id,
        task_id: task.id,
        slot_id: cred.slot_id,
        fence_token: task.fence_token,
        acquired_at: at().toISOString(),
        expires_at: expiresAt,
        released_at: null,
        release_reason: null,
      });
      record(cred, 'lease_acquired', task.id, { fence: task.fence_token });
      record(cred, 'task_started', task.id, { fence: task.fence_token });

      return {
        ok: true,
        reason: 'claimed',
        taskId: task.id,
        leaseId,
        fenceToken: task.fence_token,
        leaseExpiresAt: expiresAt,
        kind: task.kind,
      };
    },

    async renewLease({ credentialId, tokenHash, fenceToken }) {
      const refused = (reason) => ({ ok: false, reason, expiresAt: null });

      const r = resolve(credentialId, tokenHash);
      if (!r.ok) return refused(r.reason);
      const cred = r.cred;
      if (!cred.slot_id) return refused('no_slot');

      const lease = activeLeaseForSlot(cred.slot_id);
      if (!lease) return refused('no_active_lease');
      // Equality, not "at least": guessing forward is refused as firmly as
      // presenting a superseded number.
      if (lease.fence_token !== fenceToken) return refused('stale_fence');
      if (Date.parse(lease.expires_at) <= at().getTime()) return refused('lease_expired');

      const cap = Date.parse(lease.acquired_at) + LEASE_CAP_MS;
      const target = Math.min(at().getTime() + LEASE_MS, cap);
      if (target <= Date.parse(lease.expires_at)) {
        return { ok: true, reason: 'lease_capped', expiresAt: lease.expires_at };
      }
      lease.expires_at = new Date(target).toISOString();
      record(cred, 'lease_renewed', lease.task_id, { fence: lease.fence_token });
      return { ok: true, reason: 'renewed', expiresAt: lease.expires_at };
    },

    async reportTask({ credentialId, tokenHash, fenceToken, disposition, reason }) {
      const refused = (why) => ({ ok: false, reason: why });

      if (!['completed', 'failed', 'released'].includes(disposition)) {
        return refused('malformed_request');
      }
      if (disposition === 'failed') {
        if (reason === null || !PAUSE_REASONS.includes(reason)) {
          return refused('failure_reason_required');
        }
      } else if (reason !== null) {
        return refused('unexpected_reason');
      }

      const r = resolve(credentialId, tokenHash);
      if (!r.ok) return refused(r.reason);
      const cred = r.cred;
      if (!cred.slot_id) return refused('no_slot');

      const lease = activeLeaseForSlot(cred.slot_id);
      // A replayed report finds nothing: the first one released the lease.
      if (!lease) return refused('no_active_lease');
      if (lease.fence_token !== fenceToken) return refused('stale_fence');
      if (Date.parse(lease.expires_at) <= at().getTime()) return refused('lease_expired');

      const task = tasks.get(lease.task_id);
      if (!task || !['leased', 'processing'].includes(task.status)) {
        return refused('task_not_active');
      }

      if (disposition === 'completed') {
        // `manual_review`, never `ready_to_submit`. A worker does not decide
        // that an application is ready to send.
        task.status = 'manual_review';
      } else if (disposition === 'failed') {
        task.status = 'failed';
        task.outcome = 'failed';
        task.finished_at = at().toISOString();
      } else {
        task.status = 'queued';
      }

      lease.released_at = at().toISOString();
      lease.release_reason = disposition === 'released' ? 'released' : disposition;

      record(cred, 'lease_released', task.id, { fence: lease.fence_token, disposition });
      if (disposition === 'completed') {
        record(cred, 'task_completed', task.id, { fence: lease.fence_token });
      } else if (disposition === 'failed') {
        record(cred, 'task_failed', task.id, { fence: lease.fence_token, reason });
      }

      return { ok: true, reason: disposition };
    },

    /**
     * The two registration events, as migration 28 writes them: inside the
     * redemption, one of each, never for a redemption that lost its race.
     *
     * Named rather than generic on purpose. A fake with a `recordEvent(kind)`
     * method would let a test write a kind the database would refuse, and the
     * test would pass.
     */
    recordRegistration({ userId, supervisorId, slotId, platform, agentVersion }) {
      events.push({
        id: uuid(), user_id: userId, supervisor_id: supervisorId, slot_id: null,
        task_id: null, kind: 'supervisor_registered',
        detail: { platform, agent_version: agentVersion },
        occurred_at: at().toISOString(),
      });
      events.push({
        id: uuid(), user_id: userId, supervisor_id: supervisorId, slot_id: slotId,
        task_id: null, kind: 'slot_registered', detail: { slot_index: 1 },
        occurred_at: at().toISOString(),
      });
    },

    /** One `supervisor_revoked`, and only where a row actually transitioned. */
    recordRevocation({ userId, supervisorId }) {
      events.push({
        id: uuid(), user_id: userId, supervisor_id: supervisorId, slot_id: null,
        task_id: null, kind: 'supervisor_revoked',
        detail: { reason: 'candidate_requested' },
        occurred_at: at().toISOString(),
      });
    },

    /** The pause/stop rules, applied to a slot row the caller owns. */
    applyReadiness(slot, readiness, reason) {
      if (readiness === 'paused') {
        if (reason === null || !PAUSE_REASONS.includes(reason)) return 'pause_reason_required';
        slot.pause_reason = reason;
        slot.stop_reason = null;
      } else if (readiness === 'stopping' || readiness === 'stopped') {
        if (reason === null || !STOP_REASONS.includes(reason)) return 'stop_reason_required';
        slot.pause_reason = null;
        slot.stop_reason = reason;
      } else {
        if (reason !== null) return 'unexpected_reason';
        // Both cleared: the constraint binds in this direction too, so a
        // resume cannot leave a stale reason behind.
        slot.pause_reason = null;
        slot.stop_reason = null;
      }
      slot.readiness = readiness;
      return null;
    },

    recordSlotTransition(cred, slot, previous, readiness, reason) {
      // On transition only. A worker beating every thirty seconds writes
      // nothing unless something actually changed.
      if (previous === readiness) return;
      const kind =
        readiness === 'paused'
          ? 'slot_paused'
          : readiness === 'stopping' || readiness === 'stopped'
            ? 'slot_stopped'
            : readiness === 'crashed'
              ? 'slot_crashed'
              : 'slot_heartbeat';
      record(cred, kind, null, reason === null ? {} : { reason });
    },
  };
}
