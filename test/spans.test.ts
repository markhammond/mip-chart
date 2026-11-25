// vrect/vline span series: store eviction, coalescing, break model, segmented
// PCHIP, hover selection, and regression fixtures proving recipes without span
// series draw exactly as in v0.3.0.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SeriesStore } from '../src/seriesStore';
import {
  breakGapsPx,
  breakIntervals,
  coalesceSpans,
  hasBreakingCategory,
  linesNear,
  opaque,
  spanPaneIds,
  spansAt,
  spansInRange,
  subtractIntervals,
  unionIntervals,
  type Span,
} from '../src/spans';
import { pchipPaths, pchipSegment, segmentAtBreaks } from '../src/paths';
import { stateBarsPlugin } from '../src/stateBars';
import { renderHoverTemplate } from '../src/hoverFormat';
import type { SeriesDef, SeriesFragment, SpanStyle } from '../src/types';

const frag = (xs: number[], columns: Record<string, Array<number | null>>): SeriesFragment => ({
  laneId: 'visible',
  sampleIntervalMs: 0,
  phaseId: 1,
  fragmentCount: 1,
  seriesKey: 's',
  range: { from: 0, to: 1000 },
  xs,
  columns,
});

const CLOSED: SpanStyle = { name: 'Closed', breaks: true };
const OVERNIGHT: SpanStyle = { name: 'Overnight', breaks: true, breakMinPx: 5 };
const WINDOW: SpanStyle = { name: 'Window' };

const vrect = (over: Partial<SeriesDef> = {}): SeriesDef => ({
  key: 'sessions',
  paneId: 'price',
  label: 'Sessions',
  color: '#888',
  renderer: 'vrect',
  columns: ['end', 'category'],
  categories: [CLOSED, OVERNIGHT, WINDOW],
  ...over,
});

const spanStore = (rows: Array<[number, number, number]>): SeriesStore => {
  const s = new SeriesStore(['end', 'category'], 'end');
  s.merge(frag(rows.map((r) => r[0]), { end: rows.map((r) => r[1]), category: rows.map((r) => r[2]) }));
  return s;
};

const sp = (start: number, end: number, cat = 0, idx = 0): Span => ({ start, end, cat, idx });
const id = (t: number) => t;

/** Path2D stand-in recording ops. */
class RecPath {
  ops: unknown[][] = [];
  moveTo(x: number, y: number) { this.ops.push(['M', x, y]); }
  lineTo(x: number, y: number) { this.ops.push(['L', x, y]); }
  bezierCurveTo(...a: number[]) { this.ops.push(['C', ...a]); }
  rect(...a: number[]) { this.ops.push(['R', ...a]); }
}

const g = globalThis as Record<string, unknown>;
const saved = { Path2D: g['Path2D'], window: g['window'] };
beforeAll(() => {
  g['Path2D'] = RecPath;
  g['window'] = { devicePixelRatio: 2 };
});
afterAll(() => {
  g['Path2D'] = saved.Path2D;
  g['window'] = saved.window;
});

// Fixed scene shared with the v0.3.0 fixtures below.
const XS = [0, 10, 20, 30, 45, 50, 60, 70, 80, 95, 100, 110];
const fakeU = (ys: Array<number | null>, yLo = 0, ySpan = 10) => ({
  data: [XS, ys],
  series: [{}, { scale: 'y' }],
  scales: { x: { min: 0, max: 110 }, y: { min: yLo, max: yLo + ySpan } },
  bbox: { left: 10, top: 5, width: 440, height: 200 },
  valToPos: (v: number, k: string) =>
    k === 'x' ? 10 + (v / 110) * 440 : 5 + 200 - ((v - yLo) / ySpan) * 200,
});

describe('span store eviction', () => {
  it('keeps a span that started before keep.from but still overlaps it', () => {
    const s = spanStore([[0, 50, 0], [10, 20, 1], [60, 70, 0], [200, 300, 0]]);
    s.evictOutside({ from: 30, to: 150 });
    expect(s.xs).toEqual([0, 60]); // [10,20) ended; [200,300) starts after keep.to
    expect(s.columns['end']).toEqual([50, 70]);
    expect(s.columns['category']).toEqual([0, 0]);
  });

  it('drops a span ending exactly at keep.from (half-open)', () => {
    const s = spanStore([[0, 30, 0], [40, 50, 0]]);
    s.evictOutside({ from: 30, to: 100 });
    expect(s.xs).toEqual([40]);
  });

  it('keeps merge semantics: start collision, new wins', () => {
    const s = spanStore([[0, 30, 0]]);
    s.merge(frag([0], { end: [45], category: [1] }));
    expect(s.xs).toEqual([0]);
    expect(s.columns['end']).toEqual([45]);
    expect(s.columns['category']).toEqual([1]);
  });

  it('leaves point stores on plain index eviction', () => {
    const s = new SeriesStore(['value']);
    s.merge(frag([0, 10, 20], { value: [1, 2, 3] }));
    s.evictOutside({ from: 5, to: 15 });
    expect(s.xs).toEqual([10]);
  });
});

