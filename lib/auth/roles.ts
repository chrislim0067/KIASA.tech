/**
 * The authorization model.
 *
 * Shared by the proxy, the admin pages and the admin route handlers so the
 * definition of "administrator" cannot drift between them — the same reason
 * `lib/auth/routes.ts` centralises route policy.
 *
 * The rules this file encodes, and the reasoning behind each:
 *
 *   * A role lives in `public.user_roles`, written only by a server holding the
 *     service key. `authenticated` has SELECT and nothing else on that table
 *     (migration 14), so a signed-in user cannot grant themselves a role: the
 *     privilege to try does not exist.
 *
 *   * The ABSENCE of a row means {@link DEFAULT_ROLE}. A read that fails, or an
 *     account that predates this table, therefore degrades to the LEAST
 *     privilege rather than the most. There is no backfill and no migration
 *     risk for existing accounts.
 *
 *   * Role never comes from the client. Not from localStorage, not from a
 *     cookie the browser controls, not from React state, not from a query
 *     parameter, not from the request body. It is read server-side from the
 *     database on every privileged request. Hiding a nav link is a UX detail;
 *     `requireAdmin()` in lib/admin/guard.ts is the boundary.
 */

/** Roles KIASA actually has. Mirrors the CHECK on `user_roles.role`. */
export const APP_ROLES = ['user', 'admin'] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** What a user with no `user_roles` row is treated as. */
export const DEFAULT_ROLE: AppRole = 'user';

export const isAppRole = (value: unknown): value is AppRole =>
  typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value);

/**
 * Capabilities, named by what they permit rather than by who holds them.
 *
 * Authorization decisions are written against a capability
 * (`can(role, 'users.delete')`), never against a role name (`role === 'admin'`).
 * That indirection is the whole extensibility story: adding `support` or
 * `reviewer` later is one new entry in {@link ROLE_CAPABILITIES} plus a CHECK
 * change in a migration, and every existing call site keeps working because it
 * asked about a capability, not an identity. No speculative roles are declared
 * here — the mechanism is ready for them, the vocabulary is not cluttered by
 * them.
 */
export const CAPABILITIES = [
  'admin.access',      // may enter /admin at all
  'users.list',        // may list and search all users
  'users.read',        // may read another user's profile and statistics
  'users.invite',      // may invite a new user
  'users.delete',      // may delete a user
  'roles.grant',       // may change another user's role
  'audit.read',        // may read the administrative audit log
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ADMIN_CAPABILITIES: readonly Capability[] = Object.freeze([...CAPABILITIES]);

/**
 * The capability map. An ordinary user holds nothing here — every capability in
 * this file is administrative, and a normal user's own access to their own data
 * is governed by RLS, not by this table.
 */
export const ROLE_CAPABILITIES: Readonly<Record<AppRole, readonly Capability[]>> = Object.freeze({
  user: Object.freeze([]),
  admin: ADMIN_CAPABILITIES,
});

/** Whether `role` may perform `capability`. */
export function can(role: AppRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

/**
 * Convenience for the common check. Kept as a function rather than a literal
 * comparison so that if a second administrative role ever exists, the places
 * that ask "is this person staff" do not all have to be found and edited.
 */
export function isAdminRole(role: AppRole): boolean {
  return can(role, 'admin.access');
}

/** Where the administrator area lives. */
export const ADMIN_ROOT = '/admin';

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_ROOT || pathname.startsWith(`${ADMIN_ROOT}/`);
}
