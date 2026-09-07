import type { Metadata } from 'next';
import Link from 'next/link';

import AdminShell from '@/components/admin/AdminShell';
import { requireAdminPage } from '@/lib/admin/page-guard';
import { getPlatformStats, getRecentRegistrations, getRecentAudit } from '@/lib/admin/queries';
import { logAdminError } from '@/lib/admin/api';

/**
 * /admin — the operational overview.
 *
 * Two rules govern what appears here:
 *
 *   * Every number comes from the database, computed in one pass by the
 *     `admin_platform_stats` view. Nothing is counted in this component.
 *
 *   * Nothing is invented. KIASA's pipeline currently ends at "job extracted" —
 *     there is no application engine and no Bid Bot writing rows yet — so the
 *     application panel reports zero and SAYS SO, rather than presenting an
 *     empty measurement as though it were a real one. The moment an engine
 *     starts writing to `applications`, these same tiles become live with no
 *     change here.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Admin | KIASA',
  // Never indexed, never followed. This page lists real people.
  robots: { index: false, follow: false, nocache: true },
};

const nf = new Intl.NumberFormat('en-GB');

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number | string;
  note?: string;
  tone?: 'accent' | 'success' | 'danger' | 'idle';
}) {
  // A zero is still the truthful answer, but it is not news. Rendering a row of
  // them at full brightness gave every counter the same visual weight, so the
  // one number that had actually moved did not stand out from the ones that had
  // not. Zeros drop back unless the caller has asked for a specific tone.
  const resolvedTone = tone ?? (value === 0 ? 'idle' : undefined);

  return (
    <div className="kadmin__stat">
      <span className="kadmin__statLabel">{label}</span>
      <span className={`kadmin__statValue${resolvedTone ? ` kadmin__statValue--${resolvedTone}` : ''}`}>
        {typeof value === 'number' ? nf.format(value) : value}
      </span>
      {note ? <span className="kadmin__statNote">{note}</span> : null}
    </div>
  );
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default async function AdminDashboardPage() {
  const { user } = await requireAdminPage('admin.access');

  // Each panel degrades independently. A failure loading the audit tail must
  // not blank the user counts, so the page renders what it has and says what
  // it could not load, rather than throwing to the error boundary.
  const [statsResult, registrationsResult, auditResult] = await Promise.allSettled([
    getPlatformStats(),
    getRecentRegistrations(8),
    getRecentAudit(8),
  ]);

  if (statsResult.status === 'rejected') {
    logAdminError('dashboard.stats', statsResult.reason, { actor_user_id: user.id });
  }
  if (registrationsResult.status === 'rejected') {
    logAdminError('dashboard.registrations', registrationsResult.reason, { actor_user_id: user.id });
  }
  if (auditResult.status === 'rejected') {
    logAdminError('dashboard.audit', auditResult.reason, { actor_user_id: user.id });
  }

  const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;
  const registrations = registrationsResult.status === 'fulfilled' ? registrationsResult.value : [];
  const audit = auditResult.status === 'fulfilled' ? auditResult.value : [];

  return (
    <AdminShell
      title="Platform overview"
      lede="Live counters, read directly from the database on every load."
      actorEmail={user.email ?? null}
      currentPath="/admin"
    >
      {!stats ? (
        <div className="kadmin__notice kadmin__notice--danger">
          <p>
            <strong>Platform statistics could not be loaded.</strong>
          </p>
          <p>
            The rest of this page is unaffected. The failure has been recorded in the server log
            with the details needed to diagnose it.
          </p>
        </div>
      ) : null}

      {stats ? (
        <>
          <section className="kadmin__section" aria-labelledby="s-accounts">
            <div className="kadmin__sectionHead">
              <h2 className="kadmin__sectionTitle" id="s-accounts">
                Accounts
              </h2>
            </div>
            <div className="kadmin__stats">
              <Stat label="Total users" value={stats.usersTotal} />
              <Stat label="New — 7 days" value={stats.usersNew7d} tone="accent" />
              <Stat label="New — 30 days" value={stats.usersNew30d} />
              <Stat
                label="Active — 30 days"
                value={stats.usersActive30d}
                note="Signed in, added a job, or applied. Not a live-session count."
              />
              <Stat label="Administrators" value={stats.usersAdmin} tone="accent" />
              <Stat
                label="Awaiting confirmation"
                value={stats.usersPendingConfirmation}
                tone={stats.usersPendingConfirmation > 0 ? 'idle' : undefined}
              />
            </div>
          </section>

          <section className="kadmin__section" aria-labelledby="s-apps">
            <div className="kadmin__sectionHead">
              <h2 className="kadmin__sectionTitle" id="s-apps">
                Applications
              </h2>
            </div>

            {stats.applicationTrackingIdle ? (
              <div className="kadmin__notice kadmin__notice--warn" style={{ marginBottom: '1rem' }}>
                <p>
                  <strong>No applications have been recorded yet.</strong>
                </p>
                <p>
                  KIASA&rsquo;s pipeline currently ends at job extraction — jobs are fetched and
                  their facts parsed, but no application engine or Bid Bot is writing results.
                  The schema that records them is in place (<code>applications</code> and{' '}
                  <code>application_attempts</code>), so these counters are structurally correct
                  and will become live the moment an engine writes its first row.
                </p>
                <p>
                  These zeros are the truthful answer, not a placeholder. No number on this page is
                  inferred from job-intake activity.
                </p>
              </div>
            ) : null}

            <div className="kadmin__stats">
              <Stat label="Applications" value={stats.applicationsTotal} tone={stats.applicationTrackingIdle ? 'idle' : undefined} />
              <Stat
                label="Successfully submitted"
                value={stats.applicationsSucceeded}
                tone={stats.applicationsSucceeded > 0 ? 'success' : 'idle'}
                note="Submitted or confirmed only."
              />
              <Stat
                label="Failed"
                value={stats.applicationsFailed}
                tone={stats.applicationsFailed > 0 ? 'danger' : 'idle'}
              />
              <Stat label="In progress" value={stats.applicationsPending} tone="idle" />
              <Stat label="Needs intervention" value={stats.applicationsNeedsIntervention} tone="idle" />
              <Stat label="Manual" value={stats.applicationsManual} tone="idle" />
              <Stat
                label="Automated (all)"
                value={stats.applicationsAutomated}
                note="Includes Bid Bot."
                tone="idle"
              />
            </div>
          </section>

          <section className="kadmin__section" aria-labelledby="s-bidbot">
            <div className="kadmin__sectionHead">
              <h2 className="kadmin__sectionTitle" id="s-bidbot">
                Bid Bot
              </h2>
            </div>
            <div className="kadmin__stats">
              <Stat
                label="Applications handled"
                value={stats.applicationsBidBot}
                tone="idle"
                note="Every application Bid Bot took on, whatever the outcome."
              />
              <Stat
                label="Successfully submitted"
                value={stats.bidBotSucceeded}
                tone={stats.bidBotSucceeded > 0 ? 'success' : 'idle'}
                note="Not the same as handled — this is the one that means applied."
              />
              <Stat
                label="Failed"
                value={stats.bidBotFailed}
                tone={stats.bidBotFailed > 0 ? 'danger' : 'idle'}
              />
              <Stat
                label="Execution attempts"
                value={stats.bidBotAttempts}
                tone="idle"
                note="Exceeds applications handled whenever work was retried."
              />
            </div>
          </section>

          <section className="kadmin__section" aria-labelledby="s-jobs">
            <div className="kadmin__sectionHead">
              <h2 className="kadmin__sectionTitle" id="s-jobs">
                Job intake
              </h2>
            </div>
            <div className="kadmin__stats">
              <Stat label="Jobs taken in" value={stats.jobsTotal} />
              <Stat label="New — 7 days" value={stats.jobsNew7d} tone="accent" />
              <Stat label="Extracted" value={stats.jobsExtracted} tone="success" />
              <Stat
                label="Parked"
                value={stats.jobsParked}
                tone={stats.jobsParked > 0 ? 'danger' : undefined}
                note="Fetch failed or extraction incomplete."
              />
            </div>
          </section>

          <section className="kadmin__section" aria-labelledby="s-admin">
            <div className="kadmin__sectionHead">
              <h2 className="kadmin__sectionTitle" id="s-admin">
                Administrative activity — 7 days
              </h2>
            </div>
            <div className="kadmin__stats">
              <Stat label="Actions" value={stats.adminActions7d} />
              <Stat
                label="Failed actions"
                value={stats.adminActionsFailed7d}
                tone={stats.adminActionsFailed7d > 0 ? 'danger' : undefined}
                note="Rejected or errored privileged operations."
              />
            </div>
          </section>
        </>
      ) : null}

      <div className="kadmin__panels kadmin__section">
        <section className="kadmin__panel" aria-labelledby="s-recent">
          <div className="kadmin__sectionHead">
            <h2 className="kadmin__sectionTitle" id="s-recent">
              Recent registrations
            </h2>
            <Link href="/admin/users" className="kadmin__navLink">
              All users
            </Link>
          </div>

          {registrations.length === 0 ? (
            <div className="kadmin__empty">
              <strong>No accounts yet</strong>
              Registrations will appear here as they happen.
            </div>
          ) : (
            <dl className="kadmin__dl">
              {registrations.map((u) => (
                <div className="kadmin__dlRow" key={u.user_id}>
                  <dt className="kadmin__dt" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    <a
                      href={`/admin/users/${u.user_id}`}
                      style={{ color: 'inherit', textDecoration: 'none' }}
                    >
                      {u.display_name ?? u.email ?? u.user_id}
                    </a>
                  </dt>
                  <dd className="kadmin__dd kadmin__dd--muted">{formatDate(u.registered_at)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section className="kadmin__panel" aria-labelledby="s-auditrecent">
          <div className="kadmin__sectionHead">
            <h2 className="kadmin__sectionTitle" id="s-auditrecent">
              Recent admin actions
            </h2>
            <Link href="/admin/audit" className="kadmin__navLink">
              Full log
            </Link>
          </div>

          {audit.length === 0 ? (
            <div className="kadmin__empty">
              <strong>Nothing logged yet</strong>
              Invitations, deletions and role changes are recorded here.
            </div>
          ) : (
            <dl className="kadmin__dl">
              {audit.map((row) => (
                <div className="kadmin__dlRow" key={row.id}>
                  <dt className="kadmin__dt" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    <span
                      className={`kadmin__badge${row.result === 'failed' ? ' kadmin__badge--failed' : ''}`}
                    >
                      {row.action}
                    </span>{' '}
                    {row.target_email ?? ''}
                  </dt>
                  <dd className="kadmin__dd kadmin__dd--muted">{formatDate(row.occurred_at)}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      </div>
    </AdminShell>
  );
}
