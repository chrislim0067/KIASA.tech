import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import ProfileShell from '@/components/profile/ProfileShell';
import { requireCandidate } from '@/lib/candidate/session';
import { resolveJobBoardAccess } from '@/lib/candidate/job-board';
import { getJobOpportunity } from '@/lib/jobboard/queries';
import { isJobBoardConfigured } from '@/lib/jobboard/env';
import { JOB_BOARD_LOCKED } from '@/lib/auth/job-board';
import { formatSalary, formatExperience, formatDate, humanise, hostOf } from '@/lib/jobboard/format';
import '@/styles/job-board.css';

/**
 * One opportunity, in full.
 *
 * THE GUARD RUNS HERE TOO, not only on the list. A detail page reached directly
 * by URL is the classic way past a check that lives one level up, and the id in
 * the path is guessable in the sense that it is a value somebody may have been
 * given. Both gates are re-awaited before a single field is read.
 *
 * WHAT IS STILL ABSENT. `getJobOpportunity()` returns `JobOpportunityDetail`,
 * which carries the description and the qualification lists and nothing else:
 * no private note, no pipeline status, no applied date, no owner. Opening one
 * posting is a deliberate act, but it is a deliberate act by somebody who did
 * not save it, and it reveals no more than the list did.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Opportunity | KIASA',
  robots: { index: false, follow: false, nocache: true },
};

export default async function OpportunityPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { user } = await requireCandidate();
  const access = await resolveJobBoardAccess();

  if (!access.allowed) {
    return (
      <ProfileShell title="Job board" email={user.email ?? null} back>
        <div className="kjb__locked">
          <h2>{JOB_BOARD_LOCKED.title}</h2>
          <p>{JOB_BOARD_LOCKED.body}</p>
        </div>
      </ProfileShell>
    );
  }

  if (!isJobBoardConfigured()) notFound();

  const { jobId } = await params;
  const job = await getJobOpportunity(jobId);
  if (!job) notFound();

  const salary = formatSalary(job);
  const experience = formatExperience(job);
  const employment = humanise(job.employment_type);

  const lists: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['Responsibilities', job.responsibilities],
    ['Required', job.required_qualifications],
    ['Preferred', job.preferred_qualifications],
  ];

  return (
    <ProfileShell title={job.title ?? 'Opportunity'} email={user.email ?? null} back>
      <div className="kjb__detail">
        <div className="kjb__detailHead">
          <span className="kjb__mark">
            {job.company_logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={job.company_logo_url} alt="" />
            ) : (
              <span className="kjb__markText">
                {(job.company ?? '?').slice(0, 2).toUpperCase()}
              </span>
            )}
          </span>
          <div>
            <h2 className="kjb__detailTitle">{job.title ?? 'Untitled posting'}</h2>
            <p className="kjb__company">
              {job.company ?? hostOf(job.url)}
              {job.location ? ` · ${job.location}` : ''}
            </p>
          </div>
        </div>

        <div className="kjb__facts">
          {job.workplace_type ? (
            <span className="kjb__fact">{humanise(job.workplace_type)}</span>
          ) : null}
          {employment ? <span className="kjb__fact">{employment}</span> : null}
          {salary ? <span className="kjb__fact">{salary}</span> : null}
          {experience ? <span className="kjb__fact">{experience}</span> : null}
          {job.sponsorship_available ? <span className="kjb__fact">Sponsors visas</span> : null}
          {job.security_clearance_required ? (
            <span className="kjb__fact">Clearance required</span>
          ) : null}
          <span className="kjb__fact">Listed {formatDate(job.saved_at)}</span>
        </div>

        {job.skills.length > 0 ? (
          <div className="kjb__section">
            <h3 className="kjb__sectionTitle">Skills</h3>
            <div className="kjb__skills">
              {job.skills.map((skill) => (
                <span key={skill} className="kjb__skill">
                  {skill}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {job.description ? (
          <div className="kjb__section">
            <h3 className="kjb__sectionTitle">Description</h3>
            {/*
              Plain text in a <p>, never dangerouslySetInnerHTML. The extension
              extracts an employer's page; treating that as markup would be
              rendering a third party's HTML inside a signed-in session.
            */}
            <p className="kjb__prose">{job.description}</p>
          </div>
        ) : null}

        {lists.map(([heading, items]) =>
          items.length > 0 ? (
            <div key={heading} className="kjb__section">
              <h3 className="kjb__sectionTitle">{heading}</h3>
              <ul className="kjb__list">
                {items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null
        )}

        {job.url ? (
          /*
            rel="noreferrer" as well as noopener: the referrer would tell the
            employer's site that somebody arrived from a KIASA admin-adjacent
            URL, which is nobody's business but the candidate's.
          */
          <a className="kjb__apply" href={job.url} target="_blank" rel="noopener noreferrer">
            Open the original posting ↗
          </a>
        ) : null}

        <Link href="/job-board" className="kjb__button" style={{ alignSelf: 'flex-start' }}>
          Back to the board
        </Link>
      </div>
    </ProfileShell>
  );
}
