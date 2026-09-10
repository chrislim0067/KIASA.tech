/**
 * Smooth scrolling (port of `Jn`). Lenis 1.1.18 is pinned so the scroll feel is identical.
 * GSAP's ticker is driven from the shared rAF loop, exactly like the original.
 */
import Lenis from 'lenis';
import { gsap } from 'gsap';
import type { EngineApi } from '../engine-api';
import { events } from '../events';
import { damp } from '../math';
import { store } from '../store';
import { ticker } from '../ticker';

export function setupLenis(api: EngineApi): () => void {
  const lenis = new Lenis({
    syncTouch: true,
    smoothWheel: true,
    wheelMultiplier: 0.5,
    touchMultiplier: 0.8,
    syncTouchLerp: 0.02,
    lerp: 0.1,
    wrapper: document.body,
    virtualScroll: (data: { deltaY: number }) => {
      store.state.virtualScroll = data.deltaY;
      return true;
    },
  });
  store.state.lenis = lenis;

  lenis.on('scroll', (instance: Lenis) => {
    const progress = instance.progress;
    store.state.scroll = progress;
    api.trigger({ name: 'scroll' }, { progress, direction: instance.direction, scroll: instance.targetScroll });
  });
  const offScrollTo = events.on<{ target: number | string | HTMLElement; options?: Record<string, unknown> }>('lenis:scrollTo', ({ target, options }) => {
    lenis.scrollTo(target, options);
  });
  const offStop = events.on('lenis:stop', () => {
    lenis.stop();
    lenis.start();
  });

  gsap.ticker.lagSmoothing(0);
  gsap.ticker.remove(gsap.updateRoot);
  lenis.scrollTo(0, { immediate: true });

  let lastTime = 0;
  let smoothed = 0;
  const removeTick = ticker.add((time) => {
    const delta = (time - lastTime) / 1000;
    lastTime = time;
    gsap.updateRoot(time / 1000);
    lenis.raf(time);
    const autoscroll = store.state.autoscroll;
    if (autoscroll?.started) autoscroll.onRaf({ delta });
    if (smoothed === store.state.scroll) return;
    smoothed = damp(smoothed, store.state.scroll, 12, delta);
    document.dispatchEvent(new CustomEvent('lenis:scroll', { detail: smoothed }));
    if (Math.abs(smoothed - store.state.scroll) < 1e-4) smoothed = store.state.scroll;
  });

  return () => {
    removeTick();
    offScrollTo();
    offStop();
    lenis.destroy();
    gsap.ticker.add(gsap.updateRoot);
    if (store.state.lenis === lenis) store.state.lenis = null;
  };
}
