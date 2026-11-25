// Hatch tile sizing and legend swatches.
import { describe, expect, it } from 'vitest';
import { drawSpanLabel, hatchTileSize, spanHoverTime, spanSwatchCss } from '../src/spans';
import type { SeriesDef } from '../src/types';

describe('hatchTileSize', () => {
  it('is the pitch in device px', () => {
    expect(hatchTileSize({ pattern: 'diagonal', spacingPx: 7 }, 1)).toBe(7);
    expect(hatchTileSize({ pattern: 'diagonal', spacingPx: 7 }, 2)).toBe(14);
  });

  it('keeps a checker tile even so both squares match', () => {
    expect(hatchTileSize({ pattern: 'checker', spacingPx: 7 }, 1)).toBe(8);
    expect(hatchTileSize({ pattern: 'checker', spacingPx: 5 }, 1.5)).toBe(8);
    expect(hatchTileSize({ pattern: 'checker', spacingPx: 12 }, 2)).toBe(24);
  });
});

describe('spanSwatchCss', () => {
  it('draws a checker swatch over a transparent fill', () => {
    const def = { key: 'w', renderer: 'vrect', color: '#228b22' } as unknown as SeriesDef;
    const css = spanSwatchCss(def, { name: 'Pre', hatch: { pattern: 'checker', color: 'rgba(34,139,34,0.2)' } });
    expect(css).toContain('repeating-conic-gradient(rgba(34,139,34,0.2) 0 25%');
    expect(css.endsWith('transparent')).toBe(true);
  });
});

describe('spanHoverTime', () => {
  const M = 60_000;
  const BAR = 5 * M;
  // Friday bars to 23:55, weekend gap, Monday bars from 08:00 (UTC ms offsets).
  const fri = [0, BAR, 2 * BAR];
  const mon = [3 * 24 * 60 * M, 3 * 24 * 60 * M + BAR];
  const xs = [...fri, ...mon];

  it('takes the hovered bar when the cursor is over it', () => {
    expect(spanHoverTime(xs, mon[0]!, mon[0]! - 2 * M)).toBe(mon[0]);
  });

  it('keeps the cursor time over a gap', () => {
    const saturday = 24 * 60 * M;
    expect(spanHoverTime(xs, fri[2]!, saturday)).toBe(saturday);
    expect(spanHoverTime(xs, mon[0]!, mon[0]! - 10 * M)).toBe(mon[0]! - 10 * M);
  });

  it('keeps the cursor time when x is not a sample or stands alone', () => {
    expect(spanHoverTime(xs, 7, 9)).toBe(9);
    expect(spanHoverTime([5], 5, 6)).toBe(6);
  });
});

describe('drawSpanLabel', () => {
  const fakeCtx = () => {
    const calls: Array<{ text: string; x: number; y: number; fill: string; font: string }> = [];
    const strokes: Array<{ text: string; x: number; y: number; stroke: string; width: number }> = [];
    const order: string[] = [];
    const ctx = {
      font: '',
      fillStyle: '',
      textBaseline: '',
      textAlign: '',
      // Width proportional to the font size, like real text.
      measureText(t: string) {
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
        return { width: t.length * 0.6 * px };
      },
      strokeStyle: '',
      lineWidth: 0,
      lineJoin: '',
      fillText(text: string, x: number, y: number) {
        calls.push({ text, x, y, fill: String(this.fillStyle), font: this.font });
      },
      strokeText(text: string, x: number, y: number) {
        strokes.push({ text, x, y, stroke: String(this.strokeStyle), width: this.lineWidth });
        order.push('stroke');
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, strokes, order };
  };

  it('stacks lines and uses the label colour', () => {
    const { ctx, calls } = fakeCtx();
    drawSpanLabel(ctx, { text: 'Post-window\nT−15m→T+2', color: '#64748b', fontSizePx: 10 }, 0, 200, 10, 300, '#f97316', 1, false);
    expect(calls.map((c) => c.text)).toEqual(['Post-window', 'T−15m→T+2']);
    expect(calls[1]!.y - calls[0]!.y).toBe(12);
    expect(calls.every((c) => c.fill === '#64748b')).toBe(true);
  });

  it('falls back to the ink colour and hides when the widest line does not fit', () => {
    const { ctx, calls } = fakeCtx();
    drawSpanLabel(ctx, { text: 'A\nB' }, 0, 50, 0, 100, '#f97316', 1, false);
    expect(calls[0]!.fill).toBe('#f97316');
    const narrow = fakeCtx();
    drawSpanLabel(narrow.ctx, { text: 'Post-window\nT' }, 0, 60, 0, 100, '#000', 1, false);
    expect(narrow.calls).toHaveLength(0);
  });

  it('defaults to the given legend font and honours size and weight overrides', () => {
    const legend = { sizePx: 13, weight: '400', family: 'Inter' };
    const a = fakeCtx();
    drawSpanLabel(a.ctx, { text: 'X' }, 0, 200, 0, 100, '#000', 2, false, legend);
    expect(a.calls[0]!.font).toBe('400 26px Inter');
    const b = fakeCtx();
    drawSpanLabel(b.ctx, { text: 'X', fontSizePx: 14, fontWeight: 600 }, 0, 200, 0, 100, '#000', 1, false, legend);
    expect(b.calls[0]!.font).toBe('600 14px Inter');
  });

  it('strokes a halo under each line, twice the visible width', () => {
    const f = fakeCtx();
    drawSpanLabel(f.ctx, { text: 'A\nB', halo: { color: 'rgba(255,255,255,0.7)', widthPx: 1.5 } }, 0, 200, 0, 100, '#000', 2, false);
    expect(f.strokes.map((s) => s.text)).toEqual(['A', 'B']);
    expect(f.strokes[0]!.width).toBe(6);
    expect(f.strokes[0]!.stroke).toBe('rgba(255,255,255,0.7)');
    expect(f.calls.map((c) => [c.x, c.y])).toEqual(f.strokes.map((s) => [s.x, s.y]));
  });

  it('shrinks a label to fit a narrow span, and hides it below the floor', () => {
    const f = fakeCtx();
    // 'Post-window' is 79.2px at 12px; 70px of room fits it at 10px.
    drawSpanLabel(f.ctx, { text: 'Post-window\nT−15m→T+2' }, 0, 76, 0, 100, '#000', 1, false);
    expect(f.calls.map((c) => c.font)).toEqual(['400 10px system-ui, sans-serif', '400 10px system-ui, sans-serif']);
    expect(f.calls[1]!.y - f.calls[0]!.y).toBe(12);
    const g = fakeCtx();
    drawSpanLabel(g.ctx, { text: 'Post-window' }, 0, 66, 0, 100, '#000', 1, false);
    expect(g.calls).toHaveLength(0);
    const h = fakeCtx();
    drawSpanLabel(h.ctx, { text: 'Post-window', minFontSizePx: 8 }, 0, 66, 0, 100, '#000', 1, false);
    expect(h.calls[0]!.font).toBe('400 9px system-ui, sans-serif');
  });
});
