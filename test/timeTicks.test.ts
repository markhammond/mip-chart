// TVLC weighted time-axis ticks (timeTicks.ts) — calendar boundaries in UTC
// (F7), greedy by weight, spacing-respecting.
import { describe, expect, it } from 'vitest';
import { tvTimeTicks } from '../src/timeTicks';

const o = { widthPx: 1200, fontPx: 12 }; // minPx ≈ 58

describe('tvTimeTicks', () => {
  it('multi-year span: year marks dominate', () => {
    const from = Date.UTC(2019, 0, 15);
    const to = Date.UTC(2026, 5, 1);
    const ticks = tvTimeTicks(from, to, o);
    const years = ticks.filter((t) => t.weight === 70).map((t) => t.label);
    expect(years).toEqual(['2020', '2021', '2022', '2023', '2024', '2025', '2026']);
    // months may fill remaining gaps, never closer than minPx
    const pxPerMs = o.widthPx / (to - from);
    for (let i = 1; i < ticks.length; i++) {
      expect((ticks[i]!.t - ticks[i - 1]!.t) * pxPerMs).toBeGreaterThanOrEqual(44);
    }
  });

  it('two-month span: month starts + day numbers', () => {
    const from = Date.UTC(2026, 3, 1);
    const to = Date.UTC(2026, 5, 1);
    const ticks = tvTimeTicks(from, to, o);
    expect(ticks.some((t) => t.label === 'May' && t.weight === 60)).toBe(true);
    expect(ticks.some((t) => t.weight === 50)).toBe(true); // day marks
    // chronological + on-grid days at UTC midnights (F7)
    for (const t of ticks.filter((t) => t.weight === 50)) {
      expect(t.t % (24 * 3600e3)).toBe(0);
    }
  });

  it('one-day span: intraday HH:MM marks, midnights excluded from hours', () => {
    const from = Date.UTC(2026, 5, 4);
    const to = Date.UTC(2026, 5, 5);
    const ticks = tvTimeTicks(from, to, o);
    const hours = ticks.filter((t) => t.weight >= 19 && t.weight <= 33);
    expect(hours.length).toBeGreaterThan(4);
    expect(hours.every((t) => /^\d2:\d2$/.test(t.label) || /^\d\d:\d\d$/.test(t.label))).toBe(true);
    // the day boundary carries the day mark, not 00:00
    expect(ticks.find((t) => t.t === from)?.weight).toBe(50);
  });

  it('higher weights win space over finer levels', () => {
    const from = Date.UTC(2026, 4, 30);
    const to = Date.UTC(2026, 5, 6);
    const ticks = tvTimeTicks(from, to, o);
    // June 1 must be the month mark, with no intraday mark crowding it
    const june1 = ticks.find((t) => t.t === Date.UTC(2026, 5, 1));
    expect(june1?.label).toBe('Jun');
    expect(june1?.weight).toBe(60);
  });

  it('empty on degenerate input', () => {
    expect(tvTimeTicks(5, 5, o)).toEqual([]);
  });
});
