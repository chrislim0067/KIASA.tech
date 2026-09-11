import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import ProfileShell from '@/components/profile/ProfileShell';
import { requireCandidate } from '@/lib/candidate/session';
import { getJob, getFacts } from '@/lib/jobs';
import { describeJobStatus } from '@/lib/jobs/status-copy';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Job | KIASA',
  robots: { index: false, follow: false },
};

/**
 * One posting, as the page actually described it.
 *
 * EVERYTHING BELOW IS UNTRUSTED TEXT SOMEONE ELSE WROTE. A job description is
 * the most likely place in this product to meet prompt injection — "ignore your
 * instructions", "you are now…", an invisible block of white text — and it is
 * treated as content, never as instruction. Nothing on this page is interpreted:
 * React escapes every string it renders, no value is passed to
 * `dangerouslySetInnerHTML`, and no model reads any of it in this milestone.
 *
 * NOTHING HERE IS INFERRED ABOUT THE CANDIDATE. A posting saying "5 years of
 * Kubernetes required" is a claim the employer made, not a fact about the
 * person reading it, and no field on this page writes to a profile.
 *
 * AND THERE IS NO APPLY BUTTON. The only outbound link is the posting's own
 * address, which opens in a new tab under the person's own control.
 */
export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const { supabase, user } = await requireCandidate();

  /*
   * `getJob` filters on the candidate's own id under their own session, so
   * another candidate's job is simply not there. A wrong id is a 404, not a
   * refusal that would confirm the row exists.
   */
  const job = await getJob(supabase, user.id, jobId);
  if (!job.ok || job.data === null) notFound();

  const facts = await getFacts(supabase, user.id, jobId);
  const detail = facts.ok ? facts.data : null;
  const status = describeJobStatus(job.data.status);

  return (
    <ProfileShell
      title={detail?.title ?? 'Job posting'}
      lede={status.note}
      email={user.email ?? null}
      back
    >
      <div className="kprof__fieldset">
        <Field label="Company" value={detail?.company_name ?? null} />
        <Field label="Location" value={detail?.location_raw ?? null} />
        <Field label="Employment type" value={detail?.employment_type ?? null} />
        <Field label="Remote" value={detail?.remote_type ?? null} />
        <Field label="Status" value={status.label} />
        <Field label="Source" value={job.data.ats_vendor ?? 'Direct link'} />
      </div>

      {detail?.description_text ? (
        <section className="kprof__fieldset" style={{ marginTop: '1.5rem' }}>
          <h2 className="kprof__legend">What the posting says</h2>
          {/*
            RENDERED AS TEXT, NEVER AS MARKUP. `white-space: pre-wrap` keeps the
            posting's own line breaks without interpreting anything in it; React
            escapes the content, so a `<script>` in a job description is
            characters on a page and nothing more.
          */}
          <p className="kprof__hint" style={{ whiteSpace: 'pre-wrap' }}>
            {detail.description_text}
          </p>
        </section>
      ) : (
        <p className="kprof__notice kprof__notice--warn" style={{ marginTop: '1.5rem' }}>
          No description was found on that page. What is missing is left blank rather than
          guessed — you can read the original below.
        </p>
      )}

      <div className="kprof__actions" style={{ marginTop: '1.5rem' }}>
        {/*
          The posting's own address, opened by the person. `noopener noreferrer`
          because the destination is a page we do not control.
        */}
        <a
          className="kprof__button kprof__button--ghost"
          href={job.data.canonical_url}
          target="_blank"
          rel="noopener noreferrer nofollow"
        >
          Open the original posting
        </a>
        <Link href="/jobs" className="kprof__back" style={{ margin: 0 }}>
          Back to your jobs
        </Link>
      </div>

      <p className="kprof__hint" style={{ marginTop: '1.5rem' }}>
        KIASA has not applied for this and cannot. Deciding to apply, and doing it, is yours —
        applications are a later part of the product and will always ask you first.
      </p>
    </ProfileShell>
  );
}

/** One row. An absent value says so rather than showing an empty gap. */
function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="kprof__field kprof__field--wide">
      <span className="kprof__label">{label}</span>
      <span>{value ?? <span className="kprof__hint">Not stated on the page</span>}</span>
    </div>
  );
}
