import 'server-only';

import { redirect } from 'next/navigation';

import { resolveAdmin } from '@/lib/admin/guard';
import type { AdminContext } from '@/lib/admin/guard';
import type { Capability } from '@/lib/auth/roles';
import { LOGIN, DASHBOARD } from '@/lib/auth/routes';

/**
 * Page-level authorization.
 *
 * Every administrator PAGE awaits this before rendering anything. It is the
 * authoritative check — the same relationship `/dashboard` has with the proxy:
 * proxy.ts performs an optimistic redirect, and the page itself decides.
 *
 * This is called per page rather than once in the admin layout. Next.js layouts
 * do not re-render on every navigation within their segment, so a check placed
 * only in a layout can be skipped by a client-side navigation between admin
 * routes. Per-page is the shape that cannot be bypassed.
 */
export async function requireAdminPage(
  capability: Capability = 'admin.access'
): Promise<AdminContext> {
  const result = await resolveAdmin(capability);

  if (result.ok) return { user: result.user, role: result.role };

  switch (result.reason) {
    case 'unauthenticated':
      // Same shape the proxy uses, so signing in returns them where they were.
      redirect(`${LOGIN}?redirectTo=%2Fadmin`);
    // falls through — redirect() throws, so nothing below runs
    case 'unconfigured':
      redirect(DASHBOARD);
    case 'forbidden':
    default:
      // A signed-in non-administrator is sent to their own dashboard. No error
      // page, because there is nothing useful they can do with the information,
      // and the API surface already answers 403 for anything programmatic.
      redirect(DASHBOARD);
  }
}
