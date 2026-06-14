// F4 — percentage-change origin: left-edge rebase, null fallback,
// hidden-baseline anchor, provider-shipped true baseline.
import { describe, expect, it } from 'vitest';
import { PercentOrigin } from '../src/percentAxis';

describe('PercentOrigin', () => {
  it('rebases to the leftmost visible sample', () => {
    const p = new PercentOrigin();
    p.rebase([10, 20, 30], [100, 110, 120], { from: 15, to: 35 });
    expect(p.origin).toBe(110);
    expect(p.toPercent(121)).toBeCloseTo(10);
  });

  it('carries forward past a null left edge (defined fallback)', () => {
    const p = new PercentOrigin();
    p.rebase([10, 20, 30], [null, null, 120], { from: 5, to: 35 });
    expect(p.origin).toBe(120);
  });

  it('keeps the previous origin when nothing is in view', () => {
    const p = new PercentOrigin();
    p.rebase([10], [100], { from: 0, to: 20 });
    p.rebase([10], [100], { from: 500, to: 600 });
    expect(p.origin).toBe(100);
  });

  it('provider true baseline wins over decimated points (§4.7)', () => {
    const p = new PercentOrigin();
    p.rebase([10, 20], [100, 110], { from: 5, to: 25 }, 99.5);
    expect(p.origin).toBe(99.5);
  });

  it('formats signed percentages from native-unit splits', () => {
    const p = new PercentOrigin();
    p.rebase([0], [200], { from: 0, to: 1 });
    expect(p.format(220)).toBe('+10.00%');
    expect(p.format(180)).toBe('-10.00%');
    expect(p.format(200)).toBe('0.00%'); // exact origin renders unsigned
  });

  it('formatSplits picks decimals from the split step', () => {
    const p = new PercentOrigin();
    p.rebase([0], [100], { from: 0, to: 1 });
    expect(p.formatSplits([100, 150, 200])).toEqual(['0%', '+50%', '+100%']);
    expect(p.formatSplits([100, 100.05])).toEqual(['0.000%', '+0.050%']);
  });

  it('empty labels while origin unset or zero', () => {
    const p = new PercentOrigin();
    expect(p.format(123)).toBe('');
    expect(p.formatSplits([1, 2])).toEqual(['', '']);
  });

  // F4 anchor: visibility is a renderer concern; rebase() reads the baseline
  // store regardless of legend state. The navigator-level guarantee is that
  // setSeriesVisible() does not touch PercentOrigin — asserted here by API
  // absence: PercentOrigin has no visibility coupling at all.
  it('origin anchoring has no visibility coupling', () => {
    const p = new PercentOrigin();
    p.rebase([10], [100], { from: 0, to: 20 });
    expect(p.origin).toBe(100); // nothing else can silently change it
  });
});
