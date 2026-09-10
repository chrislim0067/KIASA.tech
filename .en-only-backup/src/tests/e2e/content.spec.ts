import { expect, test } from '@playwright/test';

test.describe('content pages', () => {
  test('blog index renders the original markup and stylesheet', async ({ page }) => {
    await page.goto('/blog');
    await expect(page).toHaveTitle(/Blog/);
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('footer')).toBeVisible();
    const sheets = await page.evaluate(() => Array.from(document.styleSheets).map((s) => s.href ?? 'inline'));
    expect(sheets.some((s) => s.includes('3d-elearning-game-development-guide'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  });

  test('a blog article has a working contact form and copy blocks', async ({ page }) => {
    await page.goto('/blog/threejs-best-practices-100-tips');
    await expect(page.locator('html')).toHaveAttribute('data-content-ready', '');
    await expect(page.locator('#contact-form')).toBeAttached();
    await page.locator('#contact-form [type="submit"]').first().click();
    await expect(page.locator('#contact-form .has-error').first()).toBeAttached();
    const promptBlocks = page.locator('.prompt-block');
    if ((await promptBlocks.count()) > 0) await expect(promptBlocks.first().locator('.copy-button')).toBeAttached();
  });

  test('landing page FAQ toggles', async ({ page }) => {
    await page.goto('/experience-economy-interactive-installations');
    await expect(page.locator('html')).toHaveAttribute('data-content-ready', '');
    // The original markup ships the first answer open; the second one starts closed.
    const item = page.locator('[data-faq-item]').nth(1);
    await expect(item).not.toHaveClass(/open/);
    await item.click();
    await expect(item).toHaveClass(/open/);
    await expect(item.locator('[data-faq-toggle]')).toHaveAttribute('aria-expanded', 'true');
    await item.click();
    await expect(item).not.toHaveClass(/open/);
    await expect(item.locator('[data-faq-toggle]')).toHaveAttribute('aria-expanded', 'false');
  });

  test('japanese and french pages set the document language', async ({ page }) => {
    await page.goto('/ja/company');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ja');
    await page.goto('/fr/privacy');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr');
  });

  test('unknown routes return the 404 page', async ({ page }) => {
    const response = await page.goto('/this-page-does-not-exist');
    expect(response?.status()).toBe(404);
  });
});
