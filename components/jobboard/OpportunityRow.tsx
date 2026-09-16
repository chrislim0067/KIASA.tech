'use client';

import type { JobOpportunity } from '@/lib/jobboard/types';
import { formatSalary, formatExperience, relativeDate, humanise } from '@/lib/jobboard/format';

/**
 * One posting, as an opportunity.
 *
 * TYPED TO `JobOpportunity`, NOT `JobSummary`, and that is the guarantee rather
 * than a convention: there is no `owner_email` to print, no `status` to colour
 * and no `has_notes` to flag, because the type does not carry them and the
 * query never selected them. Rendering somebody's pipeline here would not be a
 * mistake a reviewer has to catch — it would not compile.
 *
 * A button rather than a link, matching the administrator row: the whole card
 * is the target, and a nested anchor for the posting URL would sit inside it.
 * The external link lives on the detail page instead.
 */
export default function OpportunityRow({
  job,
  onOpen,
}: {
  job: JobOpportunity;
  onOpen: () => void;
}) {
  const salary = formatSalary(job);
  const experience = formatExperience(job);
  const employment = humanise(job.employment_type);

  /* Initials when the posting carried no logo. Two letters, from the company
     name the extraction found — never from the domain, which is a brand nobody
     chose to display. */
  const initials = (job.company ?? '')
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <button type="button" className="kjb__row" onClick={onOpen}>
      <span className="kjb__mark">
        {job.company_logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={job.company_logo_url} alt="" loading="lazy" />
        ) : (
          <span className="kjb__markText">{initials || '—'}</span>
        )}
      </span>

      <span className="kjb__main">
        <span className="kjb__title">{job.title ?? 'Untitled posting'}</span>
        <span className="kjb__company">
          {job.company ?? job.domain}
          {job.location ? ` · ${job.location}` : ''}
        </span>

        <span className="kjb__facts">
          {job.workplace_type ? (
            <span className="kjb__fact">{humanise(job.workplace_type)}</span>
          ) : null}
          {employment ? <span className="kjb__fact">{employment}</span> : null}
          {experience ? <span className="kjb__fact">{experience}</span> : null}
          {job.sponsorship_available ? <span className="kjb__fact">Sponsors visas</span> : null}
          {job.security_clearance_required ? (
            <span className="kjb__fact">Clearance required</span>
          ) : null}
        </span>

        {job.skills.length > 0 ? (
          <span className="kjb__skills">
            {job.skills.slice(0, 8).map((skill) => (
              <span key={skill} className="kjb__skill">
                {skill}
              </span>
            ))}
            {job.skills.length > 8 ? (
              <span className="kjb__skill">+{job.skills.length - 8}</span>
            ) : null}
          </span>
        ) : null}
      </span>

      <span className="kjb__aside">
        {salary ? <span className="kjb__salary">{salary}</span> : null}
        <span className="kjb__when">{relativeDate(job.saved_at)}</span>
      </span>
    </button>
  );
}
