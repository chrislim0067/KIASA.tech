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
        setError('Could not start pairing. Please try again.');
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

  return (
    <div className="kprof__fieldset">
      <p className="kprof__hint">
        <strong>{copy.label}.</strong> {copy.detail}
      </p>

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
