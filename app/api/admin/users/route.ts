import { guardApi, apiOk, apiError, logAdminError } from '@/lib/admin/api';
import {
  listUsers,
  MAX_PAGE_SIZE,
  USER_SORT_FIELDS,
  ACCOUNT_STATUSES,
  type UserSortField,
  type AccountStatus,
} from '@/lib/admin/queries';
import { APP_ROLES, type AppRole } from '@/lib/auth/roles';

/**
 * GET /api/admin/users — the paginated, searchable user list.
 *
 * The administrator PAGES render this data server-side and do not call this
 * endpoint; it exists for programmatic use and because an authorization
 * boundary that can be exercised over HTTP is one that can be tested over HTTP.
 * scripts/test-admin-authorization.mjs drives exactly this route as an
 * anonymous visitor, an ordinary user and an administrator.
 */

// Never prerendered, never cached: the response depends on the caller's session
// and contains other people's personal data.
export const dynamic = 'force-dynamic';

/** Reject anything not in the allow-list rather than passing it to the query. */
function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export async function GET(request: Request) {
  const guard = await guardApi('users.list');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const q = url.searchParams;

  const page = Number.parseInt(q.get('page') ?? '1', 10);
  const pageSize = Number.parseInt(q.get('pageSize') ?? '25', 10);

  // Sort and filter values reach an ORDER BY and a WHERE. They are matched
  // against a fixed list rather than sanitised, so an unexpected value becomes
  // the default instead of reaching PostgREST at all.
  const sort: UserSortField = pick(q.get('sort'), USER_SORT_FIELDS) ?? 'registered_at';
  const direction = q.get('direction') === 'asc' ? 'asc' : 'desc';
  const role: AppRole | null = pick(q.get('role'), APP_ROLES);
  const status: AccountStatus | null = pick(q.get('status'), ACCOUNT_STATUSES);

  try {
    const { rows, total } = await listUsers({
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 25,
      search: q.get('search'),
      role,
      status,
      sort,
      direction,
      registeredAfter: q.get('registeredAfter'),
      hasApplications: q.get('hasApplications') === 'true',
    });

    const effectivePageSize = Math.min(Math.max(1, pageSize || 25), MAX_PAGE_SIZE);

    return apiOk({
      users: rows,
      pagination: {
        page: Math.max(1, page || 1),
        pageSize: effectivePageSize,
        total,
        pageCount: Math.max(1, Math.ceil(total / effectivePageSize)),
      },
    });
  } catch (error) {
    logAdminError('users.list', error, { actor_user_id: guard.ctx.user.id });
    return apiError('internal_error', 'The user list could not be loaded.');
  }
}
