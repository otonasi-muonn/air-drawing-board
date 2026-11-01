import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from './oneEuroFilter';

describe('OneEuroFilter', () => {
  it('returns the first sample and smooths subsequent samples', () => {
    const filter = new OneEuroFilter();
    expect(filter.filter(0, 0)).toBe(0);
    const smoothed = filter.filter(1, 1);
    expect(smoothed).toBeCloseTo(0.884375, 4);
    expect(filter.filter(1, 2)).toBeGreaterThan(smoothed);
  });
  it('increases responsiveness with beta and resets position and velocity', () => {
    const fixed = new OneEuroFilter(1.2, 0), adaptive = new OneEuroFilter(1.2, 0.02);
    fixed.filter(0, 1); adaptive.filter(0, 1);
    expect(adaptive.filter(20, 1.01)).toBeGreaterThan(fixed.filter(20, 1.01));
    adaptive.reset();
    expect(adaptive.filter(100, 10)).toBe(100);
    const fresh = new OneEuroFilter();
    fresh.filter(100, 10);
    expect(adaptive.filter(200, 10.01)).toBe(fresh.filter(200, 10.01));
  });
  it('keeps duplicate timestamps finite with a minimum time step', () => {
    const filter = new OneEuroFilter();
    filter.filter(0, 1);
    expect(Number.isFinite(filter.filter(1, 1))).toBe(true);
  });
});
