// Hover template rendering (§4.8 — recipe-defined, Plotly-inspired subset).

import { describe, expect, it } from 'vitest';
import {
  formatHoverDate,
  formatHoverNumber,
  renderHoverTemplate,
  type HoverContext,
} from '../src/hoverFormat';

const ctx = (over: Partial<HoverContext> = {}): HoverContext => ({
  label: 'VWAP',
  x: Date.UTC(2026, 4, 29, 16, 0), // 2026-05-29 16:00 UTC
  value: 73440.62,
  column: (name) => (name === 'rate' ? 0.000067 : name === 'interval' ? 8 : null),
  stateName: null,
  ...over,
});

describe('formatHoverNumber', () => {
  it('fixed decimals (.2f)', () => {
    expect(formatHoverNumber(12.345, '.2f')).toBe('12.35');
  });

  it('SI scaling (.3s)', () => {
    expect(formatHoverNumber(73440.62, '.3s')).toBe('73.441k');
    expect(formatHoverNumber(2.5e6, '.1s')).toBe('2.5M');
    expect(formatHoverNumber(1.2e9, '.2s')).toBe('1.20B');
    expect(formatHoverNumber(-73440.62, '.3s')).toBe('-73.441k');
    expect(formatHoverNumber(512, '.1s')).toBe('512.0'); // below 1k: plain fixed
  });

  it('percent (.4%)', () => {
    expect(formatHoverNumber(0.000067, '.4%')).toBe('0.0067%');
  });

  it('basis points (.Nbp)', () => {
    expect(formatHoverNumber(0.000067, '.2bp')).toBe('0.67bps');
    expect(formatHoverNumber(0.0001, '.2bp')).toBe('1.00bps');
    expect(formatHoverNumber(-0.0000086, '.2bp')).toBe('-0.09bps');
    expect(formatHoverNumber(0.000025, '.1bp')).toBe('0.3bps');
  });

  it('null / NaN → em dash', () => {
    expect(formatHoverNumber(null, '.2f')).toBe('—');
    expect(formatHoverNumber(Number.NaN)).toBe('—');
  });

  it('default compact formatting by magnitude', () => {
    expect(formatHoverNumber(73440.62)).toBe('73,441');
    expect(formatHoverNumber(12.345)).toBe('12.35');
    expect(formatHoverNumber(0.000123)).toBe('0.000123');
  });

  it('unknown FMT falls through to compact default', () => {
    expect(formatHoverNumber(12.345, '.2x')).toBe('12.35');
  });
});

describe('formatHoverDate', () => {
  it('renders UTC pattern tokens', () => {
    const t = Date.UTC(2026, 4, 29, 16, 5);
    expect(formatHoverDate(t, 'YYYY-MM-DD HH:mm')).toBe('2026-05-29 16:05');
    expect(formatHoverDate(t, 'MM-DD HH:mm')).toBe('05-29 16:05');
  });
});

describe('renderHoverTemplate', () => {
  it('label + formatted value', () => {
    expect(renderHoverTemplate('{label}: {value:.3s}', ctx())).toBe('VWAP: 73.441k');
  });

  it('auxiliary columns with formats ({col.NAME:FMT})', () => {
    expect(
      renderHoverTemplate('Pay: {col.rate:.4%} / Interval: {col.interval:.0f}h', ctx()),
    ).toBe('Pay: 0.0067% / Interval: 8h');
  });

  it('date placeholder ({x:date:PATTERN})', () => {
    expect(renderHoverTemplate('Settlement: {x:date:MM-DD HH:mm}', ctx())).toBe(
      'Settlement: 05-29 16:00',
    );
  });

  it('state placeholder', () => {
    expect(renderHoverTemplate('{label}: {state}', ctx({ stateName: 'Bullish' }))).toBe(
      'VWAP: Bullish',
    );
    expect(renderHoverTemplate('{state}', ctx())).toBe('—');
  });

  it('sign verb pick ({sign:Pay|Receive})', () => {
    expect(renderHoverTemplate('{sign:Pay|Receive}', ctx({ value: 0.0001 }))).toBe('Pay');
    expect(renderHoverTemplate('{sign:Pay|Receive}', ctx({ value: -0.0001 }))).toBe('Receive');
    expect(renderHoverTemplate('{sign:Pay|Receive}', ctx({ value: null }))).toBe('—');
  });

  it('multi-line funding parity template (both sides via {sign})', () => {
    const t =
      '{label} · {sign:Pay|Receive}: {col.rate:.2bp}\nSettlement: {x:date:MM-DD HH:mm}\nInterval: {col.interval:.0f}h';
    expect(renderHoverTemplate(t, ctx({ label: 'Long', value: 0.000067 })).split('\n')).toEqual([
      'Long · Pay: 0.67bps',
      'Settlement: 05-29 16:00',
      'Interval: 8h',
    ]);
    expect(renderHoverTemplate(t, ctx({ label: 'Short', value: -0.000067 })).split('\n')).toEqual([
      'Short · Receive: 0.67bps',
      'Settlement: 05-29 16:00',
      'Interval: 8h',
    ]);
  });

  it('unknown placeholder / missing column → em dash, never throws', () => {
    expect(renderHoverTemplate('{nope} {col.absent}', ctx())).toBe('— —');
  });
});
