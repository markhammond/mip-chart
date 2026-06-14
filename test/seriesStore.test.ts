// §4.1 — sorted merge onto the unified X timeline + N5 eviction.
import { describe, expect, it } from 'vitest';
import { SeriesStore, alignStores, lowerBound } from '../src/seriesStore';
import type { SeriesFragment } from '../src/types';

const frag = (xs: number[], values: Array<number | null>): SeriesFragment => ({
  phaseId: 1,
  fragmentCount: 1,
  seriesKey: 's',
  range: { from: xs[0] ?? 0, to: (xs[xs.length - 1] ?? 0) + 1 },
  xs,
  columns: { value: values },
});

describe('SeriesStore', () => {
  it('merges out-of-order fragments into sorted order', () => {
    const s = new SeriesStore(['value']);
    s.merge(frag([30, 40], [3, 4]));
    s.merge(frag([10, 20], [1, 2])); // past data arrives later (bidirectional)
    expect(s.xs).toEqual([10, 20, 30, 40]);
    expect(s.columns['value']).toEqual([1, 2, 3, 4]);
  });

  it('new data wins on timestamp collision (density re-fetch)', () => {
    const s = new SeriesStore(['value']);
    s.merge(frag([10, 20, 30], [1, 2, 3]));
    s.merge(frag([20], [99]));
    expect(s.xs).toEqual([10, 20, 30]);
    expect(s.columns['value']).toEqual([1, 99, 3]);
  });

  it('evicts outside the keep window (N5)', () => {
    const s = new SeriesStore(['value']);
    s.merge(frag([10, 20, 30, 40], [1, 2, 3, 4]));
    s.evictOutside({ from: 15, to: 35 });
    expect(s.xs).toEqual([20, 30]);
    expect(s.columns['value']).toEqual([2, 3]);
  });

  it('visibleIndexRange respects half-open semantics', () => {
    const s = new SeriesStore(['value']);
    s.merge(frag([10, 20, 30, 40], [1, 2, 3, 4]));
    expect(s.visibleIndexRange({ from: 20, to: 40 })).toEqual([1, 3]);
  });
});

describe('alignStores', () => {
  it('aligns differing X grids onto one unified timeline with null gaps', () => {
    const a = new SeriesStore(['value']);
    a.merge(frag([10, 20, 30], [1, 2, 3]));
    const b = new SeriesStore(['value']);
    b.merge(frag([20, 25], [20, 25]));
    const { xs, ys } = alignStores([
      { store: a, column: 'value' },
      { store: b, column: 'value' },
    ]);
    expect(xs).toEqual([10, 20, 25, 30]);
    expect(ys[0]).toEqual([1, 2, null, 3]);
    expect(ys[1]).toEqual([null, 20, 25, null]);
  });
});

describe('lowerBound', () => {
  it('binary search first >= target', () => {
    expect(lowerBound([10, 20, 30], 5)).toBe(0);
    expect(lowerBound([10, 20, 30], 20)).toBe(1);
    expect(lowerBound([10, 20, 30], 21)).toBe(2);
    expect(lowerBound([10, 20, 30], 31)).toBe(3);
    expect(lowerBound([], 0)).toBe(0);
  });
});

describe('nearestNonNull', () => {
  it('exact hit wins; otherwise nearest side, left preferred on ties', async () => {
    const { nearestNonNull } = await import('../src/seriesStore');
    const col = [null, 1, null, null, 4, null];
    expect(nearestNonNull(col, 1)).toBe(1);   // exact
    expect(nearestNonNull(col, 2)).toBe(1);   // left at d=1
    expect(nearestNonNull(col, 3)).toBe(4);   // right at d=1
    expect(nearestNonNull(col, 5)).toBe(4);
    expect(nearestNonNull([null, null], 0)).toBeNull();
    expect(nearestNonNull(col, 5, 0)).toBeNull(); // maxScan respected
  });
});

describe('priorNonNullIdx', () => {
  it('resolves at-or-before only — never looks ahead', async () => {
    const { priorNonNullIdx } = await import('../src/seriesStore');
    const col = [null, 1, null, null, 4, null];
    expect(priorNonNullIdx(col, 1)).toBe(1); // exact hit
    expect(priorNonNullIdx(col, 2)).toBe(1); // carry the last sample forward
    expect(priorNonNullIdx(col, 3)).toBe(1); // still 1 — does NOT jump ahead to 4
    expect(priorNonNullIdx(col, 4)).toBe(4); // exact hit
    expect(priorNonNullIdx(col, 5)).toBe(4); // carry forward, not null after
    expect(priorNonNullIdx(col, 0)).toBe(-1); // nothing at or before
    expect(priorNonNullIdx(col, 3, 1)).toBe(-1); // maxScan caps the back-scan
  });
});
