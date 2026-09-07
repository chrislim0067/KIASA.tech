#!/usr/bin/env node
/**
 * Create the first administrator.
 *
 *   node scripts/bootstrap-admin.mjs someone@example.com
 *   node scripts/bootstrap-admin.mjs someone@example.com --revoke
 *   node scripts/bootstrap-admin.mjs --list
 *
 * WHY A SCRIPT, AND WHY THIS SHAPE
 *
 * The platform starts with no administrators, so something has to make the
 * first one, and every convenient way of doing that is a vulnerability:
 *
 *   * "first account to register becomes admin" — a race anyone can win by
 *     signing up before the owner does;
 *   * a `/make-me-admin` route — a public privilege-escalation endpoint, even
 *     behind an env-var check, because that check ships to whoever can reach it;
 *   * an email address hardcoded in the frontend — published in the client
 *     bundle, and a rename or a typo silently grants nobody or somebody else;
 *   * a migration that inserts a specific user id — the id does not exist until
 *     that person registers, so the migration either fails or is a no-op, and
 *     it ends up committed to the repository naming a real person.
 *
 * A script run by someone who already holds the secret key adds no new
 * privilege path: anyone who can run it could already write the table directly.
 * It exists to make the operation correct, auditable and hard to get wrong,
 * not to grant access that was not already implied by holding the key.
 *
 * REQUIREMENTS
 *   NEXT_PUBLIC_SUPABASE_URL   the project URL
 *   SUPABASE_SECRET_KEY        the service/secret key — server-side only
 *
 * The target must already have a KIASA account. This grants a role; it does not
 * create a login, so there is no path here that mints an account nobody asked
 * for.
 *
 * Every run writes an `admin.bootstrapped` row to admin_audit_log, so a role
 * granted out-of-band is as visible as one granted through the UI.
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Load .env.local for local use. Vercel and CI provide real env vars instead. */
function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '').trim();
  }
}

function die(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;

if (!url) die('NEXT_PUBLIC_SUPABASE_URL is not set.');
if (!secret) {
  die(
    'SUPABASE_SECRET_KEY is not set.\n' +
      '    Local:      add it to .env.local (see .env.example).\n' +
      '    Production: read it from the Supabase dashboard and export it for this\n' +
      '                command only — never commit it, and never prefix it NEXT_PUBLIC_.'
  );
}

/**
 * Refuse to point production credentials at a local URL or vice versa by
 * accident is impossible to detect in general — but printing which project is
 * being modified lets the operator abort before confirming.
 */
const host = new URL(url).host;

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const revoke = args.includes('--revoke');
const email = args.find((a) => !a.startsWith('--'));

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Resolve an email to a user id through the directory view. */
async function findByEmail(address) {
  const { data, error } = await admin
    .from('admin_user_directory')
    .select('user_id, email, role, account_status')
    .ilike('email', address)
    .limit(1)
    .maybeSingle();

  if (error) die(`Could not look up that address: ${error.message}`);
  return data ?? null;
}

async function listAdmins() {
  const { data, error } = await admin
    .from('admin_user_directory')
    .select('user_id, email, role, account_status, registered_at')
    .eq('role', 'admin')
    .order('registered_at', { ascending: true });

  if (error) die(`Could not list administrators: ${error.message}`);
  return data ?? [];
}

async function main() {
  console.log(`\n  Project: ${host}`);

  if (listOnly) {
    const admins = await listAdmins();
    if (admins.length === 0) {
      console.log('\n  No administrators exist yet.\n');
      return;
    }
    console.log(`\n  ${admins.length} administrator(s):\n`);
    for (const a of admins) {
      console.log(`    ${a.email}  (${a.user_id})  ${a.account_status}`);
    }
    console.log('');
    return;
  }

  if (!email) {
    die(
      'Pass the email address of an existing KIASA account.\n' +
        '    node scripts/bootstrap-admin.mjs someone@example.com\n' +
        '    node scripts/bootstrap-admin.mjs --list'
    );
  }

  const account = await findByEmail(email);
  if (!account) {
    die(
      `No KIASA account exists for ${email}.\n` +
        '    They must sign up (or be invited) first. This grants a role to an\n' +
        '    existing account; it deliberately cannot create one.'
    );
  }

  if (revoke) {
    const admins = await listAdmins();
    if (admins.length <= 1 && account.role === 'admin') {
      die(
        'That is the only administrator. Grant the role to someone else before\n' +
          '    revoking it, or the platform will have no administrator at all.'
      );
    }

    const { error } = await admin.from('user_roles').delete().eq('user_id', account.user_id);
    if (error) die(`Could not revoke the role: ${error.message}`);

    await admin.from('admin_audit_log').insert({
      actor_user_id: null,
      actor_email: 'scripts/bootstrap-admin.mjs',
      action: 'user.role_revoked',
      target_user_id: account.user_id,
      target_email: account.email,
      result: 'succeeded',
      detail: { via: 'bootstrap_script' },
    });

    console.log(`\n  ✓ Administrator role revoked from ${account.email}\n`);
    return;
  }

  if (account.role === 'admin') {
    console.log(`\n  • ${account.email} is already an administrator. Nothing to do.\n`);
    return;
  }

  const { error } = await admin.from('user_roles').upsert(
    {
      user_id: account.user_id,
      role: 'admin',
      // NULL: there is no granting administrator for the first one, and
      // pretending otherwise would put a false attribution in the record.
      granted_by: null,
      note: 'Granted via scripts/bootstrap-admin.mjs',
    },
    { onConflict: 'user_id' }
  );

  if (error) die(`Could not grant the role: ${error.message}`);

  const { error: auditError } = await admin.from('admin_audit_log').insert({
    actor_user_id: null,
    actor_email: 'scripts/bootstrap-admin.mjs',
    action: 'admin.bootstrapped',
    target_user_id: account.user_id,
    target_email: account.email,
    result: 'succeeded',
    detail: { via: 'bootstrap_script', project_host: host },
  });

  // The grant succeeded; a failed audit write is worth shouting about but must
  // not be reported as a failed grant.
  if (auditError) {
    console.warn(`\n  ! Role granted, but the audit entry failed: ${auditError.message}`);
  }

  console.log(`\n  ✓ ${account.email} is now a KIASA administrator.`);
  console.log(`    user id: ${account.user_id}`);
  console.log('    They can sign in normally and open /admin.\n');
  console.log('    From here, further role changes should be made in the admin UI so');
  console.log('    they are attributed to the administrator who made them.\n');
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
