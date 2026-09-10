'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { PROFILE_ROUTE } from '@/lib/profile/routes';
import {
  describeWorker,
  requestRefusalText,
  type WorkerSituationInput,
} from '@/lib/profile/review';

/**
 * Asking your own computer to draft your profile.
 *
 * WHAT THIS SCREEN HAS TO BE HONEST ABOUT
 *
 * The work does not happen here. It happens in a worker the candidate runs on
 * their own machine, signed in to their own Claude subscription. That means
 * there are several ordinary ways for the request to go nowhere — no worker
 * paired, worker not running, slot paused, local Claude not installed or not
 * signed in — and every one of them looks identical from a page that only says
 * "something went wrong".
 *
 * So each is named, with the thing to do about it. A candidate who has not
 * started their worker should be told to start their worker.
 *
 * AND THERE IS NO SECOND ROUTE
 *
 * If the local worker cannot do it, nothing else does it instead. KIASA does
 * not quietly send the résumé to a hosted model because the laptop was asleep:
 * that would be a different decision about the candidate's data, made by an
 * error handler, without asking. The button stays unavailable and says why.
 *
 * The state-to-sentence mapping lives in `lib/profile/review.ts` so that every
 * branch of it can be tested, including the ones a person only reaches on a
 * bad day.
 */
export default function DraftRequest({
  worker,
  workerHref,
}: {
  /**
   * Read on the server by `lib/worker/status.ts`, under the candidate's own
   * session. `null` means the outbound schema refused the view, which reads to
   * a candidate as "we cannot tell" rather than as a shape they should see.
   *
   * Passed in rather than fetched on mount: the page is already doing an
   * authenticated read of the same tables, and a component that fetched its own
   * API would add a round trip, a flash of "checking…", and a `setState` inside
   * an effect for no gain.
   */
  worker: WorkerSituationInput | null;
  workerHref: string;
}) {
  const router = useRouter();
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const situation = describeWorker(worker);

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/profile/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        /*
         * CONSENT IS STATED IN THE REQUEST THAT USES IT — not read from a
         * setting saved last month. The worker checks it again on the machine
         * immediately before it starts a process, because that is where the
         * process actually starts and a stale agreement is not consent.
         */
        body: JSON.stringify({ mode: 'claude_max_assisted', local_consent: true }),
      });

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      const ok =
        payload !== null &&
        typeof payload === 'object' &&
        (payload as { ok?: unknown }).ok === true;

      if (!ok) {
        setError(requestRefusalText(payload));
        return;
      }
      router.refresh();
    } catch {
      setError('KIASA could not be reached. Nothing was started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kprof__form">
      <div className={`kprof__notice kprof__notice--${situation.tone}`}>
        <strong>{situation.headline}</strong>
        {situation.detail ? ` ${situation.detail}` : null}
        {situation.offerWorkerPage ? (
          <>
            {' '}
            <Link href={workerHref} className="kprof__back" style={{ margin: 0 }}>
              Open the worker page
            </Link>
            .
          </>
        ) : null}
      </div>

      <fieldset className="kprof__fieldset">
        <legend className="kprof__legend">Before it runs</legend>
        <p className="kprof__hint">
          KIASA will start Claude on your own computer, hand it the facts already read from your
          résumé, and ask it to propose values for twelve profile fields. It cannot browse, run
          commands, or read your files, and nothing it proposes reaches your profile until you
          have read it and said yes.
        </p>
        <label className="kprof__check" htmlFor="local_consent">
          <input
            type="checkbox"
            id="local_consent"
            checked={consented}
            disabled={busy}
            onChange={(e) => setConsented(e.target.checked)}
          />
          <span>I agree to KIASA running Claude on my computer for this.</span>
        </label>
      </fieldset>

      {error ? (
        <p className="kprof__notice kprof__notice--bad" role="alert">
          {error}
        </p>
      ) : null}

      <div className="kprof__actions">
        <button
          type="button"
          className="kprof__button"
          onClick={() => void request()}
          disabled={busy || !consented || !situation.ready}
        >
          {busy ? 'Asking…' : 'Ask my computer to draft this'}
        </button>
        <button
          type="button"
          className="kprof__button kprof__button--ghost"
          onClick={() => router.refresh()}
          disabled={busy}
        >
          Check my worker again
        </button>
      </div>

      {/*
        STATED, NOT IMPLIED. Someone whose worker will not start deserves to
        know this is a shortcut rather than the only way in, before they spend
        an afternoon on it.
      */}
      <p className="kprof__hint">
        This is a shortcut, not a requirement. Every field it would fill in can be typed directly
        on the{' '}
        <Link href={PROFILE_ROUTE} className="kprof__back" style={{ margin: 0 }}>
          profile page
        </Link>
        , and KIASA never sends your résumé anywhere else if your computer cannot do this.
      </p>
    </div>
  );
}
