#!/usr/bin/env node
/**
 * Failure-safe database type generation.  (Review finding M4)
 *
 *   npm run db:types
 *   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run db:types
 *
 * The previous script was:
 *
 *     supabase gen types typescript --local > lib/supabase/database.types.ts
 *
 * A shell redirect truncates the target BEFORE the command runs, so any failure
 * — the CLI missing from PATH, the database being down — leaves a 0-byte types
 * file. That happened during Step 2C and was only caught by chance.
 *
 * This generates into a temporary file, validates it, and only then replaces the
 * real one. On any failure the temporary file is deleted and the existing types
 * file is left byte-for-byte untouched.
 *
 * Cross-platform: no shell redirection, no shell-specific syntax. Output is
 * captured through the child process's stdout and written by Node.
 */
import { supabaseSpawn } from './lib/supabase-cli.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TARGET = path.join(ROOT, 'lib', 'supabase', 'database.types.ts');

/** Loopback only. A hosted Supabase host must never be reachable from here. */
function assertLocal(dbUrl) {
  let host;
  try {
    host = new URL(dbUrl).hostname;
  } catch {
    throw new Error(`DB_URL is not a valid URL: ${String(dbUrl).slice(0, 40)}…`);
  }
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!loopback) {
    throw new Error(
      `Refusing to generate types from a non-loopback database (host "${host}"). ` +
        'This script is local-only; it must never touch a hosted project.'
    );
  }
}

/** Enough structure to be confident this is real generated output. */
function looksValid(text) {
  const problems = [];
  if (text.trim().length === 0) problems.push('file is empty');
  if (text.length < 500) problems.push(`suspiciously short (${text.length} bytes)`);
  if (!/export type Database\b/.test(text)) problems.push('missing "export type Database"');
  if (!/\bTables\b/.test(text)) problems.push('missing "Tables"');
  if (!/\bprofiles\b/.test(text)) problems.push('missing the profiles table');
  return problems;
}

const dbUrl = process.env.DB_URL;
const args = ['gen', 'types', 'typescript', '--schema', 'public'];

if (dbUrl) {
  assertLocal(dbUrl);
  args.push('--db-url', dbUrl);
} else {
  args.push('--local'); // the CLI's own local stack; loopback by definition
}

const tmp = path.join(os.tmpdir(), `kiasa-types-${process.pid}-${Date.now()}.ts`);
let previous = null;
if (fs.existsSync(TARGET)) previous = fs.readFileSync(TARGET);

function fail(message, detail = '') {
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp);
  } catch { /* best effort */ }
  console.error(`type generation FAILED: ${message}`);
  if (detail) console.error(detail.trim().split('\n').slice(0, 5).join('\n'));
  if (previous !== null) {
    // Prove, rather than assume, that the original survived.
    const now = fs.readFileSync(TARGET);
    const intact = now.equals(previous);
    console.error(`existing types file left ${intact ? 'UNCHANGED' : 'MODIFIED — THIS IS A BUG'} (${now.length} bytes)`);
    if (!intact) process.exit(2);
  } else {
    console.error('no previous types file existed; none was created');
  }
  process.exit(1);
}

// The repository-local pinned CLI. Never `npx`, which would download a
// different version rather than failing when it is missing.
const result = supabaseSpawn(args);

if (result.error) fail('could not run the Supabase CLI', String(result.error.message));
if (result.status !== 0) fail(`Supabase CLI exited with code ${result.status}`, result.stderr ?? '');

const output = result.stdout ?? '';
fs.writeFileSync(tmp, output);

const problems = looksValid(output);
if (problems.length) fail(`generated output failed validation: ${problems.join('; ')}`);

// Only now is it safe to replace the real file.
fs.copyFileSync(tmp, TARGET);
fs.rmSync(tmp);

const lines = output.split('\n').length;
console.log(`types written: ${path.relative(ROOT, TARGET)} (${output.length} bytes, ${lines} lines)`);
