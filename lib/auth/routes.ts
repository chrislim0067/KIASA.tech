/**
 * Route policy shared by proxy.ts and the pages themselves.
 *
 * Kept in one place so the optimistic redirect in the proxy and the
 * authoritative check in the page can never drift apart.
 */

/**
 * Signed-out visitors are redirected to LOGIN. Add future private areas here.
 *
 * `/admin` is listed so an anonymous visitor is bounced to the login screen
 * without a wasted render, exactly as `/dashboard` is. That is ALL this does:
 * it is the optimistic check the Next docs describe, and it distinguishes only
 * "signed in" from "signed out". It knows nothing about roles, and an ordinary
 * signed-in user passes it freely.
 *
 * Administrator authorization happens in `requireAdminPage()` on every /admin
 * page and `guardApi()` in every /api/admin handler. Listing a prefix here is
 * never what makes a route administrator-only.
 *
 * `/pending` is the waiting screen for an account that has confirmed its email
 * but has not been approved. It needs a session to say anything useful, so it
 * belongs here too — and the approval gate itself lives in the page, not here.
 */
export const PROTECTED_PREFIXES = ['/dashboard', '/admin', '/pending', '/profile'] as const;

/** Signed-in visitors are redirected to DASHBOARD — no point showing these. */
export const AUTH_ONLY_ROUTES = ['/login', '/signup'] as const;

export const LOGIN = '/login';
export const DASHBOARD = '/dashboard';
export const AFTER_SIGNOUT = '/';

/** Where the callback sends users once a link is verified. */
export const DEFAULT_AFTER_AUTH = DASHBOARD;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function isAuthOnlyPath(pathname: string): boolean {
  return AUTH_ONLY_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Only same-origin, absolute paths may be used as a post-login destination.
 * Anything else (protocol-relative "//evil.com", absolute URLs, or a path that
 * would bounce straight back to the login screen) falls back to the dashboard —
 * this is what stops `?redirectTo=` becoming an open redirect.
 */
export function safeRedirectTarget(value: string | null | undefined): string {
  if (!value) return DEFAULT_AFTER_AUTH;
  if (!value.startsWith('/')) return DEFAULT_AFTER_AUTH;
  if (value.startsWith('//')) return DEFAULT_AFTER_AUTH;
  if (isAuthOnlyPath(value)) return DEFAULT_AFTER_AUTH;
  return value;
}
