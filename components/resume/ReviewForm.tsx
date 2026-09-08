'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { IDLE, type FormState } from '@/lib/candidate/form-state';
import type { ResumeExtraction } from '@/lib/resume/schema';
import {
  EXPERIENCE_EMPLOYMENT_TYPES,
  WORK_MODES,
  SKILL_PROFICIENCIES,
} from '@/lib/profile/schema';

/**
 * The review step.
 *
 * This screen is the entire argument for doing résumé import this way. A tool
 * that reads a PDF and announces "your profile is complete" has quietly turned
 * a machine's reading of a document into claims the person will make to real
 * employers. Here, everything found is shown, everything is editable, and
 * everything can be dropped — and nothing exists in the profile until the
 * button at the bottom is pressed.
 *
 * Three details carry most of the weight:
 *
 *   * Everything arrives TICKED. The common case is a résumé that read well,
 *     and making someone tick twelve boxes to accept their own history is
 *     hostile. The work is in making it easy to untick.
 *   * Anything the résumé did not state is shown as an empty box, never as a
 *     plausible guess. An empty box is an honest "we do not know this".
 *   * A date the résumé gave loosely says so, next to the date. "The résumé
 *     said 2019" is the difference between a stored approximation the person
 *     agreed to and one they never noticed.
 */

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="kprof__button" disabled={pending}>
      {pending ? 'Adding to your profile…' : 'Confirm and add to my profile'}
    </button>
  );
}

/** "the résumé said 2019" — shown only when the page was less precise than a day. */
function Approx({ date, precision }: { date: string | null; precision: string | null }) {
  if (!date || !precision || precision === 'day') return null;
  const year = date.slice(0, 4);
  const month = new Date(`${date}T00:00:00Z`).toLocaleString('en-GB', {
    month: 'long',
    timeZone: 'UTC',
  });
  return (
    <span className="kresume__approx">
      the résumé said {precision === 'year' ? year : `${month} ${year}`}
    </span>
  );
}

function Field({
  label,
  name,
  value,
  type = 'text',
  placeholder,
  wide,
}: {
  label: string;
  name: string;
  value: string | null;
  type?: string;
  placeholder?: string;
  wide?: boolean;
}) {
  return (
    <div className={`kprof__field${wide ? ' kprof__field--wide' : ''}`}>
      <label className="kprof__label" htmlFor={name}>
        {label}
      </label>
      <input
        className="kprof__input"
        id={name}
        name={name}
        type={type}
        defaultValue={value ?? ''}
        placeholder={placeholder}
      />
    </div>
  );
}

