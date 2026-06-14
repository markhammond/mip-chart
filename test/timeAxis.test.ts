// The shared time axis — the loose-coupling spine (axis-linked components).
import { describe, expect, it } from 'vitest';
import { TimeAxis, minVisibleSpanMs } from '../src/timeAxis';

const extent = { from: 0, to: 1_000_000 };

describe('TimeAxis', () => {
  it('clamps proposals into the extent preserving span', () => {
    const a = new TimeAxis(extent, { from: 100_000, to: 200_000 });
    a.propose({ from: -50_000, to: 50_000 }, 'gesture');
    expect(a.visible).toEqual({ from: 0, to: 100_000 });
    a.propose({ from: 950_000, to: 1_050_000 }, 'gesture');
    expect(a.visible).toEqual({ from: 900_000, to: 1_000_000 });
  });

  it('enforces the minimum span', () => {
    const a = new TimeAxis(extent, { from: 0, to: 500_000 }, 60_000);
    a.propose({ from: 100_000, to: 100_001 }, 'gesture');
    expect(a.visible.to - a.visible.from).toBe(60_000);
  });

  it('minVisibleSpanMs: pitch term scales with width, ensemble floor wins when narrow', () => {
    const barMs = 30 * 60_000;
    // wide plot: 1440px / 16px-per-bar = 90 bars
    expect(minVisibleSpanMs(barMs, 1440)).toBe(barMs * 90);
    // narrow plot: pitch term gives ceil(480/16)=30 < floor 48 → floor wins
    expect(minVisibleSpanMs(barMs, 480)).toBe(barMs * 48);
    // knobs override
    expect(minVisibleSpanMs(barMs, 1440, 48, 4)).toBe(barMs * 30);
    expect(minVisibleSpanMs(barMs, 100, 96, 4)).toBe(barMs * 4);
  });

  it('minSpanMs is mutable (width-dependent zoom clamp)', () => {
    const a = new TimeAxis(extent, { from: 0, to: 500_000 }, 1);
    a.minSpanMs = 100_000;
    a.propose({ from: 0, to: 10 }, 'gesture');
    expect(a.visible.to - a.visible.from).toBe(100_000);
  });

  it('notifies all subscribers with range and cause', () => {
    const a = new TimeAxis(extent, { from: 0, to: 100_000 });
    const seen: Array<[number, number, string]> = [];
    a.subscribe((r, c) => seen.push([r.from, r.to, c]));
    a.subscribe((r, c) => seen.push([r.from, r.to, c + '#2']));
    a.propose({ from: 10_000, to: 110_000 }, 'brush');
    expect(seen).toEqual([
      [10_000, 110_000, 'brush'],
      [10_000, 110_000, 'brush#2'],
    ]);
  });

  it('swallows no-op proposals (no listener churn)', () => {
    const a = new TimeAxis(extent, { from: 0, to: 100_000 });
    let calls = 0;
    a.subscribe(() => calls++);
    expect(a.propose({ from: 0, to: 100_000 }, 'navigate')).toBeNull();
    expect(calls).toBe(0);
  });

  it('unsubscribe detaches the component', () => {
    const a = new TimeAxis(extent, { from: 0, to: 100_000 });
    let calls = 0;
    const off = a.subscribe(() => calls++);
    a.propose({ from: 1, to: 100_001 }, 'gesture');
    off();
    a.propose({ from: 2, to: 100_002 }, 'gesture');
    expect(calls).toBe(1);
  });

  it('listeners cannot mutate the axis state via the delivered range', () => {
    const a = new TimeAxis(extent, { from: 0, to: 100_000 });
    a.subscribe((r) => {
      r.from = -999; // defensive copy — must not corrupt the axis
    });
    a.propose({ from: 5_000, to: 105_000 }, 'gesture');
    expect(a.visible).toEqual({ from: 5_000, to: 105_000 });
  });
});
