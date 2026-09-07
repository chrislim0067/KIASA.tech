import type { Metadata } from 'next';

import ProfileShell from '@/components/profile/ProfileShell';
import ProfileForm from '@/components/profile/ProfileForm';
import { requireCandidate } from '@/lib/candidate/session';
import { addExperience, removeExperience } from '@/lib/candidate/actions';
import {
  listWorkExperiences,
  TEXT_LIMITS,
  WORK_MODES,
  EXPERIENCE_EMPLOYMENT_TYPES,
} from '@/lib/profile';

/**
 * /profile/experience — work history.
 *
 * At least one role is required: without it an application has nothing to say
 * about the candidate beyond their name.
 *
 * The vocabularies in the selects come from lib/profile/schema, which mirrors
 * the database CHECK constraints. Hand-typing the options here is how a select
 * ends up offering a value the database rejects.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Work experience | KIASA',
  robots: { index: false, follow: false },
};

const label = (value: string) => value.replace(/_/g, ' ');

function formatRange(start: string | null, end: string | null, current: boolean): string {
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  if (!start) return current ? 'Current' : '';
  return `${fmt(start)} — ${current ? 'present' : end ? fmt(end) : '?'}`;
}

export default async function ExperiencePage() {
  const { supabase, user } = await requireCandidate();
  const result = await listWorkExperiences(supabase, user.id);
  const rows = result.ok ? result.data : [];
  const L = TEXT_LIMITS.work_experiences;

  return (
    <ProfileShell
      title="Work experience"
      lede="Add the roles you want applications to draw on. Most recent first is easiest to read, but the order does not matter."
      email={user.email ?? null}
      back
    >
      {rows.length === 0 ? (
        <div className="kprof__empty" style={{ marginBottom: '1.5rem' }}>
          No roles yet. Add at least one — an application needs something to describe you with.
        </div>
      ) : (
        <ul className="kprof__list">
          {rows.map((row) => (
            <li className="kprof__item" key={row.id}>
              <span className="kprof__itemBody">
                <span className="kprof__itemTitle">
                  {row.job_title} · {row.company_name}
                </span>
                <span className="kprof__itemNote">
                  {formatRange(row.start_date, row.end_date, row.is_current)}
                  {row.employment_type ? ` · ${label(row.employment_type)}` : ''}
                  {row.work_mode ? ` · ${label(row.work_mode)}` : ''}
                  {row.location_city ? ` · ${row.location_city}` : ''}
                </span>
              </span>
              <form action={removeExperience}>
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
        Add a role
      </h2>

      <ProfileForm action={addExperience} submitLabel="Add role" busyLabel="Adding…">
        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">The job</legend>
          <div className="kprof__grid">
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="job_title">
                Job title <span className="kprof__req">· required</span>
              </label>
              <input
                id="job_title"
                name="job_title"
                className="kprof__input"
                maxLength={L.job_title}
                required
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="company_name">
                Company <span className="kprof__req">· required</span>
              </label>
              <input
                id="company_name"
                name="company_name"
                className="kprof__input"
                maxLength={L.company_name}
                required
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="employment_type">
                Employment type
              </label>
              <select id="employment_type" name="employment_type" className="kprof__select" defaultValue="">
                <option value="">Not stated</option>
                {EXPERIENCE_EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {label(t)}
                  </option>
                ))}
              </select>
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="work_mode">
                Work mode
              </label>
              <select id="work_mode" name="work_mode" className="kprof__select" defaultValue="">
                <option value="">Not stated</option>
                {WORK_MODES.map((m) => (
                  <option key={m} value={m}>
                    {label(m)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </fieldset>

        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">When and where</legend>
          <div className="kprof__grid">
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="start_date">
                Started
              </label>
              <input id="start_date" name="start_date" type="date" className="kprof__input" />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="end_date">
                Ended
              </label>
              <input id="end_date" name="end_date" type="date" className="kprof__input" />
              <span className="kprof__hint">Leave blank if this is your current role.</span>
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="location_city">
                City
              </label>
              <input
                id="location_city"
                name="location_city"
                className="kprof__input"
                maxLength={L.location_city}
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="location_country_code">
                Country
              </label>
              <input
                id="location_country_code"
                name="location_country_code"
                className="kprof__input"
                maxLength={2}
                placeholder="GB"
                style={{ textTransform: 'uppercase' }}
              />
            </div>
            <div className="kprof__field kprof__field--wide">
              <label className="kprof__check">
                <input type="checkbox" name="is_current" />
                <span>I still work here</span>
              </label>
            </div>
          </div>
        </fieldset>

        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">What you did</legend>
          <div className="kprof__field">
            <label className="kprof__label" htmlFor="description">
              Description
            </label>
            <textarea
              id="description"
              name="description"
              className="kprof__textarea"
              maxLength={L.description}
              placeholder="What you were responsible for, and what changed because you were there."
            />
            <span className="kprof__hint">
              Written once here, reused across applications. Specifics beat adjectives.
            </span>
          </div>
        </fieldset>
      </ProfileForm>
    </ProfileShell>
  );
}