describe('span selection', () => {
  const s = spanStore([[0, 50, 0], [20, 30, 2], [50, 60, 1], [80, 80, 0]]);
  const def = vrect();

  it('finds spans overlapping a range, skipping zero-length ones', () => {
    expect(spansInRange(s, def, 25, 55).map((x) => x.start)).toEqual([0, 20, 50]);
    expect(spansInRange(s, def, 70, 90)).toEqual([]);
  });

  it('hover: covers start ≤ t < end, overlapping spans all hit', () => {
    expect(spansAt(s, def, 25).map((x) => [x.start, x.cat])).toEqual([[0, 0], [20, 2]]);
    expect(spansAt(s, def, 50).map((x) => x.start)).toEqual([50]); // end-exclusive, start-inclusive
    expect(spansAt(s, def, 60)).toEqual([]);
  });

  it('defaults a missing category column to 0', () => {
    const noCat = new SeriesStore(['end'], 'end');
    noCat.merge(frag([0], { end: [10] }));
    expect(spansAt(noCat, vrect({ columns: ['end'] }), 5)[0]!.cat).toBe(0);
  });

  it('hover: vlines within tolerance', () => {
    const lines = new SeriesStore(['category']);
    lines.merge(frag([100, 104, 120], { category: [0, 1, 0] }));
    const vl = vrect({ renderer: 'vline', columns: ['category'] });
    expect(linesNear(lines, vl, 101, 4).map((l) => [l.t, l.cat])).toEqual([[100, 0], [104, 1]]);
    expect(linesNear(lines, vl, 112, 4)).toEqual([]);
  });

  it('resolves panes in recipe order', () => {
    const ids = ['price', 'osc', 'state'];
    expect(spanPaneIds(vrect(), ids)).toEqual(['price']);
    expect(spanPaneIds(vrect({ panes: 'all' }), ids)).toEqual(ids);
    expect(spanPaneIds(vrect({ panes: ['state', 'price', 'nope'] }), ids)).toEqual(['price', 'state']);
  });
});

