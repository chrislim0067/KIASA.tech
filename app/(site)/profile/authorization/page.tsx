import type { Metadata } from 'next';

import ProfileShell from '@/components/profile/ProfileShell';
import ProfileForm from '@/components/profile/ProfileForm';
import { requireCandidate } from '@/lib/candidate/session';
import { saveAuthorization, removeAuthorization } from '@/lib/candidate/actions';
import { listWorkAuthorizations } from '@/lib/profile';

/**
 * /profile/authorization — right to work, per country.
 *
 * The strictest fact in the system. A missing row means UNKNOWN, never "not
 * authorised", because inventing a "no" on a legal attestation is worse than
 * stopping to ask. That distinction is stated on the page, because a candidate
 * who does not understand it will assume silence means something.
 *
 * All three booleans are submitted every time. They are NOT NULL precisely so a
 * half-answered row cannot exist: leaving a box unchecked is a stated "no", not
 * an omission.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Work authorisation | KIASA',
  robots: { index: false, follow: false },
};

export default async function AuthorizationPage() {
  const { supabase, user } = await requireCandidate();
  const result = await listWorkAuthorizations(supabase, user.id);
  const rows = result.ok ? result.data : [];

  return (
    <ProfileShell
      title="Work authorisation"
      lede="Which countries you can legally work in. Add one row per country."
      email={user.email ?? null}
      back
    >
      <div className="kprof__notice kprof__notice--warn" style={{ marginBottom: '1.5rem' }}>
        <strong>A country you do not list is treated as unknown, not as “no”.</strong> KIASA will
        stop and ask rather than answer a right-to-work question on your behalf.
      </div>

      {rows.length === 0 ? (
        <div className="kprof__empty" style={{ marginBottom: '1.5rem' }}>
          Nothing recorded yet.
        </div>
      ) : (
        <ul className="kprof__list">
          {rows.map((row) => (
            <li className="kprof__item" key={row.id}>
              <span className="kprof__itemBody">
                <span className="kprof__itemTitle">
                  {row.country_code} — {row.is_authorized ? 'authorised to work' : 'not authorised'}
                </span>
                <span className="kprof__itemNote">
                  {row.sponsorship_required_now ? 'Needs sponsorship now' : 'No sponsorship needed now'}
                  {' · '}
                  {row.sponsorship_required_future
                    ? 'will need sponsorship in future'
                    : 'no future sponsorship needed'}
                  {row.basis ? ` · ${row.basis}` : ''}
                </span>
              </span>
              <form action={removeAuthorization}>
                <input type="hidden" name="id" value={row.id} />
                <button type="submit" className="kprof__button kprof__button--danger">
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <h2 className="kprof__legend" style={{ margin: '0 0 0.75rem' }}>
        Add or update a country
      </h2>

      <ProfileForm action={saveAuthorization} submitLabel="Save authorisation">
        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">Country</legend>
          <div className="kprof__grid">
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="country_code">
                Country code <span className="kprof__req">· required</span>
              </label>
              <input
                id="country_code"
                name="country_code"
                className="kprof__input"
                maxLength={2}
                placeholder="GB"
                required
                style={{ textTransform: 'uppercase' }}
              />
              <span className="kprof__hint">
                Two letters, e.g. GB, US, SG. Saving the same country again updates it.
              </span>
            </div>
            <div className="kprof__field kprof__field--wide">
              <label className="kprof__label" htmlFor="basis">
                Basis (optional)
              </label>
              <input
                id="basis"
                name="basis"
                className="kprof__input"
                maxLength={500}
                placeholder="Citizen, permanent resident, Skilled Worker visa…"
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">Status</legend>
          <p className="kprof__hint" style={{ marginBottom: '0.9rem' }}>
            Leaving a box unchecked records a definite “no”, not “unsure”. If you are not certain,
            do not save this country yet.
          </p>
          <div className="kprof__checks" style={{ flexDirection: 'column', gap: '0.7rem' }}>
            <label className="kprof__check">
              <input type="checkbox" name="is_authorized" />
              <span>I am legally authorised to work in this country</span>
            </label>
            <label className="kprof__check">
              <input type="checkbox" name="sponsorship_required_now" />
              <span>I need visa sponsorship now</span>
            </label>
            <label className="kprof__check">
              <input type="checkbox" name="sponsorship_required_future" />
              <span>I will need sponsorship in the future</span>
            </label>
          </div>
        </fieldset>
      </ProfileForm>
    </ProfileShell>
  );
}
