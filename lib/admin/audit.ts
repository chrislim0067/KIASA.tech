import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { logAdminError } from '@/lib/admin/api';
import type { Json } from '@/lib/supabase/database.types';

/**
 * The administrative audit log writer, and the rate limiter built on top of it.
 *
 * Every privileged action writes here — successes AND failures. A log that only
 * records what worked cannot answer "did someone try to delete forty accounts
 * last night", which is the question an audit log exists for.
 */

/** Mirrors the CHECK on `admin_audit_log.action`. */
export const AUDIT_ACTIONS = [
  'user.invited',
  'user.invite_resent',
  'user.deleted',
  'user.role_granted',
  'user.role_revoked',
  'admin.bootstrapped',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  readonly action: AuditAction;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly targetUserId?: string | null;
  readonly targetEmail?: string | null;
  readonly result: 'succeeded' | 'failed';
  /** Required when result is 'failed', rejected otherwise (DB CHECK). */
  readonly failureCode?: string | null;
  readonly detail?: Record<string, unknown>;
}

/**
 * Keys that must never appear in `detail`, at any depth.
 *
 * This is belt-and-braces: callers are expected to pass only what they mean to.
 * But `detail` is the one free-shaped field on the record, it is the natural
 * place for someone to later spread an upstream response object into, and an
 * audit log that quietly accumulates tokens is worse than no audit log. The
 * scrub runs on every write and is asserted by scripts/test-admin-audit.mjs.
 */
const FORBIDDEN_DETAIL_KEYS = [
  'password', 'passwd', 'secret', 'token', 'access_token', 'refresh_token',
  'id_token', 'api_key', 'apikey', 'key', 'authorization', 'auth', 'cookie',
  'session', 'service_role', 'jwt', 'credential', 'credentials',
];

const REDACTED = '[redacted]';
const MAX_DEPTH = 4;

/**
 * Recursively drop anything whose key looks like a secret, and coerce the
 * result into `Json`.
 *
 * The coercion is not cosmetic. `detail` is typed `Json` by the generated
 * schema, and an `undefined`, a `Date` or a function reaching PostgREST would
 * either serialise to something unintended or drop the field silently. Anything
 * that is not already JSON-representable is stringified here, so what lands in
 * the log is exactly what a reader will see.
 */
function scrub(value: unknown, depth = 0): Json {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return null;

  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value as Json;
  if (t === 'number') return Number.isFinite(value as number) ? (value as number) : null;
  if (t !== 'object') return String(value);

  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lowered = k.toLowerCase();
    out[k] = FORBIDDEN_DETAIL_KEYS.some((f) => lowered.includes(f)) ? REDACTED : scrub(v, depth + 1);
  }
  return out;
}

export function scrubDetail(detail: Record<string, unknown>): Json {
  return scrub(detail);
}

/**
 * Write one audit record.
 *
 * Never throws. An audit write failing must not turn a completed deletion into
 * a 500 that invites the administrator to retry it — that would be strictly
 * worse than a missing log line. The failure is loud in the platform log
 * instead, and the return value says whether the record landed so a caller can
 * surface "the action succeeded but was not logged" if it wants to.
 */
export async function recordAudit(entry: AuditEntry): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('admin_audit_log').insert({
      actor_user_id: entry.actorUserId,
      actor_email: entry.actorEmail,
      action: entry.action,
      target_user_id: entry.targetUserId ?? null,
      target_email: entry.targetEmail ?? null,
      result: entry.result,
      failure_code: entry.result === 'failed' ? (entry.failureCode ?? 'unspecified') : null,
      detail: scrubDetail(entry.detail ?? {}),
    });

    if (error) {
      logAdminError('audit.write_failed', error, { action: entry.action });
      return false;
    }
    return true;
  } catch (error) {
    logAdminError('audit.write_threw', error, { action: entry.action });
    return false;
  }
}

/**
 * Rate limit for sensitive administrative operations.
 *
 * Counted from `admin_audit_log` itself rather than from an in-memory counter.
 * That choice matters on Vercel: handlers run across many short-lived
 * instances, so a module-level Map would reset constantly and reset differently
 * per instance — a limiter that looks like protection and is not one. Counting
 * durable rows gives one honest answer regardless of which instance serves the
 * request, and needs no Redis.
 *
 * Because every attempt is audited (successes and failures alike), a caller
 * cannot evade the limit by making requests that fail.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number;
  readonly windowMinutes: number;
}

export async function checkRateLimit(
  actorUserId: string,
  actions: readonly AuditAction[],
  limit: number,
  windowMinutes: number
): Promise<RateLimitDecision> {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  try {
    const admin = createAdminClient();
    const { count, error } = await admin
      .from('admin_audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('actor_user_id', actorUserId)
      .in('action', actions as string[])
      .gte('occurred_at', since);

    if (error) {
      logAdminError('audit.rate_limit_query_failed', error, { actor_user_id: actorUserId });
      // Fail OPEN, deliberately. This limiter exists to blunt abuse and
      // mistakes by an already-authenticated administrator, not to stop an
      // attacker — authorization has already happened by the time we get here.
      // Locking every administrator out of user management because a COUNT
      // query failed would cause a worse outage than the one it prevents.
      return { allowed: true, used: 0, limit, windowMinutes };
    }

    const used = count ?? 0;
    return { allowed: used < limit, used, limit, windowMinutes };
  } catch (error) {
    logAdminError('audit.rate_limit_threw', error, { actor_user_id: actorUserId });
    return { allowed: true, used: 0, limit, windowMinutes };
  }
}

/** Limits, named so the numbers are not scattered through the handlers. */
export const RATE_LIMITS = Object.freeze({
  invite: Object.freeze({ limit: 20, windowMinutes: 60 }),
  // Deletion is destructive and irreversible; a legitimate administrator has no
  // reason to delete ten accounts in an hour, and an automated mistake has
  // every reason to try.
  deletion: Object.freeze({ limit: 10, windowMinutes: 60 }),
  roleChange: Object.freeze({ limit: 20, windowMinutes: 60 }),
});
