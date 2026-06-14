// Axis splits — nice ticks in the active label space (S1, spike finding).
import { describe, expect, it } from 'vitest';
import {
  niceStep,
  niceLinearSplits,
  niceLogSplits,
  nicePercentSplits,
  tvLadderCeil,
  tvLinearTicks,
  tvLogTicks,
  tvPercentTicks,
} from '../src/splits';

describe('niceStep', () => {
  it('rounds on the Heckbert 1-2-5-10 ladder', () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.3)).toBe(1);
    expect(niceStep(1.8)).toBe(2);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(23)).toBe(20);
    expect(niceStep(450)).toBe(500);
  });
});

describe('niceLinearSplits', () => {
  it('covers the range with nice values', () => {
    expect(niceLinearSplits(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceLinearSplits(13, 87, 5)).toEqual([20, 40, 60, 80]);
  });

  it('kills float drift in labels', () => {
    for (const v of niceLinearSplits(0, 0.9, 4)) {
      expect(String(v).length).toBeLessThan(6);
    }
  });
});

describe('niceLogSplits', () => {
  it('sub-decade ranges fall back to linear', () => {
    expect(niceLogSplits(100, 300, 4)).toEqual([100, 150, 200, 250, 300]);
  });

  it('multi-decade ranges use 1-2-5 per decade', () => {
    expect(niceLogSplits(10, 10_000, 6)).toEqual([
      10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000,
    ]);
  });

  it('many-decade ranges step whole decades', () => {
    const s = niceLogSplits(1, 1e12, 6);
    expect(s.every((v) => Math.log10(v) % 1 === 0)).toBe(true);
    expect(s.length).toBeLessThanOrEqual(13);
  });
});

describe('nicePercentSplits', () => {
  it('positions are nice in percent space, returned in native units', () => {
    // origin 200, range [180, 230] → [-10%, +15%] → ticks every 5%
    const native = nicePercentSplits(200, 180, 230, 5);
    const pcts = native.map((v) => (v / 200 - 1) * 100);
    expect(pcts.map((p) => Math.round(p * 1e6) / 1e6)).toEqual([-10, -5, 0, 5, 10, 15]);
  });

  it('degenerate origin yields the range floor', () => {
    expect(nicePercentSplits(0, 1, 2)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// TradingView lightweight-charts heuristic (user-adopted)

describe('tvLadderCeil', () => {
  it('rounds up on the {1,2,2.5,4,5}x10^k ladder', () => {
    expect(tvLadderCeil(0.7)).toBe(1);
    expect(tvLadderCeil(1.5)).toBe(2);
    expect(tvLadderCeil(2.2)).toBe(2.5);
    expect(tvLadderCeil(3)).toBe(4);
    expect(tvLadderCeil(4.5)).toBe(5);
    expect(tvLadderCeil(26)).toBe(40);
    expect(tvLadderCeil(2.5)).toBe(2.5); // exact ladder values pass through
  });
});

describe('tvLinearTicks', () => {
  const o = { heightPx: 300, fontPx: 12 }; // markHeight = 30 → ≤10 marks

  it('step from ladder at ~2.5 font-heights density', () => {
    // span 100 × 30/300 = 10 → step 10
    expect(tvLinearTicks(0, 100, o)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it('shorter panes get coarser steps', () => {
    // span 100 × 30/100 = 30 → ladder → 40
    expect(tvLinearTicks(0, 100, { heightPx: 100, fontPx: 12 })).toEqual([0, 40, 80]);
  });

  it('marks anchored at high − (high mod span)', () => {
    const ticks = tvLinearTicks(13, 87, o); // step: 74·0.1 = 7.4 → 10
    expect(ticks).toEqual([20, 30, 40, 50, 60, 70, 80]);
  });
});

describe('tvLogTicks', () => {
  it('labels are nice ladder values with ≥ markHeight pixel spacing', () => {
    const heightPx = 400;
    const fontPx = 12;
    const markHeight = Math.ceil(fontPx * 2.5);
    const lo = 50, hi = 5000; // 2 decades
    const ticks = tvLogTicks(lo, hi, { heightPx, fontPx });
    expect(ticks.length).toBeGreaterThan(2);
    const pxPerLog = heightPx / (Math.log10(hi) - Math.log10(lo));
    for (let i = 0; i < ticks.length; i++) {
      const t = ticks[i]!;
      expect(t).toBeGreaterThanOrEqual(lo);
      expect(t).toBeLessThanOrEqual(hi);
      // marks are MULTIPLES of a ladder step (TVLC semantics) — i.e. round
      // numbers: divisible by a power of ten one order below themselves
      const mag = Math.pow(10, Math.floor(Math.log10(t) + 1e-12) - 1);
      expect(Math.abs(t / mag - Math.round(t / mag)), `roundness of ${t}`).toBeLessThan(1e-9);
      if (i > 0) {
        const gapPx = (Math.log10(t) - Math.log10(ticks[i - 1]!)) * pxPerLog;
        expect(gapPx).toBeGreaterThanOrEqual(markHeight * 0.5); // local-density guard
      }
      if (i > 0) expect(t).toBeGreaterThan(ticks[i - 1]!);
    }
  });
});

describe('tvPercentTicks', () => {
  it('ladder positions in percent space, native units out', () => {
    // origin 200, [180, 230] → [-10%, +15%], height 250/font 12 → step 4(%)
    const native = tvPercentTicks(200, 180, 230, { heightPx: 250, fontPx: 12 });
    const pcts = native.map((v) => Math.round(((v / 200 - 1) * 100) * 1e6) / 1e6);
    expect(pcts).toEqual([-8, -4, 0, 4, 8, 12]);
  });
});
