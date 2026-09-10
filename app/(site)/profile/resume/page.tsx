import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import ProfileShell from '@/components/profile/ProfileShell';
import ResumeUpload from '@/components/resume/ResumeUpload';
import { requireCandidate } from '@/lib/candidate/session';
import { getActiveImport, listImports } from '@/lib/resume/imports';
import { isResumeParsingConfigured } from '@/lib/resume/extract';
import { isAdminConfigured } from '@/lib/supabase/admin';
import { startResumeImport, discardResumeImport } from '@/lib/resume/actions';
import { RESUME_ROUTE } from '@/lib/resume/paths';
import { PROFILE_DRAFT_ROUTE } from '@/lib/profile/routes';

export const dynamic = 'force-dynamic';

/**
 * Reading a résumé is a single model call over a whole document, so it takes
 * appreciably longer than any other request this application makes. The default
 * function budget would cut it off part-way and report a platform error rather
 * than a parse failure.
 */
export const maxDuration = 300;

export const metadata: Metadata = {
  title: 'Import your résumé | KIASA',
  robots: { index: false, follow: false },
};

/** Why a parse failed, said in a way that suggests what to do about it. */
const FAILURE_TEXT: Record<string, string> = {
  unreadable:
    'That document could not be read. Scans and photographs of paper are the usual cause — a PDF exported from Word, Pages or Google Docs works far better.',
  too_large: 'That PDF was over 10 MB. Export a smaller copy and try again.',
  model_error: 'Something went wrong on our side while reading it. Trying again usually works.',
  timeout: 'Reading it took too long. Trying again usually works.',
};

export default async function ResumeImportPage() {
  const { supabase, user } = await requireCandidate();

  const configured = isResumeParsingConfigured() && isAdminConfigured();

  const [active, history] = await Promise.all([
    getActiveImport(supabase),
    listImports(supabase, 5),
  ]);

  // A draft waiting to be reviewed is the only thing that matters on this
  // screen, so it goes straight there rather than making someone find it.
  if (active?.status === 'parsed' && active.draft) {
    redirect(`${RESUME_ROUTE}/${active.id}`);
  }

  const confirmed = history.filter((i) => i.status === 'confirmed');

  return (
    <ProfileShell
      title="Import your résumé"
      lede="Upload a PDF and KIASA will read it, then show you everything it found. Nothing goes on your profile until you have checked it and said yes."
      email={user.email ?? null}
      back
    >
      {!configured ? (
        <div className="kprof__notice kprof__notice--warn">
          Résumé import is not switched on yet. You can still fill in your profile by hand —
          every step is on the{' '}
          <Link href="/profile" className="kprof__back" style={{ margin: 0 }}>
            profile page
          </Link>
          .
        </div>
      ) : (
        <>
          {active?.status === 'failed' ? (
            <div className="kprof__notice kprof__notice--bad">
              <strong>That résumé could not be read.</strong>{' '}
              {FAILURE_TEXT[active.failure_class ?? ''] ?? FAILURE_TEXT.model_error}
              <form action={discardResumeImport} style={{ marginTop: '0.75rem' }}>
                <input type="hidden" name="import_id" value={active.id} />
                <button type="submit" className="kprof__button kprof__button--ghost">
                  Dismiss
                </button>
              </form>
            </div>
          ) : null}

          <ResumeUpload userId={user.id} action={startResumeImport} />

          <p className="kprof__hint" style={{ marginTop: '1.5rem' }}>
            PDF only, up to 10 MB. Your résumé is stored privately — only you and the reader can
            open it, and it is never made public or shared with employers by this step.
          </p>

          {/*
            The alternative is stated rather than hidden. Someone whose résumé
            does not read well should not be left with an upload box and no
            other route through.
          */}
          <div className="kprof__notice kprof__notice--warn" style={{ marginTop: '2rem' }}>
            <strong>Prefer to type it?</strong> Importing is a shortcut, not a requirement —
            everything it fills in can be entered directly from the{' '}
            <Link href="/profile" className="kprof__back" style={{ margin: 0 }}>
              profile page
            </Link>
            .
          </div>
        </>
      )}

      {confirmed.length > 0 ? (
        <section style={{ marginTop: '2.5rem' }}>
          <h2 className="kprof__legend" style={{ marginBottom: '0.75rem' }}>
            Already imported
          </h2>
          <ul className="kprof__list">
            {confirmed.map((record) => (
              <li key={record.id} className="kprof__item">
                <span className="kprof__itemBody">
                  <span className="kprof__itemTitle">{record.file_name ?? 'Résumé'}</span>
                  <span className="kprof__itemNote">
                    Added{' '}
                    {record.confirmed_at
                      ? new Date(record.confirmed_at).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric',
                        })
                      : 'previously'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="kprof__hint">
            Importing again never removes anything. Roles, qualifications and skills you already
            have are left exactly as they are.
          </p>

          {/*
            The way on, offered where someone has just finished importing.
            Drafting is a separate page on purpose: it runs on the candidate's
            own computer and is reviewed field by field, so it is not something
            to slip into the end of an upload.
          */}
          <div className="kprof__notice kprof__notice--warn">
            <strong>Let your own computer fill in the rest?</strong> If you run the KIASA worker,
            Claude can read these facts on your machine and propose values for your name, contact
            details and links — which you then accept or reject one at a time on the{' '}
            <Link href={PROFILE_DRAFT_ROUTE} className="kprof__back" style={{ margin: 0 }}>
              drafting page
            </Link>
            . Nothing is saved until you say so.
          </div>
        </section>
      ) : null}
    </ProfileShell>
  );
}
