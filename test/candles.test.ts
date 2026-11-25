// Draw-time candle grid: member step inference and slot centring.
import { describe, expect, it } from 'vitest';
import { candleGroupMs, candleSlotCentreMs, memberStepMs } from '../src/candles';

const M = 60_000;
const BAR = 5 * M;

describe('memberStepMs', () => {
  it('reports the native bar for native rows, despite gaps', () => {
    const xs = [0, BAR, 2 * BAR, 6 * BAR, 7 * BAR];
    const v = xs.map(() => 1);
    expect(memberStepMs(xs, v, v, BAR)).toBe(BAR);
  });

  it('reports the source bucket for pre-aggregated rows', () => {
    const G = 72 * BAR;
    const xs = [0, G, 2 * G, 5 * G];
    const v = xs.map(() => 1);
    expect(memberStepMs(xs, v, v, BAR)).toBe(G);
  });

  it('skips rows without an open or close', () => {
    const xs = [0, BAR, 4 * BAR, 8 * BAR];
    const opens = [1, null, 1, 1];
    expect(memberStepMs(xs, opens, opens, BAR)).toBe(4 * BAR);
  });

  it('falls back to the bar for a single row', () => {
    expect(memberStepMs([0], [1], [1], BAR)).toBe(BAR);
  });
});

describe('candleGroupMs', () => {
  it('nests on the member step', () => {
    const G = 72 * BAR;
    expect(candleGroupMs(70 * BAR, G)).toBe(G);
    expect(candleGroupMs(100 * BAR, G)).toBe(2 * G);
    expect(candleGroupMs(3 * M, BAR)).toBe(BAR);
  });
});

describe('candleSlotCentreMs', () => {
  it('keeps a single native bar on its open', () => {
    expect(candleSlotCentreMs(7, BAR, BAR)).toBe(7 * BAR);
  });

  it('centres an aggregate on the mean open of its bars', () => {
    const G = 12 * BAR; // bars at 0..11 → mean open 5.5 bars
    expect(candleSlotCentreMs(3, G, BAR)).toBe(3 * G + 5.5 * BAR);
  });
});
