import type { Metadata } from 'next';

import AdminShell from '@/components/admin/AdminShell';
import JobsWorkspace from '@/components/admin/jobs/JobsWorkspace';
import { requireAdminPage } from '@/lib/admin/page-guard';
import { logAdminError } from '@/lib/admin/api';
import { listSavedJobs } from '@/lib/jobboard/queries';
import { isJobBoardConfigured, missingJobBoardEnv } from '@/lib/jobboard/env';
import '@/styles/admin-jobs.css';

/**
 * /admin/jobs — every posting the browser extension has saved, for everyone.
 *
 * A server component: the rows are fetched here and handed to a client
 * component for interaction, so the first paint already has the data. On a list
 * this size that is the difference between instant and a spinner.
 *
 * WHY THIS IS ADMINISTRATOR-ONLY FOR NOW
 *
 * The postings live in the job board's Supabase project, whose rows are owned
 * by accounts in THAT project — not by KIASA candidates. Until the two
 * identities are reconciled there is no correct answer to "which of these is
 * mine", so showing the board to a candidate would either show them everyone's
 * jobs or nobody's. Administrators are the one audience for whom "all of them"
 * is the right answer, which is why this surface exists here first.
 *
 * `requireAdminPage()` is awaited before anything is read. The guard runs per
 * page rather than in a layout for the reason given in `lib/admin/page-guard.ts`:
 * a layout does not re-render on client-side navigation within its segment, so
 * a check placed only there can be walked around.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Job board | KIASA Admin',
  // Never indexed, never followed. This page lists real people's job searches.
  robots: { index: false, follow: false, nocache: true },
};

export default async function AdminJobsPage() {
  const ctx = await requireAdminPage('admin.access');

  if (!isJobBoardConfigured()) {
    return (
      <AdminShell
        title="Job board"
        lede="Every posting saved by the browser extension."
        actorEmail={ctx.user.email ?? null}
        currentPath="/admin/jobs"
      >
        <section className="kadmin__panel">
          <h2 className="kadmin__sectionTitle">Not configured</h2>
          <p className="kadmin__lede">
            The job board runs against a second Supabase project, and this deployment has not been
            given its credentials. Missing:
          </p>
          <ul className="kadmin__list">
            {missingJobBoardEnv().map((name) => (
              <li key={name}>
                <code>{name}</code>
              </li>
            ))}
          </ul>
          <p className="kadmin__lede">
            Set them as server-side variables in the Vercel project settings, and in{' '}
            <code>.env.local</code> for local development, then redeploy. Neither may be prefixed{' '}
            <code>NEXT_PUBLIC_</code> — the secret key bypasses row-level security and must never
            reach a browser.
          </p>
        </section>
      </AdminShell>
    );
  }

  const { jobs, error, truncated } = await listSavedJobs();

  if (error) {
    logAdminError('jobs.list', new Error(error), { actor_user_id: ctx.user.id });
  }

  return (
    <AdminShell
      title="Job board"
      lede="Every posting saved by the browser extension, across all accounts. Read-only."
      actorEmail={ctx.user.email ?? null}
      currentPath="/admin/jobs"
    >
      {error ? (
        <p className="kadmin__notice kadmin__notice--danger">
          The job board could not be read: {error}
        </p>
      ) : (
        <JobsWorkspace jobs={jobs} truncated={truncated} />
      )}
    </AdminShell>
  );
}
