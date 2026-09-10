import { devices, expect, test } from '@playwright/test';
import { howlerSnapshot, loadExperience, startExperience } from './helpers';

test.describe('robustness', () => {
  test('mobile viewport starts automatically and unlocks audio on the first tap', async ({ browser }) => {
    // A real mobile user agent is required: the runtime picks the touch sound set from the
    // user agent exactly like the original site.
    const context = await browser.newContext({ ...devices['iPhone 14 Pro'], isMobile: false, viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await context.newPage();
    await loadExperience(page, '/');
    await expect(page.locator('#loader')).toHaveClass(/hide/, { timeout: 15_000 });
    await expect(page.locator('#head')).toHaveClass(/active/);
    await page.touchscreen.tap(195, 500);
    await page.waitForTimeout(2500);
    const audio = await howlerSnapshot(page);
    expect(audio.ctx).toBe('running');
    // Desktop-only sounds are skipped on touch devices: 16 instead of 26.
    expect(audio.total).toBe(16);
    expect(await page.evaluate(() => document.querySelector('.htibtn')?.classList.contains('mobile'))).toBe(true);
    await context.close();
  });

  test('window resize keeps the page consistent', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await loadExperience(page);
    await startExperience(page);
    const heightBefore = await page.evaluate(() => document.getElementById('app')?.style.height);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(1500);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.getElementById('app')?.style.height)).toBe(heightBefore);
    expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBe(1);
    expect(errors).toEqual([]);
  });

  test('loads on a slow connection', async ({ page }) => {
    const client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
    // ~8 Mbit/s with 100 ms latency: the 50 MB of scene assets take about a minute.
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 1_000_000, uploadThroughput: 500_000 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.loading-cnt')).toHaveClass(/show/, { timeout: 60_000 });
    await expect(page.locator('#loader')).toHaveClass(/complete/, { timeout: 230_000 });
    await expect(page.locator('#loading')).toHaveText('100%');
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  });

  test('repeated navigation between pages stays responsive', async ({ page }) => {
    await loadExperience(page);
    await startExperience(page);
    for (let i = 0; i < 5; i++) {
      await page.locator('.menu-btn').click();
      await page.locator('#nav-contact').click();
      await expect(page).toHaveURL(/\/contact$/);
      await page.locator('.menu-btn').click();
      await page.locator('#nav-about').click();
      await expect(page).toHaveURL(/\/about$/);
      await page.locator('.logomark-header').click();
      await expect(page).toHaveURL(/\/$/);
    }
    const frames = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let n = 0;
          const start = performance.now();
          const tick = (): void => {
            n++;
            if (performance.now() - start < 1000) requestAnimationFrame(tick);
            else resolve(n);
          };
          requestAnimationFrame(tick);
        }),
    );
    expect(frames).toBeGreaterThan(30);
    expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBe(1);
  });
});
