'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The candidate's view of their own worker.
 *
 * A CLIENT COMPONENT because the pairing code appears exactly once, in
 * response to a click, and must not survive a page refresh. It is held in
 * React state and nowhere else: not in the URL, not in localStorage, not in a
 * cookie. Reloading the page loses it, which is the correct behaviour — a code
 * you can retrieve later is a code someone else can retrieve later.
 *
 * It never receives a worker credential. The status endpoint returns status
 * only, and the database does not grant this browser the privilege to read the
 * hash columns even for its own rows.
 */

type Status = 'not_paired' | 'online' | 'stale' | 'revoked' | 'expired';

interface WorkerView {
  status: Status;
  supervisor_id: string | null;
  slot_index: number | null;
  slot_readiness: string | null;
  pause_reason: string | null;
  stop_reason: string | null;
  last_heartbeat_at: string | null;
  paired_at: string | null;
  expires_at: string | null;
}

const STATUS_COPY: Record<Status, { label: string; detail: string }> = {
  not_paired: {
    label: 'Not connected',
    detail: 'No worker is paired with your account yet.',
  },
  online: {
    label: 'Online',
    detail: 'Your computer checked in recently.',
  },
  stale: {
    label: 'Not responding',
    detail:
      'Paired, but your computer has not checked in lately. It may be asleep, offline, or the worker may have stopped.',
  },
  revoked: {
    label: 'Turned off',
    detail: 'You revoked this worker. Pair again to reconnect.',
  },
  expired: {
    label: 'Expired',
    detail: 'The connection has aged out. Pair again to reconnect.',
  },
};

/**
 * Why a slot stopped, in words.
 *
 * EVERY KEY IS A VALUE THE DATABASE CONSTRAINS. The slot's `pause_reason` and
 * `stop_reason` columns are CHECK-constrained to these exact strings, so this
 * map is total and nothing arbitrary can reach a screen. An unrecognised value
 * — which would mean the vocabulary grew without this map — falls back to a
 * sentence that says something true rather than showing the raw token.
 */
const REASON_COPY: Record<string, string> = {
  // Waiting for something a person must do.
  employer_authentication_required: 'The employer’s site wants you to sign in.',
  claude_authentication_required: 'Claude on your computer needs you to sign in again.',
  captcha_detected: 'The site showed a CAPTCHA. KIASA does not solve those.',
  anti_bot_challenge_detected: 'The site showed a bot check. KIASA stopped rather than push past it.',
  mfa_required: 'The site asked for a second factor. Only you can provide that.',
  sensitive_information_requested: 'The form asked for something sensitive, so KIASA stopped.',
  unknown_page: 'KIASA did not recognise the page and stopped rather than guess.',
  unknown_question: 'A question came up that KIASA has no answer for.',
  unsupported_site: 'This site is not one KIASA knows how to use.',
  control_plane_paused: 'Paused from here.',
  // Ending.
  candidate_requested: 'You asked it to stop.',
  kill_switch: 'The kill switch was used.',
  supervisor_shutdown: 'The worker shut down normally.',
  slot_crashed: 'The worker slot crashed.',
  lease_lost: 'The worker lost its claim on the task.',
  protocol_violation: 'The worker sent something the server refused.',
  update_required: 'The worker needs updating before it can run again.',
};

/**
 * Why an action was refused, in words.
 *
 * The server's refusal vocabulary is closed — see WORKER_OPERATION_FAILURES —
 * and each member gets a sentence. Nothing from an exception, a SQL error or a
 * response body is ever rendered: the key is looked up here or it is not shown.
 */
const REFUSAL_COPY: Record<string, string> = {
  registration_failed: 'Your computer could not be registered. Try pairing again.',
  pause_reason_required: 'The worker paused without saying why, so nothing was recorded.',
  stop_reason_required: 'The worker stopped without saying why, so nothing was recorded.',
  failure_reason_required: 'The worker reported a failure without naming a cause.',
  unexpected_reason: 'The worker sent a reason where none belongs.',
  slot_busy: 'That computer is already working on something.',
  no_task_available: 'There is nothing approved for it to work on.',
  no_active_lease: 'That work had already been handed back.',
  stale_fence: 'Another worker took over this task. The older one was refused.',
  lease_expired: 'The worker went quiet for too long and lost the task.',
  task_not_active: 'That task is no longer in progress.',
  attempts_exhausted: 'This task has been attempted too many times.',
  revoked: 'That connection was turned off.',
  expired: 'That connection has aged out.',
  refused: 'The server refused that. Nothing was changed.',
};

