'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import type { FieldProposal, ProfileDraft, ProfileDraftField } from '@/lib/profile/draft';
import { PROFILE_ROUTE } from '@/lib/profile/routes';
import {
  buildConfirmBody,
  confirmRefusalText,
  FIELD_LABEL,
  initialDecisions,
  requiresExplicitConfirmation,
  type Decision,
} from '@/lib/profile/review';

/**
 * Reviewing what Claude proposed, one field at a time.
 *
 * NOTHING ON THIS SCREEN SAVES ANYTHING. Every control changes local state;
 * the only write is the single POST at the bottom, and the server re-checks
 * ownership, the profile version, and every value against the stored résumé
 * facts before it touches a profile row. Someone can accept all of it, none of
 * it, or type over any of it, and until they press the button their profile is
 * exactly as they left it.
 *
 * The rules — which boxes start ticked, what the request body contains, what a
 * refusal is turned into — all live in `lib/profile/review.ts`, so they are
 * tested as functions rather than asserted about by reading this file.
 */
export default function DraftReview({
  draftId,
  draft,
  current,
}: {
  draftId: string;
  draft: ProfileDraft;
  /** The profile as it stands, so the screen can show "now → proposed". */
  current: Partial<Record<ProfileDraftField, string | null>>;
}) {
  const router = useRouter();

  const [decisions, setDecisions] = useState<Record<string, Decision>>(() =>
    initialDecisions(draft, current)
  );
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = (field: string, next: Partial<Decision>) =>
    setDecisions((all) => {
      const before: Decision = all[field] ?? { accepted: false, edited: null };
      return { ...all, [field]: { ...before, ...next } };
    });

  const acceptedCount = buildConfirmBody(draftId, draft, decisions, 'confirm').accept.length;

  const send = async (action: 'confirm' | 'reject') => {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch('/api/profile/draft/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildConfirmBody(draftId, draft, decisions, action)),
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
        setError(confirmRefusalText(payload));
        return;
      }

      router.push(PROFILE_ROUTE);
      router.refresh();
    } catch {
      setError('KIASA could not be reached. Nothing was changed.');
    } finally {
      setBusy(null);
    }
  };

  const answered = draft.fields.filter((p) => p.value !== null).length;

  return (
    <div className="kprof__form">
      <p className="kprof__hint">
        Claude read your résumé on your own computer and suggested the values below. Nothing is
        saved until you press <strong>Save the ticked fields</strong>, and anything you leave
        unticked stays exactly as it is now.
      </p>

      {draft.warnings.length > 0 ? (
        <div className="kprof__notice kprof__notice--warn">
          {draft.warnings.map((warning) => (
            <p key={warning} style={{ margin: 0 }}>
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <fieldset className="kprof__fieldset">
        <legend className="kprof__legend">
          {answered} of {draft.fields.length} fields have a suggested value
        </legend>

        {draft.fields.map((proposal) => (
          <Proposal
            key={proposal.field}
            proposal={proposal}
            currently={current[proposal.field] ?? null}
            decision={decisions[proposal.field]}
            onDecide={(next) => decide(proposal.field, next)}
            disabled={busy !== null}
          />
        ))}
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
          onClick={() => void send('confirm')}
          disabled={busy !== null || acceptedCount === 0}
        >
          {busy === 'confirm' ? 'Saving…' : `Save the ticked fields (${acceptedCount})`}
        </button>
        <button
          type="button"
          className="kprof__button kprof__button--ghost"
          onClick={() => void send('reject')}
          disabled={busy !== null}
        >
          {busy === 'reject' ? 'Discarding…' : 'Discard the whole draft'}
        </button>
      </div>

      <p className="kprof__hint">
        Discarding changes nothing on your profile. It only marks this draft as read, so it stops
        appearing here.
      </p>
    </div>
  );
}

/**
 * One proposal, with its own tick box.
 *
 * Unticking greys the row rather than removing it, the same way the résumé
 * review does: a list that shrinks under the cursor makes it hard to tell what
 * you just did, and reversing a mistake should not mean re-reading the page.
 */
function Proposal({
  proposal,
  currently,
  decision,
  onDecide,
  disabled,
}: {
  proposal: FieldProposal;
  currently: string | null;
  decision: Decision | undefined;
  onDecide: (next: Partial<Decision>) => void;
  disabled: boolean;
}) {
  const label = FIELD_LABEL[proposal.field];
  const ticked = decision?.accepted ?? false;
  const id = `draft.${proposal.field}`;

  /*
   * A FIELD THE RÉSUMÉ DOES NOT ANSWER IS SHOWN AS UNKNOWN, NOT AS A BLANK.
   *
   * There is nothing to tick, nothing to edit and nothing that could be
   * written. Saying so out loud is the whole value of `null` being a real
   * answer in the draft schema rather than an absence — a model that could not
   * find a middle name said so instead of guessing one, and the person should
   * see that it said so.
   */
  if (proposal.value === null) {
    return (
      <section className="kresume__entry kresume__entry--out">
        <header className="kresume__entryHead">
          <span>
            <strong>{label}</strong>
            <span className="kresume__entrySub">
              Your résumé does not say, so this is left unknown. You can fill it in by hand on
              the profile page.
            </span>
          </span>
          <span className="kresume__entryState">Unknown</span>
        </header>
      </section>
    );
  }

  return (
    <section className={`kresume__entry${ticked ? '' : ' kresume__entry--out'}`}>
      <header className="kresume__entryHead">
        <label className="kresume__toggle" htmlFor={id}>
          <input
            type="checkbox"
            id={id}
            checked={ticked}
            disabled={disabled}
            onChange={(e) => onDecide({ accepted: e.target.checked })}
          />
          <span>
            <strong>{label}</strong>
            <span className="kresume__entrySub">
              {currently
                ? `Now “${currently}” — ticking this replaces it with “${proposal.value}”.`
                : `Empty at the moment. Ticking this sets it to “${proposal.value}”.`}
            </span>
          </span>
        </label>
        <span className="kresume__entryState">{ticked ? 'Saving' : 'Leaving as is'}</span>
      </header>

      <fieldset className="kresume__entryBody" disabled={!ticked || disabled}>
        <div className="kprof__field kprof__field--wide">
          <label className="kprof__label" htmlFor={`${id}.value`}>
            {label}
            {requiresExplicitConfirmation(proposal.field) ? (
              <span className="kresume__approx">identity — please read this one carefully</span>
            ) : null}
          </label>
          <input
            className="kprof__input"
            id={`${id}.value`}
            value={decision?.edited ?? proposal.value}
            disabled={!ticked || disabled}
            onChange={(e) => onDecide({ accepted: true, edited: e.target.value })}
          />

          {/*
            WHERE IT CAME FROM, AS A PATH.
            The draft schema only ever accepts a reference INTO the résumé facts
            — `contact_email`, `work_experiences[0].employer` — never a
            quotation. So there is no résumé prose to render here, by
            construction rather than by filtering.
          */}
          {proposal.source_facts.length > 0 ? (
            <p className="kprof__hint">
              Taken from {proposal.source_facts.map((p) => p.replace(/_/g, ' ')).join(', ')} in
              your résumé.
            </p>
          ) : null}

          {proposal.warnings.map((warning) => (
            <p key={warning} className="kprof__error">
              {warning}
            </p>
          ))}

          <p className="kprof__hint">
            Typing here replaces the suggestion with your own words. Untick the box to leave this
            field exactly as it is.
          </p>
        </div>
      </fieldset>
    </section>
  );
}
