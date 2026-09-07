import type { Metadata } from 'next';
import Link from 'next/link';

import AdminShell from '@/components/admin/AdminShell';
import { requireAdminPage } from '@/lib/admin/page-guard';
import { getRecentAudit } from '@/lib/admin/queries';
import { logAdminError } from '@/lib/admin/api';

/**
 * /admin/audit — the administrative audit log.
 *
 * Read-only by construction, not by convention: `admin_audit_log` grants only
 * SELECT and INSERT, to service_role alone, and an UPDATE trigger refuses every
 * role including the table owner. There is no edit control on this page because
 * there is no way to build one.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Audit | KIASA Admin',
  robots: { index: false, follow: false, nocache: true },
};

function formatDateTime(value: string): string {
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

export default async function AdminAuditPage() {
  const { user } = await requireAdminPage('audit.read');

  let rows: Awaited<ReturnType<typeof getRecentAudit>> = [];
  let failed = false;

  try {
    rows = await getRecentAudit(200);
  } catch (error) {
    failed = true;
    logAdminError('audit.page', error, { actor_user_id: user.id });
  }

  return (
    <AdminShell
      title="Audit log"
      lede="Every privileged action, successful or refused. Append-only — entries cannot be edited or deleted by anyone, including the database owner."
      actorEmail={user.email ?? null}
      currentPath="/admin/audit"
    >
      {failed ? (
        <div className="kadmin__notice kadmin__notice--danger">
          <p>
            <strong>The audit log could not be loaded.</strong>
          </p>
          <p>Nothing was changed. The failure is recorded in the server log.</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="kadmin__tableWrap">
          <div className="kadmin__empty">
            <strong>Nothing logged yet</strong>
            Invitations, deletions and role changes will be recorded here as they happen.
          </div>
        </div>
      ) : (
        <div className="kadmin__tableWrap">
          <table className="kadmin__table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Action</th>
                <th scope="col">Administrator</th>
                <th scope="col">Target</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td data-label="When">{formatDateTime(row.occurred_at)}</td>
                  <td data-label="Action">{row.action}</td>
                  <td data-label="Administrator">{row.actor_email ?? '—'}</td>
                  <td data-label="Target">
                    <span className="kadmin__primaryCell">
                      <span>{row.target_email ?? '—'}</span>
                      {row.target_user_id ? (
                        <Link href={`/admin/users/${row.target_user_id}`} className="kadmin__sub">
                          {row.target_user_id}
                        </Link>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Result">
                    <span
                      className={`kadmin__badge ${row.result === 'failed' ? 'kadmin__badge--failed' : 'kadmin__badge--active'}`}
                    >
                      {row.result}
                      {row.failure_code ? ` · ${row.failure_code}` : ''}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
