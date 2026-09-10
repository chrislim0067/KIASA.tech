import type { Metadata } from 'next';
import Link from 'next/link';

import ProfileShell from '@/components/profile/ProfileShell';
import DraftRequest from '@/components/profile/DraftRequest';
import DraftReview from '@/components/profile/DraftReview';
import { requireCandidate } from '@/lib/candidate/session';
import { getActiveDraft, hasResumeFacts, readProfileScalars } from '@/lib/profile/drafts';
import { RESUME_ROUTE } from '@/lib/resume/paths';
import { PROFILE_ROUTE, WORKER_ROUTE } from '@/lib/profile/routes';
import { readWorkerStatus } from '@/lib/worker/status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Draft your profile | KIASA',
  robots: { index: false, follow: false },
};

/**
 * Drafting the twelve profile scalars from résumé facts, on the candidate's own
 * computer.
 *
 * WHAT GATES THIS PAGE, AND WHAT DELIBERATELY DOES NOT
 *
 * Two things are required: a Supabase session (`requireCandidate`, which also
 * guarantees a `profiles` row exists) and résumé facts to draft FROM.
 *
 * `OPENROUTER_API_KEY` is NOT one of them, and that is a deliberate difference
 * from `/profile/resume`. Reading a PDF is a hosted model call and is gated on
 * that key; drafting is not — it runs on the candidate's own machine through
 * `lib/local-claude/`, and `lib/profile/drafting.ts` has no provider path in it
 * at all. Gating this page on a hosted provider's key would tie a local feature
 * to a remote one for no reason, and would suggest a fallback that does not and
 * must not exist.
 *
 * Facts can arrive by either route — the PDF upload on `/profile/resume`, which
 * does need the key, or the paste console on `/profile`, which needs only
 * `SUPABASE_SECRET_KEY`. So this page is reachable and usable in an environment
 * with no OpenRouter key at all, which is what makes it testable in preview.
 *
 * NOTHING ON THIS PAGE HAS TOUCHED THE PROFILE. A draft lives in
 * `profile_drafts`, which no profile query reads. The only path across is the
 * confirmation route, after a person has been through it field by field.
 */
export default async function ProfileDraftPage() {
  const { supabase, user } = await requireCandidate();

  const [facts, active, profile, worker] = await Promise.all([
    hasResumeFacts(supabase),
    getActiveDraft(supabase),
    readProfileScalars(supabase),
    readWorkerStatus(supabase),
  ]);

  /*
   * THE VERSION CHECK IS SHOWN BEFORE IT IS ENFORCED.
   *
   * The confirmation route refuses a draft written against an older profile,
   * which is right — applying it would overwrite newer work with older
   * proposals. Discovering that after reading twelve fields and pressing the
   * button is a bad way to find out, so it is said here first.
   */
  const stale =
    active !== null && profile !== null && active.profile_version !== profile.updated_at;

  return (
    <ProfileShell
      title="Draft your profile"
      lede="Claude runs on your own computer, reads the facts already taken from your résumé, and proposes values for your profile. You decide field by field what to keep."
      email={user.email ?? null}
      back
    >
      {!facts ? (
        <div className="kprof__notice kprof__notice--warn">
          <strong>There is nothing to draft from yet.</strong> Import a résumé first — upload a
          PDF on the{' '}
          <Link href={RESUME_ROUTE} className="kprof__back" style={{ margin: 0 }}>
            résumé page
          </Link>
          , or paste one in from the{' '}
          <Link href={PROFILE_ROUTE} className="kprof__back" style={{ margin: 0 }}>
            profile page
          </Link>
          . Both work; the paste route needs nothing switched on.
        </div>
      ) : active === null ? (
        <DraftRequest worker={worker} workerHref={WORKER_ROUTE} />
      ) : (
        <>
          {stale ? (
            <div className="kprof__notice kprof__notice--warn">
              <strong>Your profile changed after this draft was made.</strong> Saving it would
              put older suggestions over newer work, so KIASA will refuse. Discard this one and
              ask again — the new draft will be built from what your profile says now.
            </div>
          ) : null}

          {active.status === 'pending' ? (
            <Waiting taskStatus={active.task_status} workerHref={WORKER_ROUTE} />
          ) : active.draft === null ? (
            <div className="kprof__notice kprof__notice--bad">
              <strong>That draft did not come back in a form KIASA can show you.</strong> Nothing
              was saved and nothing on your profile was touched. Asking again usually works — and
              if it does not, everything here can be typed directly on the{' '}
              <Link href={PROFILE_ROUTE} className="kprof__back" style={{ margin: 0 }}>
                profile page
              </Link>
              .
            </div>
          ) : (
            <DraftReview
              draftId={active.id}
              draft={active.draft}
              current={profile?.values ?? active.current}
            />
          )}
        </>
      )}
    </ProfileShell>
  );
}

/**
 * A request that has been made and not yet answered.
 *
 * The task's own status is what separates "your worker has not picked it up
 * yet" from "your worker took it and failed", and those need different things
 * from the candidate. A single spinner would hide the difference.
 */
function Waiting({
  taskStatus,
  workerHref,
}: {
  taskStatus: string | null;
  workerHref: string;
}) {
  if (taskStatus === 'failed' || taskStatus === 'cancelled') {
    return (
      <div className="kprof__notice kprof__notice--bad">
        <strong>Your computer could not finish this one.</strong> Nothing was saved and nothing on
        your profile was touched. Check that Claude is installed and signed in on that machine,
        then ask again from the{' '}
        <Link href={workerHref} className="kprof__back" style={{ margin: 0 }}>
          worker page
        </Link>
        .
      </div>
    );
  }

  if (taskStatus === 'leased' || taskStatus === 'processing') {
    return (
      <div className="kprof__notice kprof__notice--ok">
        <strong>Your computer is working on it.</strong> This usually takes a few seconds.
        Reload the page and the draft will be here to read.
      </div>
    );
  }

  return (
    <div className="kprof__notice kprof__notice--warn">
      <strong>Waiting for your worker to pick this up.</strong> If it does not, the worker is
      probably not running — start it on that computer and check the{' '}
      <Link href={workerHref} className="kprof__back" style={{ margin: 0 }}>
        worker page
      </Link>
      . Reload here once it is going.
    </div>
  );
}
