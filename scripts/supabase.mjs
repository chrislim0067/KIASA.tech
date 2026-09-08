/**
 * Passthrough to the repository-local pinned Supabase CLI.
 *
 *   node scripts/supabase.mjs start
 *   node scripts/supabase.mjs db reset
 *
 * Exists so package.json scripts can reach the pinned CLI with one spelling
 * that works on Windows, macOS and Linux. `npx supabase` is not an option:
 * with no local install it downloads whatever is newest, which is how the
 * project ended up running an unpinned CLI against pinned migrations.
 *
 * Arguments are forwarded verbatim and the CLI's exit code is propagated, so
 * this is invisible to anything reading the result.
 */
import { supabaseSpawn, assertPinnedVersion } from './lib/supabase-cli.mjs';

try {
  assertPinnedVersion();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const result = supabaseSpawn(process.argv.slice(2), { stdio: 'inherit' });

if (result.error) {
  console.error(`Could not run the Supabase CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
