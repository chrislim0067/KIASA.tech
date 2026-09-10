/** Easing and interpolation helpers used by the scroll controllers (ports of `Ui`, `gn`, `Mi`, …). */

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export const lerp = (a: number, b: number, t: number): number => (1 - t) * a + t * b;

/** Frame-rate independent damping (Three.js `MathUtils.damp`). */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;

/** Normalised progress of `value` inside `[from, to]`, clamped to 0..1 (port of `gn`). */
export const rangeProgress = (from: number, to: number, value: number): number =>
  to - from === 0 ? 1 : clamp((value - from) / (to - from), 0, 1);

/** Inverse ramp: 1 before `start`, decreasing to 0 at `end` (port of `Ui`). */
export const inverseRamp = (start: number, end: number, value: number): number => {
  if (start >= end) throw new Error('Start must be less than end');
  const v = clamp(value, 0, 1);
  return v < start ? 1 : Math.max(0, 1 - (v - start) / (end - start));
};

export const easeInCubic = (t: number): number => t * t * t;
export const easeInQuint = (t: number): number => t * t * t * t * t;
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeInSine = (t: number): number => 1 + Math.sin((Math.PI / 2) * t - Math.PI / 2);
export const easeOutSine = (t: number): number => Math.sin((Math.PI / 2) * t);
export const easeOutCirc = (t: number): number => Math.sqrt(1 - Math.pow(t - 1, 2));
export const easeInOutCirc = (t: number): number =>
  t < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * t, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * t + 2, 2)) + 1) / 2;
