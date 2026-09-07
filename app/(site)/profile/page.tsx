import type { Metadata } from 'next';
import Link from 'next/link';

import ProfileShell from '@/components/profile/ProfileShell';
import { requireCandidate } from '@/lib/candidate/session';
import { getCandidateSnapshot, buildCompletenessReport } from '@/lib/profile';

/**
 * /profile — the candidate's hub.
 *
 * The step list is driven by `buildCompletenessReport()`, which already encodes
 * what blocks automation and why. Nothing here decides completeness itself:
 * duplicating that logic in the UI is exactly how a screen ends up telling
 * someone they are finished while the engine refuses to act.
 *
 * Its four blocking facts are legal name + contact email, at least one role,
 * job preferences, and work authorization. Everything else is tracked but does
 * not stop anything, and is presented that way.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your profile | KIASA',
  robots: { index: false, follow: false },
};

interface Step {
  readonly href: string;
  readonly title: string;
  readonly note: string;
  readonly done: boolean;
  readonly required: boolean;
}

export default async function ProfilePage() {
  const { supabase, user } = await requireCandidate();

  const snapshotResult = await getCandidateSnapshot(supabase, user.id);

  if (!snapshotResult.ok) {
    return (
      <ProfileShell title="Your profile" email={user.email ?? null}>
        <div className="kprof__notice kprof__notice--bad">
          Your profile could not be loaded. Refresh the page, and if it keeps happening the
          problem is on our side rather than yours.
        </div>
      </ProfileShell>
    );
  }

  const snapshot = snapshotResult.data;
  const report = buildCompletenessReport(snapshot);

  const has = (key: string) => report.facts.find((f) => f.key === key)?.status === 'present';

  const identityDone =
    has('profile.legal_first_name') && has('profile.legal_last_name') && has('profile.contact_email');

  const steps: Step[] = [
    {
      href: '/profile/about',
      title: 'About you',
      note: 'Legal name, contact email, where you are based.',
      done: identityDone,
      required: true,
    },
    {
      href: '/profile/authorization',
      title: 'Work authorisation',
      note: 'Which countries you can work in, and whether you need sponsorship.',
      done: snapshot.workAuthorizations.length > 0,
      required: true,
    },
    {
      href: '/profile/experience',
      title: 'Work experience',
      note: 'At least one role, so an application can describe you.',
      done: snapshot.workExperiences.length > 0,
      required: true,
    },
    {
      href: '/profile/preferences',
      title: 'What you are looking for',
      note: 'Titles, locations, salary, remote or on-site.',
      done: snapshot.jobPreferences !== null,
      required: true,
    },
    {
      href: '/profile/skills',
      title: 'Skills',
      note: 'Optional, but most application forms ask.',
      done: snapshot.skills.length > 0,
      required: false,
    },
  ];

  const requiredSteps = steps.filter((s) => s.required);
  const doneCount = requiredSteps.filter((s) => s.done).length;
  const pct = Math.round((doneCount / requiredSteps.length) * 100);
  const ready = report.status === 'ready';

  return (
    <ProfileShell
      title="Your profile"
      lede="KIASA uses this to fill in applications on your behalf. Nothing is invented — anything you leave blank is treated as unknown and will be asked about rather than guessed."
      email={user.email ?? null}
    >
      <div className="kprof__progress">
        <div className="kprof__progressBar">
          <div
            className={`kprof__progressFill${ready ? ' kprof__progressFill--done' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="kprof__progressText">
          {doneCount} of {requiredSteps.length} required
        </span>
      </div>

      {ready ? (
        <div className="kprof__notice kprof__notice--ok" style={{ marginBottom: '1.5rem' }}>
          <strong>Your profile is ready.</strong> Everything an application needs is recorded.
        </div>
      ) : (
        <div className="kprof__notice kprof__notice--warn" style={{ marginBottom: '1.5rem' }}>
          <strong>{requiredSteps.length - doneCount} step(s) left.</strong> Until these are done,
          KIASA cannot apply for you — it will stop and ask rather than guess an answer.
        </div>
      )}

      <div className="kprof__steps">
        {steps.map((step) => (
          <Link
            key={step.href}
            href={step.href}
            className={`kprof__step ${step.done ? 'kprof__step--done' : step.required ? 'kprof__step--todo' : ''}`}
          >
            <span
              className={`kprof__stepMark ${step.done ? 'kprof__stepMark--done' : step.required ? 'kprof__stepMark--todo' : ''}`}
              aria-hidden="true"
            >
              {step.done ? '✓' : ''}
            </span>
            <span className="kprof__stepBody">
              <span className="kprof__stepTitle">
                {step.title}
                {!step.required ? (
                  <span className="kprof__stepNote" style={{ fontWeight: 400 }}> · optional</span>
                ) : null}
              </span>
              <span className="kprof__stepNote">{step.note}</span>
            </span>
          </Link>
        ))}
      </div>

      {/*
        Work authorisation is the one fact the system will never infer. A
        missing row means UNKNOWN, never "not authorised", so it is surfaced
        separately rather than folded into a percentage.
      */}
      {report.knownWorkAuthorizationCountries.length > 0 ? (
        <p className="kprof__hint" style={{ marginTop: '1.5rem' }}>
          Authorisation recorded for: {report.knownWorkAuthorizationCountries.join(', ')}. Any
          country not listed is treated as unknown and will be asked about.
        </p>
      ) : null}
    </ProfileShell>
  );
}
