import { Easing, interpolate, spring } from 'remotion';

import { EASE } from '../tokens';

/** The stylesheet's curve, as a Remotion easing. */
export const brandEase = Easing.bezier(...EASE);

/** 0→1 over `dur` frames starting at `start`, on the brand curve. Clamped. */
export function ramp(frame: number, start: number, dur: number, easing = brandEase): number {
  return interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });
}

/** 1→0 over `dur` frames starting at `start`. Clamped. */
export function fadeOut(frame: number, start: number, dur: number): number {
  return 1 - ramp(frame, start, dur, Easing.inOut(Easing.quad));
}

/**
 * A critically-damped spring: arrives without overshoot. For things that
 * should feel placed rather than thrown — panels, captions, the wordmark.
 */
export function settle(frame: number, fps: number, start: number, dur = 42): number {
  return spring({ frame: frame - start, fps, durationInFrames: dur, config: { damping: 200 } });
}

/**
 * A spring with a little overshoot. For things arriving from somewhere — job
 * cards landing in a list, a card moving between pipeline columns.
 */
export function arrive(frame: number, fps: number, start: number): number {
  return spring({
    frame: frame - start,
    fps,
    config: { damping: 15, stiffness: 120, mass: 0.9 },
  });
}

/** A slow sine pulse in [lo, hi], for processing indicators. */
export function pulse(frame: number, fps: number, hz = 1.1, lo = 0.35, hi = 1): number {
  const t = (Math.sin((frame / fps) * 2 * Math.PI * hz) + 1) / 2;
  return lo + (hi - lo) * t;
}

/** Integer count-up, for stat tiles and the match score. */
export function count(frame: number, start: number, dur: number, to: number): number {
  return Math.round(to * ramp(frame, start, dur, Easing.out(Easing.cubic)));
}

/** Opacity + rise, the film's default entrance for a block of text. */
export function fadeUp(
  frame: number,
  start: number,
  dur = 30,
  rise = 22
): { opacity: number; transform: string } {
  const p = ramp(frame, start, dur);
  return { opacity: p, transform: `translateY(${(1 - p) * rise}px)` };
}