describe('coalesceSpans', () => {
  it('merges touching/overlapping same-category spans, not other categories', () => {
    const out = coalesceSpans([sp(0, 10, 0), sp(10, 20, 0), sp(15, 30, 0), sp(30, 40, 1)], id);
    expect(out.map((s) => [s.start, s.end, s.cat])).toEqual([[0, 30, 0], [30, 40, 1]]);
  });

  it('drops spans narrower than minWidthPx', () => {
    const out = coalesceSpans([sp(0, 0.5), sp(10, 12), sp(20, 20.9)], id, 1);
    expect(out.map((s) => s.start)).toEqual([10]);
  });

  it('merges same-category spans across a sub-pixel seam', () => {
    const out = coalesceSpans([sp(0, 10), sp(10.5, 20), sp(25, 30)], id, 1, 1);
    expect(out.map((s) => [s.start, s.end])).toEqual([[0, 20], [25, 30]]);
  });

  it('drops tiny spans before seam-merging, so wide zooms do not chain them', () => {
    // Overnights at a 5-year zoom: 0.3px spans 0.12px apart vanish, not fuse.
    const tiny = Array.from({ length: 50 }, (_, i) => sp(i * 0.42, i * 0.42 + 0.3, 1));
    expect(coalesceSpans(tiny, id, 1, 1)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [sp(0, 10), sp(10, 20)];
    coalesceSpans(input, id);
    expect(input[0]!.end).toBe(10);
  });
});

describe('break model', () => {
  const styleOf = (c: number) => [CLOSED, OVERNIGHT, WINDOW][c];

  it('keeps only breaking categories at least breakMinPx wide', () => {
    const spans = [sp(0, 2, 0), sp(10, 14, 0), sp(20, 24, 1), sp(30, 40, 1), sp(50, 90, 2)];
    // Closed: default 3px → [10,14). Overnight: 5px → [30,40). Window never breaks.
    expect(breakIntervals(spans, styleOf, id)).toEqual([[10, 14], [30, 40]]);
  });

  it('measures width after merging touching same-category spans', () => {
    expect(breakIntervals([sp(0, 2, 0), sp(2, 4, 0)], styleOf, id)).toEqual([[0, 4]]);
  });

  it('unions abutting breaks across categories', () => {
    expect(breakIntervals([sp(0, 10, 1), sp(10, 20, 0)], styleOf, id)).toEqual([[0, 20]]);
    expect(unionIntervals([[5, 8], [0, 3], [3, 4]])).toEqual([[0, 4], [5, 8]]);
  });

  it('flags series with breaking categories', () => {
    expect(hasBreakingCategory(vrect())).toBe(true);
    expect(hasBreakingCategory(vrect({ categories: [WINDOW] }))).toBe(false);
    expect(hasBreakingCategory(vrect({ renderer: 'vline' }))).toBe(false);
  });
});

describe('breakGapsPx', () => {
  const xs = [0, 10, 20, 30, 40, 50, 60];

  it('linear: gap spans last sample before → first sample after the break', () => {
    const ys = [1, 2, 3, null, null, 6, 7];
    expect(breakGapsPx(xs, ys, [[25, 45]], id)).toEqual([[20, 50]]);
  });

  it('ignores alignment nulls: no breaks → no gaps', () => {
    expect(breakGapsPx(xs, [1, null, 3, null, 5, null, 7], [], id)).toEqual([]);
  });

  it('bridges nulls inside the gap search: P/Q are the nearest non-null samples', () => {
    const ys = [1, null, null, null, null, null, 7];
    expect(breakGapsPx(xs, ys, [[25, 35]], id)).toEqual([[0, 60]]);
  });

  it('hides samples inside a break (half-open [start, end))', () => {
    const ys = [1, 2, 3, 4, 5, 6, 7];
    expect(breakGapsPx(xs, ys, [[30, 50]], id)).toEqual([[20, 50]]);
  });

  it('stepped: keeps the held value up to the break start, pads the riser', () => {
    const ys = [1, 2, 3, null, null, 6, 7];
    expect(breakGapsPx(xs, ys, [[25, 45]], id, 'stepped', 1.5)).toEqual([[25, 51.5]]);
  });

  it('falls back to break edges when the series has no sample on a side', () => {
    expect(breakGapsPx(xs, [null, null, null, null, 5, 6, 7], [[5, 25]], id)).toEqual([[5, 40]]);
    expect(breakGapsPx(xs, [1, 2, null, null, null, null, null], [[30, 70]], id)).toEqual([[10, 70]]);
  });

  it('merges gaps of back-to-back breaks with no samples between', () => {
    const ys = [1, 2, null, null, null, 6, 7];
    expect(breakGapsPx(xs, ys, [[15, 25], [30, 45]], id)).toEqual([[10, 50]]);
  });

  it('subtracts gaps from loaded clip strips', () => {
    expect(subtractIntervals([[0, 100]], [[20, 30], [50, 60]])).toEqual([[0, 20], [30, 50], [60, 100]]);
    expect(subtractIntervals([[0, 40], [60, 100]], [[30, 70]])).toEqual([[0, 30], [70, 100]]);
    expect(subtractIntervals([[0, 10]], [[-5, 20]])).toEqual([]);
    expect(subtractIntervals([[0, 10]], [])).toEqual([[0, 10]]);
  });
});

describe('segmented PCHIP', () => {
  it('splits non-null rows at breaks and drops rows inside them', () => {
    const ys = [1, 2, null, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    // Break [40, 65): drops x=45,50,60; also splits there.
    expect(segmentAtBreaks(XS, ys, 0, 11, [[40, 65]])).toEqual([[0, 1, 3], [7, 8, 9, 10, 11]]);
    // A break between samples (no row inside) still splits.
    expect(segmentAtBreaks(XS, ys, 0, 11, [[32, 44]])).toEqual([[0, 1, 3], [4, 5, 6, 7, 8, 9, 10, 11]]);
    expect(segmentAtBreaks(XS, ys, 0, 11, [])).toEqual([[0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11]]);
  });

  it('never connects across a break, and each run has its own endpoint tangents', () => {
    const ys = [5, 7, null, 6, 9, 9, 4, null, 3, 8, 8.5, 2];
    const u = fakeU(ys);
    const p = pchipPaths(() => [[50, 75]])(u as never, 1, 0, 11) as unknown as { stroke: RecPath };
    const moves = p.stroke.ops.filter((o) => o[0] === 'M');
    expect(moves).toHaveLength(2); // two independent runs
    // Second run (x=80…110) equals a standalone PCHIP of just those points.
    const run2 = [8, 9, 10, 11];
    const solo = new RecPath();
    pchipSegment(
      solo,
      run2.map((i) => u.valToPos(XS[i]!, 'x')),
      run2.map((i) => u.valToPos(ys[i]!, 'y')),
    );
    const at = p.stroke.ops.findIndex((o) => o[0] === 'M' && o !== moves[0]);
    expect(p.stroke.ops.slice(at)).toEqual(solo.ops);
    // No segment spans the break [50, 75) in pixel space.
    const bx0 = u.valToPos(50, 'x');
    const bx1 = u.valToPos(75, 'x');
    let px = NaN;
    for (const o of p.stroke.ops) {
      const x = o[o.length - 2] as number;
      if (o[0] !== 'M') expect(px >= bx1 || x <= bx0).toBe(true);
      px = x;
    }
  });
});

describe('recipes without span series are unaffected (v0.3.0 fixtures)', () => {
  // Captured from the pre-change pchipPaths / stateBarsPlugin on this scene.
  const PCHIP_V030 = [["M",10,105],["C",23.333333333333336,86.11111111111111,36.666666666666664,65,50,65],["C",76.66666666666667,65,103.33333333333333,85,130,85],["C",150,85,170,25,190,25],["C",196.66666666666666,25,203.33333333333334,25,210,25],["C",223.33333333333331,25,236.66666666666666,118.33333333333334,249.99999999999997,125],["C",276.66666666666663,138.33333333333334,303.3333333333333,145,330,145],["C",350,145,370,59.11764705882353,390,45],["C",396.6666666666667,40.294117647058826,403.3333333333333,35,410,35],["C",423.3333333333333,35,436.6666666666667,88.33333333333333,450,165]];
  const BARS_V030 = [["F","#440154"],["R",-10,130,40,75],["F","#440154"],["R",30,130,60,75],["F","#31688e"],["R",90,80,70,125],["F","#35b779"],["R",160,30,40,175],["F","#35b779"],["R",200,30,30,175],["F","#440154"],["R",230,130,60,75],["F","#31688e"],["R",290,80,70,125],["F","#31688e"],["R",360,80,40,125],["F","#35b779"],["R",400,30,30,175],["F","#440154"],["R",430,130,40,75]];
  const STATES = [1, 1, null, 2, 3, 3, 1, null, 2, 2, 3, 1];

  const drawBars = (breaks?: Array<[number, number]>) => {
    const calls: unknown[][] = [];
    const ctx = {
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      set fillStyle(v: string) { calls.push(['F', v]); },
      set globalAlpha(_v: number) {},
      fillRect(...a: number[]) { calls.push(['R', ...a]); },
    };
    const u = { ...fakeU(STATES, -0.5, 4), ctx };
    const plugin = stateBarsPlugin({ seriesIdx: 1, ...(breaks ? { breaks: () => breaks } : {}) });
    (plugin.hooks.draw as (u: unknown) => void)(u);
    return calls;
  };

  it('pchipPaths() draws byte-identical paths', () => {
    const ys = [5, 7, null, 6, 9, 9, 4, null, 3, 8, 8.5, 2];
    const p = pchipPaths()(fakeU(ys) as never, 1, 0, 11) as unknown as { stroke: RecPath };
    expect(p.stroke.ops).toEqual(PCHIP_V030);
    const empty = pchipPaths(() => [])(fakeU(ys) as never, 1, 0, 11) as unknown as { stroke: RecPath };
    expect(empty.stroke.ops).toEqual(PCHIP_V030);
  });

  it('state bars without breaks paint byte-identical rects', () => {
    expect(drawBars()).toEqual(BARS_V030);
    expect(drawBars([])).toEqual(BARS_V030);
  });

  it('state bars cap at break boundaries and skip samples inside', () => {
    // Break [55, 75): bar at x=50 ends at px(55); x=60 is skipped; x=80 starts at px(75).
    const calls = drawBars([[55, 75]]).filter((c) => c[0] === 'R');
    const px = (t: number) => Math.round(10 + (t / 110) * 440);
    const xs = calls.map((c) => [c[1], (c[1] as number) + (c[3] as number)]);
    expect(xs).toContainEqual([px(47.5), px(55)]); // x=50: left midpoint, right capped
    expect(xs.some(([l]) => l === px(60) || l === px(65))).toBe(false); // x=60 dropped
    expect(xs).toContainEqual([px(75), px(87.5)]); // x=80 resumes at the break end
  });
});

describe('span hover templates', () => {
  it('formats a column as a date and names the category', () => {
    const text = renderHoverTemplate('{label}: {category} {x:date:MM-DD HH:mm} → {col.end:date:MM-DD HH:mm}', {
      label: 'Sessions',
      x: Date.UTC(2024, 9, 25, 21),
      value: 1,
      column: (n) => (n === 'end' ? Date.UTC(2024, 9, 28, 14, 30) : null),
      category: 'Overnight',
    });
    expect(text).toBe('Sessions: Overnight 10-25 21:00 → 10-28 14:30');
  });

  it('renders a missing date column as an em dash', () => {
    expect(
      renderHoverTemplate('{col.end:date:HH:mm} {category}', { label: '', x: 0, value: null, column: () => null }),
    ).toBe('— —');
  });

  it('strips alpha for legible bullets', () => {
    expect(opaque('rgba(120,120,140,.07)')).toBe('rgb(120, 120, 140)');
    expect(opaque('#3f51b5cc')).toBe('#3f51b5');
    expect(opaque('#e53935')).toBe('#e53935');
  });
});
