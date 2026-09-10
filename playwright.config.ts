import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end and visual regression tests.
 *
 *   npm run test:e2e                      # against the production build (next start)
 *   ORIGINAL_URL=http://localhost:8765 …  # also captures the original site for comparison
 *
 * The WebGL/WebGPU experience needs a real GPU: the suite runs headed Chromium locally.
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    channel: 'chrome',
    headless: false,
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } } }],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: 'npm run start',
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
