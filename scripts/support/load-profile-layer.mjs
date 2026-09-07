/**
 * Loads the real `lib/profile` data layer into a plain Node test process.
 *
 * The tests exercise the shipped implementation rather than a re-implementation
 * of it, which is the only way a test can actually protect the layer. Two
 * things stand between Node and those TypeScript modules, and both are handled
 * here rather than by weakening the product code:
 *
 *   1. `import 'server-only'` — a build-time alias supplied by Next, not a real
 *      package, so it does not resolve under plain Node. It is mapped to an
 *      empty module. The marker stays in the source, where it does its actual
 *      job of keeping this code out of a client bundle.
 *
 *   2. Extensionless relative imports (`./operations`) — valid under the
 *      repository's `moduleResolution: "bundler"`, but Node ESM requires the
 *      extension. The hook appends `.ts`.
 *
 * Node ≥22.18 strips TypeScript types natively, so no build step or transpiler
 * dependency is involved. `registerHooks` is synchronous and in-process, so it
 * affects only this test run.
 */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LAYER_URLS = ['profile', 'jobs'].map(
  (dir) => pathToFileURL(path.join(ROOT, 'lib', dir) + path.sep).href,
);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export{}', shortCircuit: true };
    }
    // Scoped deliberately to the layer's own directory. Rewriting every
    // extensionless relative specifier would also hit CommonJS internals inside
    // node_modules (`./FunctionsClient`), which are not TypeScript and must be
    // left to Node's normal resolution.
    const importer = context.parentURL ?? '';
    if (
      LAYER_URLS.some((layer) => importer.startsWith(layer))
      && /^\.{1,2}\//.test(specifier)
      && !/\.[cm]?[jt]s$/.test(specifier)
    ) {
      return next(`${specifier}.ts`, context);
    }
    // The layers address each other through the repository's "@/" alias, which
    // is a tsconfig path mapping that Node knows nothing about. Only runtime
    // imports reach here; the type-only ones are erased before resolution.
    if (specifier.startsWith('@/')) {
      const target = path.join(ROOT, specifier.slice(2));
      return next(pathToFileURL(/\.[cm]?[jt]s$/.test(target) ? target : `${target}.ts`).href, context);
    }
    return next(specifier, context);
  },
});

/** Each layer's public surface, exactly as an application would import it. */
export const profile = await import(pathToFileURL(path.join(ROOT, 'lib', 'profile', 'index.ts')).href);
export const jobs = await import(pathToFileURL(path.join(ROOT, 'lib', 'jobs', 'index.ts')).href);
export const REPO_ROOT = ROOT;
