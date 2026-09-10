/** Browser / device detection helpers (ports of `Kn`, `hn`, `un`, `dt`, `ft`, `di`). */

export const isSafari = (): boolean => {
  const ua = navigator.userAgent;
  return (
    ua.indexOf('Safari') !== -1 &&
    ua.indexOf('Chrome') === -1 &&
    ua.indexOf('Chromium') === -1 &&
    ua.indexOf('Android') === -1 &&
    ua.indexOf('CriOS') === -1 &&
    ua.indexOf('FxiOS') === -1
  );
};

export const isFirefox = (): boolean => /Firefox/i.test(navigator.userAgent);

export const isIOS = (): boolean => {
  const iphone = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const ipadOS = /Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 0 && 'ontouchend' in document;
  return iphone || ipadOS;
};

export const hasTouch = (): boolean =>
  'ontouchstart' in window ||
  navigator.maxTouchPoints > 0 ||
  (navigator as Navigator & { msMaxTouchPoints?: number }).msMaxTouchPoints! > 0;

export const isMobileOrTablet = (): boolean => {
  const ios = isIOS();
  const android = /android/i.test(navigator.userAgent);
  const mobileUa = /Mobi|Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const touch = hasTouch();
  const safariTouch = /Safari/i.test(navigator.userAgent) && !/Chrome/i.test(navigator.userAgent) && touch;
  return ios || android || mobileUa || (safariTouch && touch);
};

/** Detects whether the browser supports fractional scroll positions. */
export const supportsFractionalScroll = (): boolean => {
  const outer = document.createElement('div');
  outer.style.visibility = 'hidden';
  outer.style.width = '100px';
  outer.style.height = '100px';
  outer.style.overflow = 'scroll';
  outer.style.position = 'absolute';
  const inner = document.createElement('div');
  inner.style.width = '100%';
  inner.style.height = '200px';
  outer.appendChild(inner);
  document.body.appendChild(outer);
  outer.scrollTop = 0;
  outer.scrollTop = 0.5;
  const supported = outer.scrollTop === 0.5;
  document.body.removeChild(outer);
  return supported;
};

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
