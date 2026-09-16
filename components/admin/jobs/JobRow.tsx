'use client';

import type { ReactNode } from 'react';

import { JOB_STATUS_LABELS, type JobSummary } from '@/lib/jobboard/types';
import {
  formatExperience,
  formatSalary,
  hostOf,
  humanise,
  relativeDate,
  seniorityOf,
} from '@/lib/jobboard/format';
import CompanyMark from './CompanyMark';
import ConfidenceRing from './ConfidenceRing';
import { IconBadge, IconChart, IconClock, IconHome, IconMoney, IconPin } from './icons';

/**
 * One job in the list.
 *
 * Laid out as a record card rather than a text block: logo, then a badge strip,
 * then the title, then a COLUMN-ALIGNED fact grid. The alignment is the point —
 * scanning twenty of these for salary means the eye should travel straight down
 * one column, which a wrapping inline list never allows.
 *
 * READ ONLY, unlike the candidate-facing board this is modelled on. There is no
 * status dropdown and no delete: this is a window onto someone else's pipeline,
 * and an administrator moving a candidate's job from "interviewing" to
 * "rejected" is a product decision nobody has made. The status shows as a pill
 * because it is information, not a control.
 *
 * The whole card is the target. Clicking anywhere that is not itself a control
 * opens the job, because hunting for the one underlined word is a tax paid on
 * every row. The title stays a real link so Ctrl-click, middle-click and the
 * keyboard all keep working; wrapping the card in an `<a>` would have been
 * simpler but nests other links inside a link, which is invalid.
 */
export default function JobRow({ job, onOpen }: { job: JobSummary; onOpen: () => void }) {
  const salary = formatSalary(job);
  const experience = formatExperience(job);
  const skills = job.skills.slice(0, 8);
  const extra = job.skills.length - skills.length;
  const host = hostOf(job.url);

  // When the extractor recovered no company the board fell back to the host,
  // which then printed "job-boards.greenhouse.io / job-boards.greenhouse.io".
  // Showing the host once, as the source, is honest; showing it twice as though
  // it were the employer's name is not.
  const companyName = job.company ?? host;
  const showHost = companyName !== host;

  return (
    <article
      className="kjobs__card"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a, button, select, input, label')) return;
        onOpen();
      }}
    >
      <div className="kjobs__cardBody">
        <CompanyMark src={job.company_logo_url} name={companyName} />

        <div className="kjobs__cardContent">
          <div className="kjobs__badges">
            <span className="kjobs__badge">{relativeDate(job.saved_at)}</span>
            {job.provider ? (
              <span className="kjobs__badge kjobs__badge--accent">{job.provider}</span>
            ) : null}
            {job.provider_job_id ? (
              <span className="kjobs__badge kjobs__badge--mono" title="Requisition number">
                #{job.provider_job_id}
              </span>
            ) : null}
            {job.workplace_type === 'remote' ? (
              <span className="kjobs__badge kjobs__badge--good">Remote</span>
            ) : null}
            {job.sponsorship_available === true ? (
              <span className="kjobs__badge kjobs__badge--good">Sponsors visas</span>
            ) : null}
            {job.security_clearance_required === true ? (
              <span className="kjobs__badge kjobs__badge--warn">Clearance</span>
            ) : null}
            {job.has_notes ? <span className="kjobs__badge">Has note</span> : null}
          </div>

          <a
            className="kjobs__cardTitle"
            href={`/admin/jobs/${job.id}`}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              onOpen();
            }}
          >
            {job.title ?? 'Untitled posting'}
          </a>

          <p className="kjobs__org">
            <span className="kjobs__company">{companyName}</span>
            {showHost ? (
              <>
                <span className="kjobs__sep">/</span>
                <span className="kjobs__domain">{host}</span>
              </>
            ) : null}
          </p>

          <dl className="kjobs__grid">
            <Fact icon={<IconPin />} value={job.location} />
            <Fact icon={<IconClock />} value={humanise(job.employment_type)} cap />
            <Fact icon={<IconMoney />} value={salary} strong />
            <Fact icon={<IconHome />} value={job.workplace_type} cap />
            <Fact icon={<IconBadge />} value={seniorityOf(job.title)} />
            <Fact icon={<IconChart />} value={experience} />
          </dl>

          {skills.length > 0 ? (
            <div className="kjobs__skills">
              {skills.map((skill) => (
                <span key={skill} className="kjobs__chip">
                  {skill}
                </span>
              ))}
              {extra > 0 ? (
                <span className="kjobs__chip kjobs__chip--muted">+{extra}</span>
              ) : null}
            </div>
          ) : null}

          <footer className="kjobs__cardFoot">
            <span className={`kjobs__status kjobs__status--${job.status}`}>
              {JOB_STATUS_LABELS[job.status]}
            </span>

            {/* Whose pipeline this is. The reason the administrator view needs
                it at all: a board of everyone's postings with no owner on the
                row is a list of jobs belonging to nobody. */}
            <span className="kjobs__owner" title={job.owner_email ?? 'Owner unknown'}>
              {job.owner_email ?? 'Unknown owner'}
            </span>

            <a
              className="kadmin__button kadmin__button--small kadmin__button--ghost"
              href={job.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => event.stopPropagation()}
            >
              Open posting ↗
            </a>
          </footer>
        </div>
      </div>

      <aside className="kjobs__score">
        <ConfidenceRing value={job.extraction_confidence} />
        <ul className="kjobs__reasons">
          {job.provider ? (
            <li>✓ {job.provider} adapter</li>
          ) : (
            <li className="kjobs__dim">Generic extractor</li>
          )}
          {salary ? <li>✓ Salary stated</li> : <li className="kjobs__dim">No salary given</li>}
          {job.sponsorship_available === null ? (
            <li className="kjobs__dim">Sponsorship unstated</li>
          ) : (
            <li>✓ Sponsorship stated</li>
          )}
        </ul>
      </aside>
    </article>
  );
}

/**
 * One cell of the fact grid.
 *
 * Renders an EMPTY cell rather than collapsing when the value is missing, so
 * the columns stay aligned across every card in the list. A missing salary
 * leaves a gap where the salary would be, which reads correctly as "this
 * posting did not say" — unlike a dash, which reads as a value.
 */
function Fact({
  icon,
  value,
  strong,
  cap,
}: {
  icon: ReactNode;
  value: string | null | undefined;
  strong?: boolean;
  cap?: boolean;
}) {
  if (!value) return <dd className="kjobs__fact kjobs__fact--empty" />;
  const classes = ['kjobs__fact', strong ? 'kjobs__fact--salary' : '', cap ? 'kjobs__fact--cap' : ''];
  return (
    <dd className={classes.filter(Boolean).join(' ')}>
      {icon}
      <span title={value}>{value}</span>
    </dd>
  );
}
