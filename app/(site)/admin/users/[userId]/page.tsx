import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import AdminShell from '@/components/admin/AdminShell';
import DeleteUserDialog from '@/components/admin/DeleteUserDialog';
import RoleControl from '@/components/admin/RoleControl';
import AccessControl from '@/components/admin/AccessControl';
import { isAccessStatus, DEFAULT_ACCESS } from '@/lib/auth/access';
import { requireAdminPage } from '@/lib/admin/page-guard';
import {
  getUserAccount,
  getUserProfile,
  getUserAutomation,
  getUserSkills,
  getApplicationStats,
  getRecentApplications,
  getRecentAudit,
  EMPTY_STATS,
} from '@/lib/admin/queries';
import { isUuid, logAdminError } from '@/lib/admin/api';

/**
 * /admin/users/[userId] — everything KIASA knows about one account.
 *
 * What is deliberately NOT here, and cannot be:
 *
 *   * The password. Supabase stores a hash in `auth.users.encrypted_password`
 *     and the `admin_user_directory` view does not project it — migration 16
 *     fails outright if that column is ever added. There is no code path in
 *     this application that can read it.
 *   * Access tokens, refresh tokens, confirmation, recovery or reauthentication
 *     tokens. Excluded from the same view, for the same reason.
 *   * Anything from `job_snapshots.body` — the stored page bodies of postings
 *     the user fetched. Not secret, but not the administrator's business.
 *
 * What IS here is the operational picture: who they are, what they configured,
 * how much they have applied for, by what mechanism, and what happened.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'User | KIASA Admin',
  robots: { index: false, follow: false, nocache: true },
};

const nf = new Intl.NumberFormat('en-GB');

function formatDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="kadmin__dlRow">
      <dt className="kadmin__dt">{label}</dt>
      <dd className="kadmin__dd">{value}</dd>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number;
  note?: string;
  tone?: 'accent' | 'success' | 'danger' | 'idle';
}) {
  return (
    <div className="kadmin__stat">
      <span className="kadmin__statLabel">{label}</span>
      <span className={`kadmin__statValue${tone ? ` kadmin__statValue--${tone}` : ''}`}>
        {nf.format(value)}
      </span>
      {note ? <span className="kadmin__statNote">{note}</span> : null}
    </div>
  );
}

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { user: actor } = await requireAdminPage('users.read');
  const { userId } = await params;

  // Validate before querying. A malformed id would otherwise become a database
  // error rather than a clean 404.
  if (!isUuid(userId)) notFound();

  const account = await getUserAccount(userId).catch((error) => {
    logAdminError('user_detail.account', error, { actor_user_id: actor.id, target_user_id: userId });
    return null;
  });

  if (!account) notFound();

  // Every remaining panel is independent: one failing must not blank the page.
  const [profileR, automationR, skillsR, statsR, appsR, auditR] = await Promise.allSettled([
    getUserProfile(userId),
    getUserAutomation(userId),
    getUserSkills(userId),
    getApplicationStats(userId),
    getRecentApplications(userId, 25),
    getRecentAudit(10, userId),
  ]);

  for (const [name, result] of [
    ['profile', profileR],
    ['automation', automationR],
    ['skills', skillsR],
    ['stats', statsR],
    ['applications', appsR],
    ['audit', auditR],
  ] as const) {
    if (result.status === 'rejected') {
      logAdminError(`user_detail.${name}`, result.reason, {
        actor_user_id: actor.id,
        target_user_id: userId,
      });
    }
  }

  const profile = profileR.status === 'fulfilled' ? profileR.value : null;
  const automation = automationR.status === 'fulfilled' ? automationR.value : null;
  const skills = skillsR.status === 'fulfilled' ? skillsR.value : [];
  const stats = statsR.status === 'fulfilled' ? statsR.value : EMPTY_STATS;
  const applications = appsR.status === 'fulfilled' ? appsR.value : [];
  const audit = auditR.status === 'fulfilled' ? auditR.value : [];

  const displayName = (account.display_name as string | null) ?? null;
  const email = (account.email as string | null) ?? null;
  const role = String(account.role ?? 'user');
  const accountStatus = String(account.account_status ?? 'active');
  const accessStatus = isAccessStatus(account.access_status) ? account.access_status : DEFAULT_ACCESS;
  const accessDecidedAt = (account.access_decided_at as string | null) ?? null;
  const accessReason = (account.access_reason as string | null) ?? null;
  const isSelf = userId === actor.id;

  return (
    <AdminShell
      title={displayName ?? email ?? 'User'}
      lede={email && displayName ? email : undefined}
      actorEmail={actor.email ?? null}
      currentPath="/admin/users"
    >
      <Link href="/admin/users" className="kadmin__back">
        ← All users
      </Link>

      <div className="kadmin__sectionHead">
        <div className="kadmin__chips">
          <span className={`kadmin__badge${role === 'admin' ? ' kadmin__badge--admin' : ''}`}>{role}</span>
          <span className={`kadmin__badge kadmin__badge--${accountStatus}`}>
            {accountStatus.replace(/_/g, ' ')}
          </span>
          <span className={`kadmin__badge kadmin__badge--access-${accessStatus}`}>
            {accessStatus}
          </span>
          {isSelf ? <span className="kadmin__badge">This is you</span> : null}
        </div>

        {/*
          All three controls refuse to act on yourself, and the server refuses
          too — hiding them here is a courtesy, not the control. See
          lib/admin/users and the route handlers.
        */}
        {!isSelf ? (
          <div className="kadmin__chips">
            <AccessControl userId={userId} status={accessStatus} />
            <RoleControl userId={userId} currentRole={role === 'admin' ? 'admin' : 'user'} />
            <DeleteUserDialog userId={userId} email={email} displayName={displayName} />
          </div>
        ) : null}
      </div>

      {accessStatus !== 'approved' ? (
        <div className="kadmin__notice kadmin__notice--warn">
          <p>
            <strong>
              {accessStatus === 'pending'
                ? 'This account is waiting for approval.'
                : 'This account was rejected.'}
            </strong>
          </p>
          <p>
            {accessStatus === 'pending'
              ? 'They have confirmed their email but cannot use KIASA yet — signing in sends them to a waiting screen.'
              : 'They cannot use KIASA. Approving reverses this immediately.'}
            {accessDecidedAt ? ` Decided ${formatDateTime(accessDecidedAt)}.` : ''}
          </p>
          {accessReason ? (
            <p>
              <strong>Reason shown to them:</strong> {accessReason}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------------ application stats -- */}
      <section className="kadmin__section" aria-labelledby="u-apps">
        <div className="kadmin__sectionHead">
          <h2 className="kadmin__sectionTitle" id="u-apps">
            Applications
          </h2>
        </div>

        {stats.applications_total === 0 ? (
          <div className="kadmin__notice kadmin__notice--warn" style={{ marginBottom: '1rem' }}>
            <p>
              <strong>This user has no recorded applications.</strong>
            </p>
            <p>
              KIASA has not applied to a job for anyone yet — the pipeline currently ends at job
              extraction. These counters read zero because zero is the true figure, not because
              data is missing or unavailable.
            </p>
          </div>
        ) : null}

        <div className="kadmin__stats">
          <Stat label="Total applications" value={stats.applications_total} />
          <Stat
            label="Successfully submitted"
            value={stats.applications_succeeded}
            tone={stats.applications_succeeded > 0 ? 'success' : 'idle'}
            note="Submitted or confirmed."
          />
          <Stat
            label="Failed"
            value={stats.applications_failed}
            tone={stats.applications_failed > 0 ? 'danger' : 'idle'}
          />
          <Stat label="In progress" value={stats.applications_pending} tone="idle" />
          <Stat label="Skipped" value={stats.applications_skipped} tone="idle" />
          <Stat label="Needs intervention" value={stats.applications_needs_intervention} tone="idle" />
          <Stat label="Duplicate" value={stats.applications_duplicate} tone="idle" />
        </div>

        <div className="kadmin__sectionHead" style={{ marginTop: '1.5rem' }}>
          <h3 className="kadmin__sectionTitle">By mechanism</h3>
        </div>
        <div className="kadmin__stats">
          <Stat label="Manual" value={stats.manual_total} tone="idle" />
          <Stat label="Automated" value={stats.automated_total} tone="idle" note="Excludes Bid Bot." />
          <Stat label="External" value={stats.external_total} tone="idle" />
          <Stat
            label="Bid Bot — handled"
            value={stats.bid_bot_total}
            tone="idle"
            note="Every application it took on."
          />
          <Stat
            label="Bid Bot — submitted"
            value={stats.bid_bot_succeeded}
            tone={stats.bid_bot_succeeded > 0 ? 'success' : 'idle'}
            note="The figure that means applied."
          />
          <Stat
            label="Bid Bot — failed"
            value={stats.bid_bot_failed}
            tone={stats.bid_bot_failed > 0 ? 'danger' : 'idle'}
          />
          <Stat
            label="Bid Bot — attempts"
            value={stats.bid_bot_attempts}
            tone="idle"
            note="Higher than handled when work was retried."
          />
        </div>
      </section>

      {/* ---------------------------------------------- application history -- */}
      <section className="kadmin__section" aria-labelledby="u-history">
        <div className="kadmin__sectionHead">
          <h2 className="kadmin__sectionTitle" id="u-history">
            Recent applications
          </h2>
        </div>

        {applications.length === 0 ? (
          <div className="kadmin__tableWrap">
            <div className="kadmin__empty">
              <strong>No applications recorded</strong>
              Each application will appear here with its mechanism, executing worker and outcome.
            </div>
          </div>
        ) : (
          <div className="kadmin__tableWrap">
            <table className="kadmin__table">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Method</th>
                  <th scope="col">Status</th>
                  <th scope="col">Worker</th>
                  <th scope="col" className="kadmin__num">
                    Attempts
                  </th>
                  <th scope="col">Queued</th>
                  <th scope="col">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((a) => (
                  <tr key={a.id}>
                    <td data-label="Job">
                      <span className="kadmin__primaryCell">
                        <span>{a.job_title ?? 'Untitled posting'}</span>
                        <span className="kadmin__sub">
                          {a.company_name ?? 'Unknown company'}
                          {a.job_source ? ` · ${a.job_source}` : ''}
                        </span>
                      </span>
                    </td>
                    <td data-label="Method">
                      <span
                        className={`kadmin__badge${a.method === 'bid_bot' ? ' kadmin__badge--bid_bot' : ''}`}
                      >
                        {a.method.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td data-label="Status">
                      <span className={`kadmin__badge kadmin__badge--${a.status}`}>
                        {a.status.replace(/_/g, ' ')}
                      </span>
                      {a.status_code ? <div className="kadmin__sub">{a.status_code}</div> : null}
                    </td>
                    <td data-label="Worker">{text(a.worker_id ?? a.executor_type)}</td>
                    <td data-label="Attempts" className="kadmin__num">
                      {nf.format(a.attempt_count)}
                    </td>
                    <td data-label="Queued">{formatDateTime(a.queued_at)}</td>
                    <td data-label="Submitted">{formatDateTime(a.submitted_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* --------------------------------------------------------- panels -- */}
      <div className="kadmin__panels kadmin__section">
        <section className="kadmin__panel" aria-labelledby="u-account">
          <div className="kadmin__sectionHead">
            <h2 className="kadmin__sectionTitle" id="u-account">
              Account
            </h2>
          </div>
          <dl className="kadmin__dl">
            <Row label="User id" value={<span className="kadmin__sub">{userId}</span>} />
            <Row label="Email" value={text(email)} />
            <Row label="Registered" value={formatDateTime(account.registered_at)} />
            <Row label="Last sign in" value={formatDateTime(account.last_sign_in_at)} />
            <Row label="Email confirmed" value={formatDateTime(account.email_confirmed_at)} />
            <Row label="Invited" value={formatDateTime(account.invited_at)} />
            <Row label="Onboarding completed" value={formatDateTime(account.onboarding_completed_at)} />
            <Row label="Role granted" value={formatDateTime(account.role_granted_at)} />
            <Row label="Jobs taken in" value={nf.format(Number(account.jobs_total ?? 0))} />
          </dl>
        </section>

        <section className="kadmin__panel" aria-labelledby="u-profile">
          <div className="kadmin__sectionHead">
            <h2 className="kadmin__sectionTitle" id="u-profile">
              Candidate profile
            </h2>
          </div>
          {!profile ? (
            <div className="kadmin__empty">
              <strong>No profile yet</strong>
              This account has not completed onboarding.
            </div>
          ) : (
            <dl className="kadmin__dl">
              <Row
                label="Legal name"
                value={text(
                  [profile.legal_first_name, profile.legal_middle_name, profile.legal_last_name]
                    .filter(Boolean)
                    .join(' ') || null
                )}
              />
              <Row label="Preferred name" value={text(profile.preferred_name)} />
              <Row label="Contact email" value={text(profile.contact_email)} />
              <Row label="Phone" value={text(profile.phone_e164)} />
              <Row
                label="Location"
                value={text(
                  [profile.city, profile.state_region, profile.country_code].filter(Boolean).join(', ') ||
                    null
                )}
              />
              <Row label="Timezone" value={text(profile.timezone)} />
              <Row label="LinkedIn" value={text(profile.linkedin_url)} />
              <Row label="GitHub" value={text(profile.github_url)} />
              <Row label="Portfolio" value={text(profile.portfolio_url)} />
            </dl>
          )}
        </section>

        <section className="kadmin__panel" aria-labelledby="u-automation">
          <div className="kadmin__sectionHead">
            <h2 className="kadmin__sectionTitle" id="u-automation">
              Automation settings
            </h2>
          </div>
          {!automation ? (
            <div className="kadmin__empty">
              <strong>Not configured</strong>
              Automation defaults to off until the user enables it.
            </div>
          ) : (
            <dl className="kadmin__dl">
              <Row label="Automation enabled" value={text(automation.is_automation_enabled)} />
              <Row label="Resume tailoring" value={text(automation.allow_resume_tailoring)} />
              <Row label="Cover letters" value={text(automation.allow_cover_letter_generation)} />
              <Row label="Min match score" value={text(automation.min_match_score)} />
              <Row label="Max applications / day" value={text(automation.max_applications_per_day)} />
              <Row label="Stop on CAPTCHA" value={text(automation.stop_on_captcha)} />
              <Row label="Stop on MFA" value={text(automation.stop_on_mfa)} />
              <Row label="Stop on unknown question" value={text(automation.stop_on_unknown_question)} />
              <Row label="Stop on application fee" value={text(automation.stop_on_application_fee)} />
              <Row label="Updated" value={formatDateTime(automation.updated_at)} />
            </dl>
          )}
        </section>

        <section className="kadmin__panel" aria-labelledby="u-skills">
          <div className="kadmin__sectionHead">
            <h2 className="kadmin__sectionTitle" id="u-skills">
              Skills
            </h2>
          </div>
          {skills.length === 0 ? (
            <div className="kadmin__empty">
              <strong>None recorded</strong>
            </div>
          ) : (
            <div className="kadmin__chips">
              {skills.map((s) => (
                <span className="kadmin__badge" key={s}>
                  {s}
                </span>
              ))}
            </div>
          )}
        </section>
      </div>

      {audit.length > 0 ? (
        <section className="kadmin__section" aria-labelledby="u-audit">
          <div className="kadmin__sectionHead">
            <h2 className="kadmin__sectionTitle" id="u-audit">
              Administrative actions on this account
            </h2>
          </div>
          <div className="kadmin__tableWrap">
            <table className="kadmin__table">
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">By</th>
                  <th scope="col">Result</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Action">{row.action}</td>
                    <td data-label="By">{text(row.actor_email)}</td>
                    <td data-label="Result">
                      <span
                        className={`kadmin__badge${row.result === 'failed' ? ' kadmin__badge--failed' : ' kadmin__badge--active'}`}
                      >
                        {row.result}
                        {row.failure_code ? ` · ${row.failure_code}` : ''}
                      </span>
                    </td>
                    <td data-label="When">{formatDateTime(row.occurred_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </AdminShell>
  );
}
