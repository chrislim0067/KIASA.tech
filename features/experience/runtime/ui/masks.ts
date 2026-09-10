/** Masked text reveal animations used by the menu, nav links and tabs (ports of `_t` and `nt`). */
import { gsap } from 'gsap';

export const resetMask = (element: Element): void => {
  element.classList.remove('show');
  element.querySelectorAll<HTMLElement>('.mask-appear').forEach((el) => {
    el.style.setProperty('--apg-1', '0');
    el.style.setProperty('--apg-2', '0');
  });
};

const timelines = new WeakMap<Element, gsap.core.Timeline>();

export const animateMask = (element: Element, baseDelay = 0.6): void => {
  timelines.get(element)?.kill();
  const timeline = gsap.timeline();
  timelines.set(element, timeline);
  const lines1 = element.querySelectorAll<HTMLElement>('.mask-l1');
  const lines2 = element.querySelectorAll<HTMLElement>('.mask-l2');
  const all = [...lines1, ...lines2];
  setTimeout(() => element.classList.add('show'), 1);
  const duration = 0.3;
  let delay = baseDelay;
  let index = 0;
  const half = all.length / 2;
  all.forEach((el, i) => {
    if (i === half) {
      index = 0;
      delay += 0.2;
    }
    timeline.to(el, { duration, '--apg-1': 1, ease: 'power2.out', delay }, 0.1 + 0.15 * index);
    timeline.to(el, { duration, '--apg-2': 1, ease: 'power2.out', delay: delay + 0.1 }, 0.1 + 0.15 * index);
    index += 1;
  });
  timeline.play();
};

export const killMaskAnimations = (element: Element): void => {
  timelines.get(element)?.kill();
  timelines.delete(element);
};
