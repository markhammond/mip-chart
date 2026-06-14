// F1 — loaded-range dedup interval algebra.
import { describe, expect, it } from 'vitest';
import { DisjointIntervalSet } from '../src/intervals';

const r = (from: number, to: number) => ({ from, to });

describe('DisjointIntervalSet', () => {
  it('merges overlapping and adjacent ranges', () => {
    const s = new DisjointIntervalSet();
    s.add(r(0, 10));
    s.add(r(20, 30));
    s.add(r(10, 20)); // bridges
    expect(s.all).toEqual([r(0, 30)]);
  });

  it('covers / missing — basic subtraction', () => {
    const s = new DisjointIntervalSet();
    s.add(r(10, 20));
    s.add(r(30, 40));
    expect(s.covers(r(12, 18))).toBe(true);
    expect(s.covers(r(12, 25))).toBe(false);
    expect(s.missing(r(0, 50))).toEqual([r(0, 10), r(20, 30), r(40, 50)]);
    expect(s.missing(r(15, 35))).toEqual([r(20, 30)]);
    expect(s.missing(r(12, 18))).toEqual([]);
  });

  it('re-requesting a covered range yields no fetch plan (F1 short-circuit)', () => {
    const s = new DisjointIntervalSet();
    s.add(r(0, 100));
    expect(s.missing(r(10, 90))).toEqual([]);
    expect(s.missing(r(0, 100))).toEqual([]);
  });

  it('bidirectional growth into the past', () => {
    const s = new DisjointIntervalSet();
    s.add(r(100, 200));
    expect(s.missing(r(50, 150))).toEqual([r(50, 100)]);
    s.add(r(50, 100));
    expect(s.missing(r(0, 150))).toEqual([r(0, 50)]);
  });

  it('retainWithin trims to the eviction window (N5)', () => {
    const s = new DisjointIntervalSet();
    s.add(r(0, 100));
    s.add(r(200, 300));
    s.retainWithin(r(50, 250));
    expect(s.all).toEqual([r(50, 100), r(200, 250)]);
  });

  it('ignores empty ranges', () => {
    const s = new DisjointIntervalSet();
    s.add(r(5, 5));
    expect(s.all).toEqual([]);
    expect(s.covers(r(7, 7))).toBe(true);
  });
});
