import type { Metadata } from 'next';
import Link from 'next/link';

import AdminShell from '@/components/admin/AdminShell';
import InviteUserPanel from '@/components/admin/InviteUserPanel';
import { requireAdminPage } from '@/lib/admin/page-guard';
import {
  listUsers,
  USER_SORT_FIELDS,
  ACCOUNT_STATUSES,
  MAX_PAGE_SIZE,
  type UserSortField,
  type AccountStatus,
} from '@/lib/admin/queries';
import { APP_ROLES, type AppRole } from '@/lib/auth/roles';
import { logAdminError } from '@/lib/admin/api';

/**
 * /admin/users — the paginated, searchable, filterable user list.
 *
 * Rendered entirely on the server, with state carried in the URL rather than in
 * React. That is a deliberate choice: a filtered list is then linkable and
 * back-button-correct, the search runs as an indexed query rather than over a
 * page already in the browser, and the page ships no user data to a client
 * bundle. The only client component on the screen is the invite dialog, which
 * genuinely needs interactivity.
 *
 * Pagination, search and filtering all execute in PostgreSQL. There is one
 * query for the page and one count — never a query per user.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Users | KIASA Admin',
  robots: { index: false, follow: false, nocache: true },
};

const DEFAULT_PAGE_SIZE = 25;
const nf = new Intl.NumberFormat('en-GB');

type SearchParams = Record<string, string | string[] | undefined>;

/** First value only; an array means the parameter was repeated in the URL. */
function one(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Anything outside the allow-list becomes null rather than reaching the query. */
function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Preserve the current filters when building a link that changes one thing. */
function buildQuery(base: SearchParams, changes: Record<string, string | null>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    const value = one(v);
    if (value) params.set(k, value);
  }
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) params.delete(k);
    else params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user } = await requireAdminPage('users.list');
  const sp = await searchParams;

  const page = Math.max(1, Number.parseInt(one(sp.page) ?? '1', 10) || 1);
  const pageSize = Math.min(
    Math.max(1, Number.parseInt(one(sp.pageSize) ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );
  const search = one(sp.search);
  const role = pick<AppRole>(one(sp.role), APP_ROLES);
  const status = pick<AccountStatus>(one(sp.status), ACCOUNT_STATUSES);
  const sort = pick<UserSortField>(one(sp.sort), USER_SORT_FIELDS) ?? 'registered_at';
  const direction = one(sp.direction) === 'asc' ? 'asc' : 'desc';

  let rows: Awaited<ReturnType<typeof listUsers>>['rows'] = [];
  let total = 0;
  let failed = false;

  try {
    const result = await listUsers({
      page,
      pageSize,
      search,
      role,
      status,
      sort,
      direction,
      hasApplications: one(sp.hasApplications) === 'true',
    });
    rows = result.rows;
    total = result.total;
  } catch (error) {
    failed = true;
    logAdminError('users.list_page', error, { actor_user_id: user.id });
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const showing = rows.length;

  /** A sortable column header toggles direction when it is already active. */
  const sortLink = (field: UserSortField, label: string) => {
    const active = sort === field;
    const nextDirection = active && direction === 'desc' ? 'asc' : 'desc';
    return (
      <a href={`/admin/users${buildQuery(sp, { sort: field, direction: nextDirection, page: '1' })}`}>
        {label}
        {active ? (direction === 'desc' ? ' ↓' : ' ↑') : ''}
      </a>
    );
  };

  return (
    <AdminShell
      title="Users"
      lede={
        failed
          ? undefined
          : `${nf.format(total)} account${total === 1 ? '' : 's'} registered. Search matches email, name and user id.`
      }
      actorEmail={user.email ?? null}
      currentPath="/admin/users"
    >
      <InviteUserPanel />

      {/* GET, so the filter state lands in the URL and the page stays linkable. */}
      <form className="kadmin__filters" method="get" action="/admin/users">
        <div className="kadmin__field kadmin__field--grow">
          <label className="kadmin__label" htmlFor="f-search">
            Search
          </label>
          <input
            id="f-search"
            name="search"
            type="search"
            className="kadmin__input"
            placeholder="Email, name, or user id"
            defaultValue={search ?? ''}
            autoComplete="off"
          />
        </div>

        <div className="kadmin__field">
          <label className="kadmin__label" htmlFor="f-role">
            Role
          </label>
          <select id="f-role" name="role" className="kadmin__select" defaultValue={role ?? ''}>
            <option value="">Any</option>
            {APP_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div className="kadmin__field">
          <label className="kadmin__label" htmlFor="f-status">
            Status
          </label>
          <select id="f-status" name="status" className="kadmin__select" defaultValue={status ?? ''}>
            <option value="">Any</option>
            {ACCOUNT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>

        <div className="kadmin__field">
          <label className="kadmin__label" htmlFor="f-size">
            Per page
          </label>
          <select id="f-size" name="pageSize" className="kadmin__select" defaultValue={String(pageSize)}>
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        {/* Carried so applying a filter does not silently reset the sort. */}
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="direction" value={direction} />

        <button type="submit" className="kadmin__button">
          Apply
        </button>
        <Link href="/admin/users" className="kadmin__button kadmin__button--ghost">
          Reset
        </Link>
      </form>

      {failed ? (
        <div className="kadmin__notice kadmin__notice--danger">
          <p>
            <strong>The user list could not be loaded.</strong>
          </p>
          <p>
            Nothing was changed. The failure is recorded in the server log; try again, and if it
            persists check that <code>SUPABASE_SECRET_KEY</code> is set for this environment.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="kadmin__tableWrap">
          <div className="kadmin__empty">
            <strong>No users match those filters</strong>
            {search || role || status
              ? 'Try widening the search, or reset the filters.'
              : 'Accounts will appear here as people register or are invited.'}
          </div>
        </div>
      ) : (
        <div className="kadmin__tableWrap">
          <table className="kadmin__table">
            <caption className="kadmin__statLabel" style={{ padding: '0.75rem 1rem', textAlign: 'left' }}>
              Showing {nf.format(showing)} of {nf.format(total)}
            </caption>
            <thead>
              <tr>
                <th scope="col">{sortLink('email', 'User')}</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">{sortLink('registered_at', 'Registered')}</th>
                <th scope="col">{sortLink('last_activity_at', 'Last activity')}</th>
                <th scope="col" className="kadmin__num">
                  {sortLink('applications_total', 'Apps')}
                </th>
                <th scope="col" className="kadmin__num">
                  Sent
                </th>
                <th scope="col" className="kadmin__num">
                  {sortLink('bid_bot_total', 'Bid Bot')}
                </th>
                <th scope="col" className="kadmin__num">
                  Jobs
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.user_id}>
                  <td data-label="User">
                    <span className="kadmin__primaryCell">
                      <Link href={`/admin/users/${u.user_id}`}>{u.display_name ?? u.email ?? 'Unnamed'}</Link>
                      {u.display_name && u.email ? (
                        <span className="kadmin__sub">{u.email}</span>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Role">
                    <span className={`kadmin__badge${u.role === 'admin' ? ' kadmin__badge--admin' : ''}`}>
                      {u.role}
                    </span>
                  </td>
                  <td data-label="Status">
                    <span className={`kadmin__badge kadmin__badge--${u.account_status}`}>
                      {u.account_status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td data-label="Registered">{formatDate(u.registered_at)}</td>
                  <td data-label="Last activity">{formatDate(u.last_activity_at)}</td>
                  <td data-label="Applications" className="kadmin__num">
                    {nf.format(u.applications_total)}
                  </td>
                  <td data-label="Submitted" className="kadmin__num">
                    {nf.format(u.applications_succeeded)}
                  </td>
                  <td data-label="Bid Bot" className="kadmin__num">
                    {nf.format(u.bid_bot_total)}
                  </td>
                  <td data-label="Jobs" className="kadmin__num">
                    {nf.format(u.jobs_total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!failed && rows.length > 0 ? (
        <nav className="kadmin__pager" aria-label="Pagination">
          <span>
            Page {nf.format(page)} of {nf.format(pageCount)}
          </span>
          <span className="kadmin__pagerLinks">
            {page > 1 ? (
              <a href={`/admin/users${buildQuery(sp, { page: String(page - 1) })}`} rel="prev">
                Previous
              </a>
            ) : (
              <span aria-disabled="true">Previous</span>
            )}
            {page < pageCount ? (
              <a href={`/admin/users${buildQuery(sp, { page: String(page + 1) })}`} rel="next">
                Next
              </a>
            ) : (
              <span aria-disabled="true">Next</span>
            )}
          </span>
        </nav>
      ) : null}
    </AdminShell>
  );
}
