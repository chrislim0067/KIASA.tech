import type { Metadata } from 'next';

import ProfileShell from '@/components/profile/ProfileShell';
import ProfileForm from '@/components/profile/ProfileForm';
import { requireCandidate } from '@/lib/candidate/session';
import { addSkill, removeSkill } from '@/lib/candidate/actions';
import { listSkills, TEXT_LIMITS, SKILL_PROFICIENCIES } from '@/lib/profile';

/**
 * /profile/skills — optional, but almost every application form asks.
 *
 * Skills are unique per user case-insensitively (`unique (user_id, lower(name))`),
 * so "Go" and "go" collide. The action reports that as a field message rather
 * than a generic failure, because it is an expected outcome of typing rather
 * than an error.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Skills | KIASA',
  robots: { index: false, follow: false },
};

const label = (v: string) => v.replace(/_/g, ' ');

export default async function SkillsPage() {
  const { supabase, user } = await requireCandidate();
  const result = await listSkills(supabase, user.id);
  const rows = result.ok ? result.data : [];

  return (
    <ProfileShell
      title="Skills"
      lede="What you would want an application to list. Add them one at a time."
      email={user.email ?? null}
      back
    >
      {rows.length === 0 ? (
        <div className="kprof__empty" style={{ marginBottom: '1.5rem' }}>
          Nothing yet.
        </div>
      ) : (
        <ul className="kprof__list">
          {rows.map((row) => (
            <li className="kprof__item" key={row.id}>
              <span className="kprof__itemBody">
                <span className="kprof__itemTitle">{row.name}</span>
                <span className="kprof__itemNote">
                  {row.proficiency ? label(row.proficiency) : 'proficiency not stated'}
                  {row.years_experience !== null ? ` · ${row.years_experience} yr` : ''}
                </span>
              </span>
              <form action={removeSkill}>
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
        Add a skill
      </h2>

      <ProfileForm action={addSkill} submitLabel="Add skill" busyLabel="Adding…">
        <fieldset className="kprof__fieldset">
          <div className="kprof__grid">
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="name">
                Skill <span className="kprof__req">· required</span>
              </label>
              <input
                id="name"
                name="name"
                className="kprof__input"
                maxLength={TEXT_LIMITS.skills.name}
                required
                placeholder="TypeScript"
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="proficiency">
                Proficiency
              </label>
              <select id="proficiency" name="proficiency" className="kprof__select" defaultValue="">
                <option value="">Not stated</option>
                {SKILL_PROFICIENCIES.map((p) => (
                  <option key={p} value={p}>
                    {label(p)}
                  </option>
                ))}
              </select>
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="years_experience">
                Years
              </label>
              <input
                id="years_experience"
                name="years_experience"
                type="number"
                min="0"
                max="70"
                className="kprof__input"
              />
            </div>
          </div>
        </fieldset>
      </ProfileForm>
    </ProfileShell>
  );
}
