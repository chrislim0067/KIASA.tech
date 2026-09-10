import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { VIEWPORTS, loadExperience, startExperience, wheelScroll } from './helpers';

/**
 * Captures reference screenshots of the rebuild (and of the original when ORIGINAL_URL is set)
 * at every required viewport: loader, after start, scrolled, menu, about, contact. The 3D
 * scene is animated, so the images are compared by eye / with an image diff tool rather than
 * asserted pixel-perfect.
 */
const OUT = path.resolve('tests/e2e/__screenshots__');
const targets = [{ label: 'rebuild', url: process.env.BASE_URL ?? 'http://localhost:3000' }];
if (process.env.ORIGINAL_URL) targets.push({ label: 'original', url: process.env.ORIGINAL_URL });

for (const target of targets) {
  for (const vp of VIEWPORTS) {
    test(`${target.label} @ ${vp.name}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.width < 800, isMobile: vp.width < 800, baseURL: target.url });
      const page = await context.newPage();
      const dir = path.join(OUT, target.label, vp.name);
      fs.mkdirSync(dir, { recursive: true });
      const shot = (name: string) => page.screenshot({ path: path.join(dir, `${name}.png`) });
      await loadExperience(page, '/');
      await shot('1-loader');
      await startExperience(page);
      await page.waitForTimeout(3500);
      await shot('2-start');
      if (vp.width < 800) {
        for (let i = 0; i < 12; i++) {
          await page.touchscreen.tap(vp.width / 2, vp.height * 0.8);
          await page.mouse.wheel(0, 300);
          await page.waitForTimeout(150);
        }
      } else {
        await wheelScroll(page, 25, 250, 120);
      }
      await page.waitForTimeout(2500);
      await shot('3-scrolled');
      await page.locator('.menu-btn').click();
      await page.waitForTimeout(1500);
      await shot('4-menu');
      await page.locator('#nav-about').click();
      await page.waitForTimeout(3000);
      await shot('5-about');
      await page.locator('.logomark-header').click();
      await page.waitForTimeout(2500);
      await page.locator('.menu-btn').click();
      await page.waitForTimeout(1200);
      await page.locator('#nav-contact').click();
      await page.waitForTimeout(3000);
      await shot('6-contact');
      await context.close();
    });
  }
}
