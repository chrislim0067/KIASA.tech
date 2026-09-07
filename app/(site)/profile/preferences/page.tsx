import type { Metadata } from 'next';

import ProfileShell from '@/components/profile/ProfileShell';
import ProfileForm from '@/components/profile/ProfileForm';
import { requireCandidate } from '@/lib/candidate/session';
import { savePreferences } from '@/lib/candidate/actions';
import {
  getJobPreferences,
  WORK_MODES,
  EMPLOYMENT_TYPES,
  SALARY_PERIODS,
  EXPERIENCE_LEVELS,
} from '@/lib/profile';

/**
 * /profile/preferences — what the candidate is looking for.
 *
 * These are PREFERENCES, and the copy says so. The absolute limits that must
 * never be crossed live in `automation_settings`, which is a separate table and
 * will be a separate screen: conflating "I would prefer remote" with "never
 * send me anything on-site" is how automation ends up doing something the
 * person never agreed to.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'What you are looking for | KIASA',
  robots: { index: false, follow: false },
};

const label = (v: string) => v.replace(/_/g, ' ');

export default async function PreferencesPage() {
  const { supabase, user } = await requireCandidate();
  const result = await getJobPreferences(supabase, user.id);
  const p = result.ok ? result.data : null;

  const has = (arr: readonly string[] | null | undefined, v: string) => (arr ?? []).includes(v);

  return (
    <ProfileShell
      title="What you are looking for"
      lede="Used to decide which jobs are worth showing you. Leaving something blank means no preference — it is never read as a refusal."
      email={user.email ?? null}
      back
    >
      <ProfileForm action={savePreferences} submitLabel="Save preferences">
        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">Roles</legend>
          <div className="kprof__grid">
            <div className="kprof__field kprof__field--wide">
              <label className="kprof__label" htmlFor="desired_titles">
                Job titles
              </label>
              <input
                id="desired_titles"
                name="desired_titles"
                className="kprof__input"
                defaultValue={(p?.desired_titles ?? []).join(', ')}
                placeholder="Frontend Engineer, Product Designer"
              />
              <span className="kprof__hint">Comma separated.</span>
            </div>
            <div className="kprof__field kprof__field--wide">
              <label className="kprof__label" htmlFor="desired_locations">
                Locations
              </label>
              <input
                id="desired_locations"
                name="desired_locations"
                className="kprof__input"
                defaultValue={(p?.desired_locations ?? []).join(', ')}
                placeholder="London, Singapore, Remote"
              />
              <span className="kprof__hint">Comma separated.</span>
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="desired_experience_level">
                Level
              </label>
              <select
                id="desired_experience_level"
                name="desired_experience_level"
                className="kprof__select"
                defaultValue={p?.desired_experience_level ?? ''}
              >
                <option value="">No preference</option>
                {EXPERIENCE_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {label(l)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </fieldset>

        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">How you want to work</legend>

          <div className="kprof__field" style={{ marginBottom: '1rem' }}>
            <span className="kprof__label">Work mode</span>
            <div className="kprof__checks">
              {WORK_MODES.map((m) => (
                <label className="kprof__check" key={m}>
                  <input
                    type="checkbox"
                    name="work_modes"
                    value={m}
                    defaultChecked={has(p?.work_modes, m)}
                  />
                  <span>{label(m)}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="kprof__field">
            <span className="kprof__label">Employment type</span>
            <div className="kprof__checks">
              {EMPLOYMENT_TYPES.map((t) => (
                <label className="kprof__check" key={t}>
                  <input
                    type="checkbox"
                    name="employment_types"
                    value={t}
                    defaultChecked={has(p?.employment_types, t)}
                  />
                  <span>{label(t)}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="kprof__field" style={{ marginTop: '1rem' }}>
            <label className="kprof__check">
              <input
                type="checkbox"
                name="willing_to_relocate"
                defaultChecked={p?.willing_to_relocate ?? false}
              />
              <span>I am willing to relocate</span>
            </label>
          </div>
        </fieldset>

        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">Pay</legend>
          <div className="kprof__grid">
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="desired_min_salary">
                Minimum
              </label>
              <input
                id="desired_min_salary"
                name="desired_min_salary"
                type="number"
                min="0"
                step="1000"
                className="kprof__input"
                defaultValue={p?.desired_min_salary ?? ''}
              />
              <span className="kprof__hint">What you would like, not a hard floor.</span>
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="salary_currency">
                Currency
              </label>
              <input
                id="salary_currency"
                name="salary_currency"
                className="kprof__input"
                maxLength={3}
                placeholder="GBP"
                defaultValue={p?.salary_currency ?? ''}
                style={{ textTransform: 'uppercase' }}
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="salary_period">
                Period
              </label>
              <select
                id="salary_period"
                name="salary_period"
                className="kprof__select"
                defaultValue={p?.salary_period ?? ''}
              >
                <option value="">Not stated</option>
                {SALARY_PERIODS.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </fieldset>
      </ProfileForm>
    </ProfileShell>
  );
}
