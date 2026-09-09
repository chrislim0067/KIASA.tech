/**
 * Registers the test-only resolution hooks. See scripts/lib/node-hooks.mjs.
 */
import { register } from 'node:module';
register('./node-hooks.mjs', import.meta.url);
