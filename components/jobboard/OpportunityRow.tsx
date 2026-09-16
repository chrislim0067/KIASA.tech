'use client';

import Link from 'next/link';

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
 * TWO TARGETS, NO NESTED BUTTONS. The card opens the detail page and the link
 * opens the employer's posting, and an anchor inside a button is invalid HTML
 * that screen readers and middle-click both handle badly. So the card is a
 * plain element, the title is a real link, and CSS stretches that link over the
 * whole card (`.kjb__title::after`). "Open posting" sits above it on the
 * z-axis, which is what makes it a second target rather than a hole in the
 * first.
 *
 * EVERY CARD IS THE SAME HEIGHT. A posting with no salary, no location and no
 * skills is common — extraction is only ever as good as the page — and letting
 * each card shrink to its content produced a ragged list where nothing lined
 * up. Each slot is always rendered and reserves its space; missing values leave
 * their row empty rather than collapsing it.
 */

/**
 * A location with no letters or digits says nothing.
 *
 * Postings really do carry "-" and "—" in that field. Printing it produced
 * "Claritev · -", which reads as a bug rather than as an absence.
 */
function meaningful(value: string | null): string | null {
  if (!value) return null;
  return /[\p{L}\p{N}]/u.test(value) ? value : null;
}

export default function OpportunityRow({ job }: { job: JobOpportunity }) {
  const salary = formatSalary(job);
  const experience = formatExperience(job);
  const employment = humanise(job.employment_type);
  const location = meaningful(job.location);

  /* Initials when the posting carried no logo. Two letters, from the company
     name the extraction found — never from the domain, which is a brand nobody
     chose to display. */
  const initials = (job.company ?? '')
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

  const facts = [
    job.workplace_type ? humanise(job.workplace_type) : null,
    employment,
    experience,
    job.sponsorship_available ? 'Sponsors visas' : null,
    job.security_clearance_required ? 'Clearance required' : null,
  ].filter((f): f is string => Boolean(f));

  return (
    <article className="kjb__row">
      {/*
        The modifier drops the frame when there is a real logo. The border and
        tinted background exist to give the INITIALS something to sit in; behind
        an image they read as a gap around it.
      */}
      <span
        className={`kjb__mark${job.company_logo_url ? ' kjb__mark--logo' : ''}`}
        aria-hidden="true"
      >
        {job.company_logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={job.company_logo_url} alt="" loading="lazy" />
        ) : (
          <span className="kjb__markText">{initials || '—'}</span>
        )}
      </span>

      <div className="kjb__main">
        {/* The stretched link. Everything the card shows is inside it for a
            screen reader, so the accessible name is the title, not the wall of
            text that follows. */}
        <h3 className="kjb__title">
          <Link href={`/job-board/${job.id}`}>{job.title ?? 'Untitled posting'}</Link>
        </h3>

        <p className="kjb__company">
          {job.company ?? job.domain}
          {location ? ` · ${location}` : ''}
        </p>

        <p className="kjb__facts">
          {facts.map((fact) => (
            <span key={fact} className="kjb__fact">
              {fact}
            </span>
          ))}
        </p>

        <p className="kjb__skills">
          {job.skills.slice(0, 6).map((skill) => (
            <span key={skill} className="kjb__skill">
              {skill}
            </span>
          ))}
          {job.skills.length > 6 ? (
            <span className="kjb__skill kjb__skill--more">+{job.skills.length - 6}</span>
          ) : null}
        </p>
      </div>

      <div className="kjb__aside">
        {/* Always rendered, empty when there is no figure, so the date below it
            sits at the same height on every card. */}
        <span className="kjb__salary">{salary ?? ''}</span>
        <span className="kjb__when">{relativeDate(job.saved_at)}</span>

        {job.url ? (
          /*
           * rel="noreferrer" as well as noopener: the referrer would tell the
           * employer's site that somebody arrived from KIASA, which is the
           * candidate's business and nobody else's.
           */
          <a
            className="kjb__open"
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            /*
             * "Apply" is where this LEADS, not something KIASA does. The link
             * opens the employer's own posting in a new tab and the candidate
             * applies there, in their own name — nothing is submitted on their
             * behalf, here or anywhere else in the product. The title says so,
             * because a button labelled Apply invites exactly that assumption.
             */
            title="Opens the employer's posting in a new tab — you apply there"
            onClick={(event) => event.stopPropagation()}
          >
            Apply ↗
          </a>
        ) : null}
      </div>
    </article>
  );
}
