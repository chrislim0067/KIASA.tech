import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Generated from the original markup: plain anchors are intentional, the experience
    // navigation controller intercepts them (see features/experience/runtime/navigation.ts).
    files: ['components/experience/generated/**/*.tsx'],
    rules: { '@next/next/no-html-link-for-pages': 'off' },
  },
  globalIgnores(['.en-only-backup/**', '.rebrand-backup/**', '.dragon-experiment/**', '.texture-backup/**', '.next/**', 'out/**', 'node_modules/**', 'original-site/**', 'public/**', 'test-results/**', 'playwright-report/**']),
]);
