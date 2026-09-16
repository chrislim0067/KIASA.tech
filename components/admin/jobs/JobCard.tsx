'use client';

import type { JobSummary } from '@/lib/jobboard/types';
import { formatSalary, relativeDate } from '@/lib/jobboard/format';
import CompanyMark from './CompanyMark';

/**
 * One job on the pipeline board.
 *
 * A `<button>` rather than a `<div>`, so the card is reachable and openable by
 * keyboard. Not draggable, unlike the candidate-facing board this is modelled
 * on: dragging a card between columns writes a status, and this surface does not
 * write. The columns here show the SHAPE of everyone's pipeline, which is a
 * thing to read, not to rearrange.
 */
export default function JobCard({ job, onOpen }: { job: JobSummary; onOpen: () => void }) {
  const salary = formatSalary(job);

  return (
    <button type="button" className="kjobs__tile" onClick={onOpen}>
      <span className="kjobs__tileHead">
        <CompanyMark
          src={job.company_logo_url}
          name={job.company ?? '?'}
          className="kjobs__tileLogo"
        />
        <span className="kjobs__tileNames">
          <span className="kjobs__tileTitle">{job.title ?? 'Untitled posting'}</span>
          {job.company ? <span className="kjobs__tileCompany">{job.company}</span> : null}
        </span>
      </span>

      <span className="kjobs__tileMeta">
        {job.location ? <span>{job.location}</span> : null}
        {job.workplace_type ? <span className="kjobs__tag">{job.workplace_type}</span> : null}
        {salary ? <span className="kjobs__tileSalary">{salary}</span> : null}
      </span>

      {/* The owner's address used to sit on the right of this row. It is gone
          for the reason given at the bottom of lib/jobboard/types.ts. */}
      <span className="kjobs__tileMeta kjobs__tileMeta--foot">
        <span>{relativeDate(job.saved_at)}</span>
        {job.has_notes ? <span className="kjobs__tileNote">Has a note</span> : null}
      </span>
    </button>
  );
}
