import { expect, test } from '@playwright/test';
import { domMetrics, howlerSnapshot, loadExperience, startExperience, wheelScroll } from './helpers';

test.describe('experience page', () => {
  test('loads, starts and plays audio after the user gesture', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await loadExperience(page);
    await expect(page.locator('#loading')).toHaveText('100%');
    await startExperience(page);
    await expect(page.locator('#head')).toHaveClass(/active/);
    await page.waitForTimeout(3000);
    const audio = await howlerSnapshot(page);
    expect(audio.ctx).toBe('running');
    expect(audio.total).toBe(26);
    expect(audio.playing.some((s) => s.startsWith('section1@'))).toBe(true);
    expect(errors.filter((e) => !/powerPreference|renderMultiDrawInstances|Vertex attribute/.test(e))).toEqual([]);
  });

  test('mute button persists and restores the master volume', async ({ page }) => {
    await loadExperience(page);
    await startExperience(page);
    await page.locator('.sound-button').click();
    await expect(page.locator('.sound-button')).toHaveClass(/off/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('isMuted'))).toBe('true');
    await expect.poll(async () => (await howlerSnapshot(page)).master, { timeout: 5000 }).toBeLessThan(0.05);
    await page.locator('.sound-button').click();
    await expect(page.locator('.sound-button')).not.toHaveClass(/off/);
    await expect.poll(async () => (await howlerSnapshot(page)).master, { timeout: 5000 }).toBeGreaterThan(0.75);
    await page.reload();
    await loadExperience(page);
    await expect(page.locator('.sound-button')).not.toHaveClass(/off/);
  });

  test('scrolling changes the music track and the pagination', async ({ page }) => {
    await loadExperience(page);
    await startExperience(page);
    await wheelScroll(page, 30, 250);
    await page.waitForTimeout(2000);
    const audio = await howlerSnapshot(page);
    expect(audio.playing.some((s) => /^section[2-5]/.test(s))).toBe(true);
    await expect(page.locator('.section-pag')).toHaveClass(/show/);
    await expect(page.locator('.spgn-link.current')).not.toHaveId('pgn-section1');
  });

  test('menu, about and contact transitions work and do not leak DOM nodes', async ({ page }) => {
    await loadExperience(page);
    await startExperience(page);
    // Baseline after the first round trip: by then the router cache holds the About and
    // Contact trees, so any further growth would be an actual leak (the original grew by
    // ~5 000 nodes and ~30 listeners on every cycle).
    let before = { nodes: 0, listeners: 0, heapMB: 0 };
    for (let i = 0; i < 4; i++) {
      await page.locator('.menu-btn').click();
      await expect(page.locator('nav')).toHaveClass(/show/);
      await page.locator('#nav-about').click();
      await expect(page).toHaveURL(/\/about$/, { timeout: 10_000 });
      await expect(page.locator('section.about')).toBeVisible();
      await expect(page.locator('main')).not.toHaveClass(/menu-open/);
      await page.locator('.logomark-header').click();
      await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
      await expect(page.locator('.top-container')).toBeVisible();
      await page.locator('.menu-btn').click();
      await page.locator('#nav-contact').click();
      await expect(page).toHaveURL(/\/contact$/, { timeout: 10_000 });
      await expect(page.locator('section.contact')).toBeVisible();
      await page.locator('.logomark-header').click();
      await expect(page).toHaveURL(/\/$/, { timeout: 10_000 });
      await page.waitForTimeout(1500);
      if (i === 0) before = await domMetrics(page);
    }
    const after = await domMetrics(page);
    expect(after.nodes).toBeLessThan(before.nodes + 200);
    expect(after.listeners).toBeLessThan(before.listeners + 20);
    expect(await page.evaluate(() => document.getElementsByTagName('*').length)).toBeLessThan(3000);
  });

  test('browser back and forward keep the experience alive', async ({ page }) => {
    await loadExperience(page);
    await startExperience(page);
    await page.locator('.menu-btn').click();
    await page.locator('#nav-about').click();
    await expect(page).toHaveURL(/\/about$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-taxi-view="top"]')).toBeAttached();
    await page.goForward();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator('section.about')).toBeVisible();
    expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBe(1);
  });

  test('direct load of sub routes and language routes', async ({ page }) => {
    for (const path of ['/about', '/contact', '/ja', '/fr/contact']) {
      await loadExperience(page, path);
      await expect(page.locator('#loader')).toHaveClass(/complete/);
      const lang = await page.evaluate(() => document.documentElement.lang);
      expect(lang).toBe(path.startsWith('/ja') ? 'ja' : path.startsWith('/fr') ? 'fr' : 'en');
    }
  });

  test('about tabs animate and contact links are wired', async ({ page }) => {
    await loadExperience(page, '/about');
    await startExperience(page);
    const buttons = page.locator('.tab-nav-item button');
    if ((await buttons.count()) > 1) {
      await buttons.nth(1).click();
      await expect(buttons.nth(1)).toHaveClass(/active/);
      await expect(page.locator('.tabcntitm-2')).toHaveClass(/show/);
    }
    await loadExperience(page, '/contact');
    await startExperience(page);
    await expect(page.locator('#map-link')).toBeAttached();
  });
});
