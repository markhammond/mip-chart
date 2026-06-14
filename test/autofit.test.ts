// F3 — visible-window Y-autofit, linear + log, with lightweight-charts
// scaleMargins (top 0.2 / bottom 0.1 of pane height, user-adopted).
import { describe, expect, it } from 'vitest';
import { ExtentAccumulator, fitY } from '../src/autofit';

const acc = (...vals: Array<number | null>) => {
  const a = new ExtentAccumulator();
  for (const v of vals) a.add(v);
  return a;
};

describe('fitY', () => {
  it('linear: asymmetric TV margins — data occupies the middle 70%', () => {
    const fit = fitY(acc(100, 200), { log: false })!;
    // span 100, usable 0.7 → below = 100·0.1/0.7, above = 100·0.2/0.7
    expect(fit[0]).toBeCloseTo(100 - 100 * (0.1 / 0.7), 6);
    expect(fit[1]).toBeCloseTo(200 + 100 * (0.2 / 0.7), 6);
    // headroom above is 2× the room below (TV's signature look)
    expect(fit[1] - 200).toBeCloseTo((100 - fit[0]) * 2, 6);
  });

  it('ignores nulls and non-finite values', () => {
    const fit = fitY(acc(null, NaN, Infinity, 50, 60), { log: false, topFrac: 0, bottomFrac: 0 })!;
    expect(fit).toEqual([50, 60]);
  });

  it('log: margins applied in log10 space (F3)', () => {
    const fit = fitY(acc(10, 1000), { log: true })!;
    // span = 2 decades, usable 0.7
    expect(Math.log10(fit[0])).toBeCloseTo(1 - 2 * (0.1 / 0.7), 6);
    expect(Math.log10(fit[1])).toBeCloseTo(3 + 2 * (0.2 / 0.7), 6);
  });

  it('log: clamps non-positive minima to the floor', () => {
    const fit = fitY(acc(-5, 100), { log: true, topFrac: 0, bottomFrac: 0, floor: 1e-9 })!;
    expect(fit[0]).toBeGreaterThan(0);
  });

  it('custom margins override the TV defaults', () => {
    const fit = fitY(acc(0, 100), { log: false, topFrac: 0.05, bottomFrac: 0.05 })!;
    expect(fit[0]).toBeCloseTo(-100 * (0.05 / 0.9), 6);
    expect(fit[1]).toBeCloseTo(100 + 100 * (0.05 / 0.9), 6);
  });

  it('degenerate single-value window still yields a non-empty range', () => {
    const lin = fitY(acc(42), { log: false })!;
    expect(lin[0]).toBeLessThan(42);
    expect(lin[1]).toBeGreaterThan(42);
    const log = fitY(acc(42), { log: true })!;
    expect(log[0]).toBeLessThan(42);
    expect(log[1]).toBeGreaterThan(42);
  });

  it('returns null when no data in view', () => {
    expect(fitY(acc(), { log: false })).toBeNull();
  });

  it('addRange scans only the index window (N2)', () => {
    const a = new ExtentAccumulator();
    a.addRange([1, 2, 1000, 3, 4], 3, 5); // only indices 3..4
    expect(a.min).toBe(3);
    expect(a.max).toBe(4);
  });
});
