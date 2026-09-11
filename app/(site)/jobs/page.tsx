import type { Metadata } from 'next';
import Link from 'next/link';

import ProfileShell from '@/components/profile/ProfileShell';
import AddJobForm from '@/components/jobs/AddJobForm';
import { requireCandidate } from '@/lib/candidate/session';
import { listJobs } from '@/lib/jobs';
import { describeJobStatus } from '@/lib/jobs/status-copy';
import { addJobUrl } from '@/lib/jobs/actions';

export const dynamic = 'force-dynamic';

/**
 * Reading a posting is a real network fetch, bounded at fifteen seconds by
 * `FETCH_DEFAULTS`, and the action does submit, fetch and extract in one
 * request. The default budget would cut that off part-way and report a platform
 * error rather than an honest "the page could not be read".
 */
export const maxDuration = 60;

export const metadata: Metadata = {
  title: 'Your jobs | KIASA',
  robots: { index: false, follow: false },
};

/**
 * The jobs a candidate has added.
 *
 * WHAT THIS PAGE IS NOT. There is no Apply button, no employer sign-in, and no
 * form filling. KIASA reads a posting the candidate chose and stores a bounded
 * record of it; deciding to apply, and doing it, is a later milestone with its
 * own safety requirements. Nothing here is a step towards submitting anything
 * without a person saying so.
 *
 * Every read goes through `listJobs`, which filters on the candidate's own id
 * under their own session — so RLS is the ownership check and a wrong id in a
 * URL returns nothing rather than someone else's job.
 */
export default async function JobsPage() {
  const { supabase, user } = await requireCandidate();

  const jobs = await listJobs(supabase, user.id, { limit: 50 });
  const rows = jobs.ok ? jobs.data : [];

  /*
   * The details live in `job_facts`, one row per job. Fetched in a single query
   * rather than one per job, and filtered by the candidate's own id as well as
   * by job — RLS would do it anyway, and saying it here means a policy edited
   * wrongly in future is caught by a second layer.
   */
  const ids = rows.map((job) => job.id);
  const { data: facts } = ids.length
    ? await supabase
        .from('job_facts')
        .select('job_id, title, company_name, location_raw')
        .eq('user_id', user.id)
        .in('job_id', ids)
    : { data: [] };

  const factsFor = new Map((facts ?? []).map((f) => [f.job_id, f]));

  return (
    <ProfileShell
      title="Your jobs"
      lede="Paste the link to a posting and KIASA will read what the page says. Nothing is applied for — this is a place to collect roles and see them side by side."
      email={user.email ?? null}
      back
    >
      <AddJobForm action={addJobUrl} />

      <section style={{ marginTop: '2.5rem' }}>
        <h2 className="kprof__legend" style={{ marginBottom: '0.75rem' }}>
          {rows.length === 0 ? 'Nothing added yet' : `Added · ${rows.length}`}
        </h2>

        {rows.length === 0 ? (
          <p className="kprof__empty">
            Jobs you add will appear here, with whatever the posting actually said.
          </p>
        ) : (
          <ul className="kprof__list">
            {rows.map((job) => {
              const detail = factsFor.get(job.id);
              const status = describeJobStatus(job.status);
              return (
                <li key={job.id} className="kprof__item">
                  <span className="kprof__itemBody">
                    <Link href={`/jobs/${job.id}`} className="kprof__itemTitle">
                      {detail?.title ?? 'Untitled posting'}
                    </Link>
                    <span className="kprof__itemNote">
                      {[detail?.company_name, detail?.location_raw].filter(Boolean).join(' · ') ||
                        'No company or location was found on the page'}
                    </span>
                  </span>
                  <span className="kprof__chip">{status.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="kprof__hint" style={{ marginTop: '1.5rem' }}>
        KIASA reads only pages that are public and allow automated reading. A posting behind a
        sign-in, or one whose site asks not to be read, is stored as a link you can open
        yourself.
      </p>
    </ProfileShell>
  );
}
