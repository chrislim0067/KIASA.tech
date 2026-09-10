import { expect, type Page } from '@playwright/test';

export const VIEWPORTS = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '430x932', width: 430, height: 932 },
  { name: '390x844', width: 390, height: 844 },
] as const;

/** Loads an experience page and waits for the worker to report the first rendered frame. */
export async function loadExperience(page: Page, path = '/'): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#loader')).toHaveClass(/complete/, { timeout: 180_000 });
}

/** Clicks "Begin experience" (desktop) or waits for the automatic start (mobile). */
export async function startExperience(page: Page): Promise<void> {
  const width = page.viewportSize()?.width ?? 1440;
  if (width >= 767) await page.locator('#start').click();
  await expect(page.locator('#loader')).toHaveClass(/hide/, { timeout: 15_000 });
}

export interface HowlerSnapshot {
  ctx: string;
  master: number;
  loaded: number;
  total: number;
  playing: string[];
}

export function howlerSnapshot(page: Page): Promise<HowlerSnapshot> {
  return page.evaluate(() => {
    const w = window as unknown as { Howler?: { ctx: AudioContext; volume(): number; _howls: Array<{ _state: string; playing(): boolean; _src: string | string[]; volume(): number }> } };
    const h = w.Howler;
    if (!h) return { ctx: 'none', master: 0, loaded: 0, total: 0, playing: [] };
    return {
      ctx: h.ctx?.state ?? 'none',
      master: h.volume(),
      loaded: h._howls.filter((x) => x._state === 'loaded').length,
      total: h._howls.length,
      playing: h._howls.filter((x) => x.playing()).map((x) => String(x._src).split('/').pop()!.replace(/\.(opus|mp3|webm)$/, '') + '@' + x.volume().toFixed(2)),
    };
  });
}

export async function wheelScroll(page: Page, steps: number, delta: number, pause = 100): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(pause);
  }
}

export interface DomMetrics {
  nodes: number;
  listeners: number;
  heapMB: number;
}

export async function domMetrics(page: Page): Promise<DomMetrics> {
  const client = await page.context().newCDPSession(page);
  // Detached nodes are only released by a full GC; force one so the numbers are comparable.
  await client.send('HeapProfiler.collectGarbage').catch(() => {});
  await page.waitForTimeout(500);
  await client.send('Performance.enable');
  const { metrics } = await client.send('Performance.getMetrics');
  const get = (name: string): number => metrics.find((m) => m.name === name)?.value ?? 0;
  await client.detach();
  return { nodes: get('Nodes'), listeners: get('JSEventListeners'), heapMB: Math.round(get('JSHeapUsedSize') / 1048576) };
}
