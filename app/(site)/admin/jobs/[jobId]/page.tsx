import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import AdminShell from '@/components/admin/AdminShell';
import ConfidenceRing from '@/components/admin/jobs/ConfidenceRing';
import { requireAdminPage } from '@/lib/admin/page-guard';
import { isUuid } from '@/lib/admin/api';
import { getSavedJob } from '@/lib/jobboard/queries';
import { isJobBoardConfigured } from '@/lib/jobboard/env';
import { JOB_STATUS_LABELS } from '@/lib/jobboard/types';
import {
  formatDate,
  formatExperience,
  formatSalary,
  hostOf,
  humanise,
  seniorityOf,
} from '@/lib/jobboard/format';
import '@/styles/admin-jobs.css';

/**
 * /admin/jobs/[jobId] — one saved posting in full.
 *
 * The long-form content — description, responsibilities, qualifications — is
 * fetched only here. The list deliberately does not select those columns; a
 * description runs to several kilobytes and fetching it for every row turned a
 * page of a few dozen jobs into megabytes of transfer to render text the list
 * never shows.
 *
 * This is also the only place a candidate's private note is read, and only for
 * a job an administrator deliberately opened. The list reports that a note
 * exists and stops there.
 *
 * Everything on this page came off a public job posting, with one exception —
 * the note — which is called out as the owner's own writing rather than
 * presented alongside extracted facts as though it were one.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Posting | KIASA Admin',
  robots: { index: false, follow: false, nocache: true },
};

export default async function AdminJobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const ctx = await requireAdminPage('admin.access');
  const { jobId } = await params;

  // Rejected before it reaches a query. A malformed id would otherwise become a
  // PostgREST error whose message is not worth showing anyone.
  if (!isJobBoardConfigured() || !isUuid(jobId)) notFound();

  const job = await getSavedJob(jobId);
  if (!job) notFound();

  const salary = formatSalary(job);
  const experience = formatExperience(job);
  const host = hostOf(job.url);
  const companyName = job.company ?? host;
  const seniority = seniorityOf(job.title);

  return (
    <AdminShell
      title={job.title ?? 'Untitled posting'}
      lede={
        <>
          {companyName}
          {companyName !== host && host ? ` · ${host}` : ''}
          {' · saved by '}
          {job.owner_email ?? 'an unknown account'}
        </>
      }
      actorEmail={ctx.user.email ?? null}
      currentPath="/admin/jobs"
    >
      <Link href="/admin/jobs" className="kadmin__back">
        ← All postings
      </Link>

      <section className="kadmin__panel kjobs__detailHead">
        <div className="kjobs__detailFacts">
          <span className={`kjobs__status kjobs__status--${job.status}`}>
            {JOB_STATUS_LABELS[job.status]}
          </span>

          <dl className="kadmin__dl">
            <Row label="Owner" value={job.owner_email} />
            <Row label="Company" value={job.company} />
            <Row label="Location" value={job.location} />
            <Row label="Workplace" value={job.workplace_type} />
            <Row label="Employment" value={humanise(job.employment_type)} />
            <Row label="Seniority" value={seniority} />
            <Row label="Salary" value={salary} />
            <Row label="Experience" value={experience} />
            <Row
              label="Sponsorship"
              value={
                job.sponsorship_available === null
                  ? null
                  : job.sponsorship_available
                    ? 'Available'
                    : 'Not available'
              }
            />
            <Row
              label="Clearance"
              value={
                job.security_clearance_required === null
                  ? null
                  : job.security_clearance_required
                    ? 'Required'
                    : 'Not required'
              }
            />
            <Row label="Source" value={job.provider ?? host} />
            <Row label="Requisition" value={job.provider_job_id} />
            <Row label="Saved" value={formatDate(job.saved_at)} />
            <Row label="Applied" value={job.applied_at ? formatDate(job.applied_at) : null} />
          </dl>

          <a
            className="kadmin__button"
            href={job.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open original posting ↗
          </a>
        </div>

        <div className="kjobs__detailScore">
          <ConfidenceRing value={job.extraction_confidence} />
          <p className="kjobs__detailScoreNote">
            How much of the posting the extractor recovered — not a match score. Nothing here knows
            anything about a candidate.
          </p>
        </div>
      </section>

      {job.skills.length > 0 ? (
        <section className="kadmin__panel">
          <h2 className="kadmin__sectionTitle">Skills</h2>
          <div className="kjobs__skills">
            {job.skills.map((skill) => (
              <span key={skill} className="kjobs__chip">
                {skill}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <Bullets title="Responsibilities" items={job.responsibilities} />
      <Bullets title="Required qualifications" items={job.required_qualifications} />
      <Bullets title="Preferred qualifications" items={job.preferred_qualifications} />

      {job.description ? (
        <section className="kadmin__panel">
          <h2 className="kadmin__sectionTitle">Description</h2>
          {/*
            Rendered as TEXT, never as markup. The description is arbitrary
            content from an arbitrary employer's page: putting it through
            dangerouslySetInnerHTML would hand any job site a script tag on an
            administrator's authenticated session. `white-space: pre-wrap` in
            the stylesheet is what preserves its paragraphs.
          */}
          <p className="kjobs__description">{job.description}</p>
        </section>
      ) : null}

      {job.notes ? (
        <section className="kadmin__panel">
          <h2 className="kadmin__sectionTitle">Owner&rsquo;s note</h2>
          <p className="kadmin__lede">
            Written by {job.owner_email ?? 'the account holder'}, not extracted from the posting.
          </p>
          <p className="kjobs__description">{job.notes}</p>
        </section>
      ) : null}
    </AdminShell>
  );
}

/**
 * One definition row.
 *
 * Renders an em dash for a missing value rather than hiding the row, because on
 * a detail page the ABSENCE is itself information: "this posting did not state
 * a salary" is worth knowing, and a row that vanishes says nothing at all. The
 * list takes the opposite approach for the opposite reason.
 */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="kadmin__dlRow">
      <dt className="kadmin__dt">{label}</dt>
      <dd className={`kadmin__dd${value ? '' : ' kadmin__dd--muted'}`}>{value || '—'}</dd>
    </div>
  );
}

function Bullets({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="kadmin__panel">
      <h2 className="kadmin__sectionTitle">{title}</h2>
      <ul className="kadmin__list">
        {items.map((item, i) => (
          <li key={`${i}-${item.slice(0, 32)}`}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
