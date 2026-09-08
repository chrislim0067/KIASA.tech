import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import ProfileShell from '@/components/profile/ProfileShell';
import ReviewForm from '@/components/resume/ReviewForm';
import { requireCandidate } from '@/lib/candidate/session';
import { getImport } from '@/lib/resume/imports';
import { confirmResumeImport, discardResumeImport } from '@/lib/resume/actions';
import { isEmptyExtraction } from '@/lib/resume/schema';
import { RESUME_ROUTE } from '@/lib/resume/paths';

export const dynamic = 'force-dynamic';

/** Applying a confirmed draft is several writes; well under this, but not instant. */
export const maxDuration = 120;

export const metadata: Metadata = {
  title: 'Check what we found | KIASA',
  robots: { index: false, follow: false },
};

/**
 * The review screen.
 *
 * Reached only from a parse, and only by the person the import belongs to —
 * `getImport` runs under the candidate's own session, so RLS is what answers
 * the ownership question and a stranger's id simply resolves to nothing.
 */
export default async function ResumeReviewPage({
  params,
}: {
  params: Promise<{ importId: string }>;
}) {
  const { importId } = await params;
  const { supabase, user } = await requireCandidate();

  const record = await getImport(supabase, importId);
  if (!record) notFound();

  // Anything already dealt with belongs back on the import screen rather than
  // in a review that would write it a second time.
  if (record.status !== 'parsed') redirect(RESUME_ROUTE);

  const draft = record.draft;

  // `parsed` with an unreadable draft means the stored JSON no longer matches
  // the schema — a corrupted edit, or a schema that has moved on. Treated the
  // same as a failed read, because that is what it is from here.
  if (!draft) {
    return (
      <ProfileShell title="Check what we found" email={user.email ?? null} back>
        <div className="kprof__notice kprof__notice--bad">
          <strong>This import could not be opened.</strong> Upload the résumé again, or fill in
          your profile directly — nothing has been added either way.
        </div>
        <div className="kprof__actions">
          <Link className="kprof__button" href={RESUME_ROUTE}>
            Try again
          </Link>
        </div>
      </ProfileShell>
    );
  }

  const found =
    draft.work_experiences.length + draft.education_entries.length + draft.skills.length;

  if (isEmptyExtraction(draft)) {
    return (
      <ProfileShell title="Check what we found" email={user.email ?? null} back>
        <div className="kprof__notice kprof__notice--warn">
          <strong>Almost nothing could be read from that file.</strong> That usually means it is
          a scan or a photograph rather than a text PDF. Exporting a fresh PDF from the original
          document normally fixes it.
        </div>
        <div className="kprof__actions">
          <Link className="kprof__button" href={RESUME_ROUTE}>
            Try another file
          </Link>
          <Link className="kprof__button kprof__button--ghost" href="/profile">
            Fill it in myself
          </Link>
        </div>
        <form action={discardResumeImport} style={{ marginTop: '1rem' }}>
          <input type="hidden" name="import_id" value={record.id} />
          <button type="submit" className="kprof__button kprof__button--ghost">
            Discard this import
          </button>
        </form>
      </ProfileShell>
    );
  }

  return (
    <ProfileShell
      title="Check what we found"
      lede={
        <>
          This is what your résumé said — <strong>nothing is on your profile yet</strong>. Correct
          anything that is wrong, untick anything you would rather leave out, then confirm.
        </>
      }
      email={user.email ?? null}
      back
    >
      <div className="kprof__notice kprof__notice--ok" style={{ marginBottom: '1.5rem' }}>
        Read {found} {found === 1 ? 'entry' : 'entries'} from{' '}
        <strong>{record.file_name ?? 'your résumé'}</strong>.
      </div>

      {/*
        The model's own account of what defeated it. Without this, a résumé
        whose second column was unreadable produces a short, confident-looking
        list and the person has no reason to suspect anything is missing.
      */}
      {draft.unreadable_sections.length > 0 ? (
        <div className="kprof__notice kprof__notice--warn" style={{ marginBottom: '1.5rem' }}>
          <strong>Some of the document could not be read:</strong>{' '}
          {draft.unreadable_sections.join('; ')}. Anything from those parts will be missing
          below — add it by hand after confirming.
        </div>
      ) : null}

      <ReviewForm importId={record.id} draft={draft} action={confirmResumeImport} />

      {/*
        A separate form, so discarding can never be reached by pressing Enter in
        one of the review fields.
      */}
      <form action={discardResumeImport} className="kresume__discard">
        <input type="hidden" name="import_id" value={record.id} />
        <button type="submit" className="kprof__button kprof__button--ghost">
          Discard this import
        </button>
        <span className="kprof__hint">Nothing is added, and your profile stays as it is.</span>
      </form>
    </ProfileShell>
  );
}