function Choice({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: string;
  value: string | null;
  options: readonly string[];
}) {
  return (
    <div className="kprof__field">
      <label className="kprof__label" htmlFor={name}>
        {label}
      </label>
      <select className="kprof__select" id={name} name={name} defaultValue={value ?? ''}>
        {/* "Not stated" is the first option and the default, because that is
            what a résumé most often is on these fields. */}
        <option value="">Not stated</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * One entry, with its own tick box.
 *
 * Unticking greys the entry out rather than removing it: a list that shrinks
 * under the cursor makes it hard to tell what you just did, and reversing a
 * mistake should not require re-reading the whole page.
 */
function Entry({
  prefix,
  index,
  title,
  subtitle,
  children,
}: {
  prefix: string;
  index: number;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const [included, setIncluded] = useState(true);
  const id = `${prefix}.${index}.include`;

  return (
    <section className={`kresume__entry${included ? '' : ' kresume__entry--out'}`}>
      <header className="kresume__entryHead">
        <label className="kresume__toggle" htmlFor={id}>
          <input
            type="checkbox"
            id={id}
            name={id}
            checked={included}
            onChange={(e) => setIncluded(e.target.checked)}
          />
          <span>
            <strong>{title}</strong>
            {subtitle ? <span className="kresume__entrySub">{subtitle}</span> : null}
          </span>
        </label>
        <span className="kresume__entryState">{included ? 'Keeping' : 'Skipping'}</span>
      </header>

      {/* Kept mounted while unticked so the choice is reversible without losing
          any edit already made; `disabled` inputs are omitted from the POST, so
          an unticked entry cannot be submitted by accident either. */}
      <fieldset className="kresume__entryBody" disabled={!included}>
        {children}
      </fieldset>
    </section>
  );
}

export default function ReviewForm({
  importId,
  draft,
  action,
}: {
  importId: string;
  draft: ResumeExtraction;
  action: (prev: FormState, form: FormData) => Promise<FormState>;
}) {
  const [state, formAction] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="kprof__form">
      <input type="hidden" name="import_id" value={importId} />
      <input type="hidden" name="experience_count" value={draft.work_experiences.length} />
      <input type="hidden" name="education_count" value={draft.education_entries.length} />
      <input type="hidden" name="skill_count" value={draft.skills.length} />

      {!state.ok && state.message ? (
        <p className="kprof__notice kprof__notice--bad" role="alert">
          {state.message}
        </p>
      ) : null}

      {/* ---------------------------------------------------------- about you */}
      <fieldset className="kprof__fieldset">
        <legend className="kprof__legend">About you</legend>
        <div className="kprof__grid">
          <Field label="First name" name="legal_first_name" value={draft.legal_first_name} />
          <Field label="Middle name" name="legal_middle_name" value={draft.legal_middle_name} />
          <Field label="Last name" name="legal_last_name" value={draft.legal_last_name} />
          <Field label="Preferred name" name="preferred_name" value={draft.preferred_name} />
          <Field
            label="Contact email"
            name="contact_email"
            value={draft.contact_email}
            type="email"
          />
          <Field
            label="Phone"
            name="phone_e164"
            value={draft.phone_e164}
            placeholder="+447700900123"
          />
          <Field label="City" name="city" value={draft.city} />
          <Field label="State or region" name="state_region" value={draft.state_region} />
          <Field
            label="Country"
            name="country_code"
            value={draft.country_code}
            placeholder="Two letters, e.g. GB"
          />
          <Field label="LinkedIn" name="linkedin_url" value={draft.linkedin_url} wide />
          <Field label="GitHub" name="github_url" value={draft.github_url} wide />
          <Field label="Portfolio" name="portfolio_url" value={draft.portfolio_url} wide />
        </div>
        <p className="kprof__hint">
          Anything blank is something the résumé did not state. Leaving it blank is fine — it
          will not overwrite anything already on your profile.
        </p>
      </fieldset>

      {/* -------------------------------------------------------- experience */}
      {draft.work_experiences.length > 0 ? (
        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">
            Work experience · {draft.work_experiences.length} found
          </legend>

          {draft.work_experiences.map((exp, i) => (
            <Entry
              key={i}
              prefix="exp"
              index={i}
              title={exp.job_title}
              subtitle={exp.company_name}
            >
              <div className="kprof__grid">
                <Field label="Company" name={`exp.${i}.company_name`} value={exp.company_name} />
                <Field label="Job title" name={`exp.${i}.job_title`} value={exp.job_title} />

                <div className="kprof__field">
                  <label className="kprof__label" htmlFor={`exp.${i}.start_date`}>
                    Started <Approx date={exp.start_date} precision={exp.start_date_precision} />
                  </label>
                  <input
                    className="kprof__input"
                    id={`exp.${i}.start_date`}
                    name={`exp.${i}.start_date`}
                    type="date"
                    defaultValue={exp.start_date ?? ''}
                  />
                </div>

                <div className="kprof__field">
                  <label className="kprof__label" htmlFor={`exp.${i}.end_date`}>
                    Ended <Approx date={exp.end_date} precision={exp.end_date_precision} />
                  </label>
                  <input
                    className="kprof__input"
                    id={`exp.${i}.end_date`}
                    name={`exp.${i}.end_date`}
                    type="date"
                    defaultValue={exp.end_date ?? ''}
                  />
                </div>

                <Field label="City" name={`exp.${i}.location_city`} value={exp.location_city} />
                <Field
                  label="Country"
                  name={`exp.${i}.location_country_code`}
                  value={exp.location_country_code}
                  placeholder="e.g. GB"
                />
                <Choice
                  label="Employment type"
                  name={`exp.${i}.employment_type`}
                  value={exp.employment_type}
                  options={EXPERIENCE_EMPLOYMENT_TYPES}
                />
                <Choice
                  label="Work mode"
                  name={`exp.${i}.work_mode`}
                  value={exp.work_mode}
                  options={WORK_MODES}
                />
              </div>

              <label className="kprof__check">
                <input
                  type="checkbox"
                  name={`exp.${i}.is_current`}
                  defaultChecked={exp.is_current}
                />
                <span>I still work here</span>
              </label>

              <div className="kprof__field kprof__field--wide">
                <label className="kprof__label" htmlFor={`exp.${i}.description`}>
                  What you did
                </label>
                <textarea
                  className="kprof__textarea"
                  id={`exp.${i}.description`}
                  name={`exp.${i}.description`}
                  rows={6}
                  defaultValue={exp.description ?? ''}
                />
              </div>

              {/* The precision the résumé actually had, carried through the form
                  so a round trip does not silently promote "2019" to a day. */}
              <input
                type="hidden"
                name={`exp.${i}.start_date_precision`}
                value={exp.start_date_precision ?? ''}
              />
              <input
                type="hidden"
                name={`exp.${i}.end_date_precision`}
                value={exp.end_date_precision ?? ''}
              />
            </Entry>
          ))}
        </fieldset>
      ) : null}

      {/* --------------------------------------------------------- education */}
      {draft.education_entries.length > 0 ? (
        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">
            Education · {draft.education_entries.length} found
          </legend>

          {draft.education_entries.map((edu, i) => (
            <Entry
              key={i}
              prefix="edu"
              index={i}
              title={edu.institution_name}
              subtitle={[edu.degree, edu.field_of_study].filter(Boolean).join(', ') || undefined}
            >
              <div className="kprof__grid">
                <Field
                  label="Institution"
                  name={`edu.${i}.institution_name`}
                  value={edu.institution_name}
                />
                <Field label="Degree" name={`edu.${i}.degree`} value={edu.degree} />
                <Field
                  label="Field of study"
                  name={`edu.${i}.field_of_study`}
                  value={edu.field_of_study}
                />
                <Field label="Grade" name={`edu.${i}.grade`} value={edu.grade} />

                <div className="kprof__field">
                  <label className="kprof__label" htmlFor={`edu.${i}.start_date`}>
                    Started <Approx date={edu.start_date} precision={edu.start_date_precision} />
                  </label>
                  <input
                    className="kprof__input"
                    id={`edu.${i}.start_date`}
                    name={`edu.${i}.start_date`}
                    type="date"
                    defaultValue={edu.start_date ?? ''}
                  />
                </div>

                <div className="kprof__field">
                  <label className="kprof__label" htmlFor={`edu.${i}.end_date`}>
                    Ended <Approx date={edu.end_date} precision={edu.end_date_precision} />
                  </label>
                  <input
                    className="kprof__input"
                    id={`edu.${i}.end_date`}
                    name={`edu.${i}.end_date`}
                    type="date"
                    defaultValue={edu.end_date ?? ''}
                  />
                </div>

                <Field label="City" name={`edu.${i}.location_city`} value={edu.location_city} />
                <Field
                  label="Country"
                  name={`edu.${i}.location_country_code`}
                  value={edu.location_country_code}
                  placeholder="e.g. GB"
                />
              </div>

              <label className="kprof__check">
                <input
                  type="checkbox"
                  name={`edu.${i}.is_current`}
                  defaultChecked={edu.is_current}
                />
                <span>I am still studying here</span>
              </label>

              <input
                type="hidden"
                name={`edu.${i}.start_date_precision`}
                value={edu.start_date_precision ?? ''}
              />
              <input
                type="hidden"
                name={`edu.${i}.end_date_precision`}
                value={edu.end_date_precision ?? ''}
              />
            </Entry>
          ))}
        </fieldset>
      ) : null}

      {/* ------------------------------------------------------------ skills */}
      {draft.skills.length > 0 ? (
        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">Skills · {draft.skills.length} found</legend>

          {draft.skills.map((skill, i) => (
            <Entry key={i} prefix="skill" index={i} title={skill.name}>
              <div className="kprof__grid">
                <Field label="Skill" name={`skill.${i}.name`} value={skill.name} />
                <Choice
                  label="Proficiency"
                  name={`skill.${i}.proficiency`}
                  value={skill.proficiency}
                  options={SKILL_PROFICIENCIES}
                />
                <Field
                  label="Years"
                  name={`skill.${i}.years_experience`}
                  value={skill.years_experience === null ? null : String(skill.years_experience)}
                  type="number"
                />
              </div>
            </Entry>
          ))}

          <p className="kprof__hint">
            A level is only shown where your résumé stated one. KIASA does not rank your skills
            for you.
          </p>
        </fieldset>
      ) : null}

      <div className="kprof__actions">
        <Submit />
      </div>
    </form>
  );
}
