import { describe, expect, it } from 'vitest';
import { clamp, damp, easeInOutCirc, easeInOutQuad, inverseRamp, lerp, rangeProgress } from '@/features/experience/runtime/math';

describe('math helpers', () => {
  it('rangeProgress clamps to 0..1 and handles empty ranges', () => {
    expect(rangeProgress(0, 1, 0.25)).toBe(0.25);
    expect(rangeProgress(0.2, 0.4, 0.1)).toBe(0);
    expect(rangeProgress(0.2, 0.4, 0.5)).toBe(1);
    expect(rangeProgress(0.3, 0.3, 0)).toBe(1);
  });

  it('inverseRamp matches the original semantics', () => {
    expect(inverseRamp(0.2, 0.4, 0.1)).toBe(1);
    expect(inverseRamp(0.2, 0.4, 0.3)).toBeCloseTo(0.5);
    expect(inverseRamp(0.2, 0.4, 0.9)).toBe(0);
    expect(() => inverseRamp(0.5, 0.4, 0)).toThrow();
  });

  it('easings hit their end points', () => {
    for (const fn of [easeInOutQuad, easeInOutCirc]) {
      expect(fn(0)).toBeCloseTo(0);
      expect(fn(1)).toBeCloseTo(1);
      expect(fn(0.5)).toBeCloseTo(0.5);
    }
  });

  it('lerp/clamp/damp', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(damp(0, 1, 12, 1)).toBeGreaterThan(0.99);
  });
});
