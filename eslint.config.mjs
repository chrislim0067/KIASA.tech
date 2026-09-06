import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

const config = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      // Verbatim copies of the original site. Linting them would report the
      // original author's style, and "fixing" anything would break the
      // byte-fidelity the rebuild depends on.
      'legacy/**',
      'public/generated/**',
      'public/Assets/**',
      'content/**',
      'lib/generated/**',
      'verify-shots/**',
    ],
  },
];

export default config;