/** A refusal a person can read, or a neutral sentence — never a raw code. */
export function refusalCopy(reason: string | null): string | null {
  if (reason === null) return null;
  return REFUSAL_COPY[reason] ?? 'That could not be done. Nothing was changed.';
}

/** A pause or stop reason a person can read. */
export function reasonCopy(reason: string | null): string | null {
  if (reason === null) return null;
  return REASON_COPY[reason] ?? 'The worker stopped for a reason this page does not recognise.';
}

export default function WorkerPairingPanel() {
  const [worker, setWorker] = useState<WorkerView | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/worker/status', { cache: 'no-store' });
      const payload = await response.json();
      setWorker(payload?.ok ? payload.worker : null);
    } catch {
      /* a failed poll is not worth interrupting the page for */
    }
  }, []);

  useEffect(() => {
    /*
     * The first load runs on the same timer path as the polls rather than
     * directly in the effect body — which the lint rule forbids, and which was
     * also missing cancellation: an unmount mid-request would otherwise set
     * state on a component that is gone.
     */
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh();
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  const startPairing = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/worker/pair', { method: 'POST' });
      const payload = await response.json();
      if (!payload?.ok) {
        /*
         * The server sends a code from a closed list; `refusalCopy` turns it
         * into a sentence or into a neutral one. The code itself is never
         * rendered, and neither is anything else from the response.
         */
        setError(refusalCopy(typeof payload?.reason === 'string' ? payload.reason : null)
          ?? 'Could not start pairing. Please try again.');
        return;
      }
      setCode(payload.pairing_secret);
      void refresh();
    } catch {
      setError('Could not reach KIASA. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch('/api/worker/revoke', { method: 'POST' });
      setCode(null);
      void refresh();
    } catch {
      setError('Could not reach KIASA. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const status = worker?.status ?? 'not_paired';
  const copy = STATUS_COPY[status];

  /*
   * A sentence about the slot, or nothing. Built only from values the database
   * constrains — a readiness and a reason, each from a CHECK list — and looked
   * up in a map, so no server string is ever rendered directly.
   */
  const slotReason = reasonCopy(worker?.pause_reason ?? worker?.stop_reason ?? null);
  const slotSentence =
    worker?.slot_readiness === 'paused'
      ? `Paused. ${slotReason ?? ''}`.trim()
      : worker?.slot_readiness === 'stopped' || worker?.slot_readiness === 'stopping'
        ? `Stopped. ${slotReason ?? ''}`.trim()
        : worker?.slot_readiness === 'working'
          ? 'Working on a task.'
          : worker?.slot_readiness === 'crashed'
            ? 'The worker slot crashed. Pair again or restart it.'
            : null;

  return (
    <div className="kprof__fieldset">
      <p className="kprof__hint">
        <strong>{copy.label}.</strong> {copy.detail}
      </p>

      {/*
        THE SLOT IS SHOWN BESIDE THE PAIRING, NOT INSTEAD OF IT. An online
        worker whose slot is paused is still online; conflating the two would
        make "not responding" and "waiting for you" look the same, and they
        need different actions from a candidate.
      */}
      {slotSentence ? <p className="kprof__hint">{slotSentence}</p> : null}

      {worker?.last_heartbeat_at ? (
        <p className="kprof__hint">
          Last check-in: {new Date(worker.last_heartbeat_at).toLocaleString()}
        </p>
      ) : null}

      {code ? (
        <div className="kprof__field kprof__field--wide">
          <label className="kprof__label" htmlFor="pairing-code">
            Your pairing code
          </label>
          {/* readOnly, not disabled: a candidate needs to select and copy it. */}
          <input id="pairing-code" className="kprof__input" value={code} readOnly />
          <span className="kprof__hint">
            Shown once. Paste it into the worker on your computer within ten minutes. Refreshing
            this page will lose it — ask for another if that happens.
          </span>
        </div>
      ) : null}

      {error ? <p className="kprof__hint">{error}</p> : null}

      <div className="kprof__grid">
        <button type="button" className="kbtn" onClick={startPairing} disabled={busy}>
          {status === 'not_paired' ? 'Connect a computer' : 'Pair again'}
        </button>
        {status !== 'not_paired' && status !== 'revoked' ? (
          <button type="button" className="kbtn" onClick={revoke} disabled={busy}>
            Turn this worker off
          </button>
        ) : null}
      </div>
    </div>
  );
}
