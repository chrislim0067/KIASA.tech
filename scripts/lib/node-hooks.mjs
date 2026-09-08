/**
 * Module-resolution hooks so the tests can import the application's TypeScript.
 *
 *   node --import ./scripts/lib/register-hooks.mjs scripts/test-resume-provider.mjs
 *
 * TEST-ONLY. Nothing in the application loads this, and it changes nothing
 * about how Next builds or runs.
 *
 * Two things stand between plain Node and the résumé modules:
 *
 *   * `server-only` is not a real package on disk — Next aliases it during the
 *     build, where its whole purpose is to fail if a client bundle imports it.
 *     Outside Next it simply does not resolve, so it is mapped to an empty
 *     module here. The guarantee it provides is a BUILD guarantee, and the
 *     build still enforces it; stubbing it in a test process removes nothing.
 *
 *   * `@/...` is a tsconfig path alias Node knows nothing about. It is mapped
 *     to the repository root, matching `paths` in tsconfig.json.
 *
 * Node 24 strips TypeScript types natively, so no compiler or bundler is
 * involved — the tests import the very files the application ships.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EMPTY = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'empty-module.mjs')).href;

/** Build-time-only markers that have no runtime module outside Next. */
const NEXT_BUILD_MARKERS = new Set(['server-only', 'client-only']);

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, nextResolve) {
  if (NEXT_BUILD_MARKERS.has(specifier)) {
    return { url: EMPTY, shortCircuit: true };
  }

  if (specifier.startsWith('@/')) {
    const base = path.join(ROOT, specifier.slice(2));
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = base + suffix;
      // existsSync is true for directories too, so require a real file.
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}
