// Span series — 'vrect' shaded time spans and 'vline' event lines — drawn per
// pane straight from their stores; never uPlot series, so they never affect
// alignment, autofit or percent mode. Also the break model for line series.

import type uPlot from 'uplot';
import type { ExcelPattern, SeriesDef, SpanHatch, SpanStyle } from './types';
import { lowerBound, type SeriesStore } from './seriesStore';

/** Half-open time interval [start, end) in UTC ms. */
export type Interval = readonly [number, number];

/** One vrect span (store row `idx` is the first source span after merging). */
export interface Span {
  start: number;
  end: number;
  cat: number;
  idx: number;
}

/** One vline. */
export interface VLine {
  t: number;
  cat: number;
  idx: number;
}

const DEFAULT_BREAK_MIN_PX = 3;
/** Same-category spans closer than this (CSS px) merge into one rect. */
const SEAM_PX = 1;
/** Hover tolerance around a vline (CSS px). */
export const VLINE_HOVER_PX = 4;
const DEFAULT_HATCH_COLOR = 'rgba(0,0,0,.28)';

export function isSpanRenderer(r: string | undefined): r is 'vrect' | 'vline' {
  return r === 'vrect' || r === 'vline';
}

/** Panes a span series draws in, in recipe pane order. */
export function spanPaneIds(def: SeriesDef, paneIds: readonly string[]): string[] {
  if (def.panes === 'all') return [...paneIds];
  const wanted = def.panes?.length ? def.panes : [def.paneId];
  return paneIds.filter((id) => wanted.includes(id));
}

/** Column roles: vrect [end, category?], vline [category?]. */
export function spanColumns(def: SeriesDef): { end?: string; category?: string } {
  return def.renderer === 'vrect'
    ? { end: def.columns[0], category: def.columns[1] }
    : { category: def.columns[0] };
}

/** True when any category of this vrect series breaks lines. */
export function hasBreakingCategory(def: SeriesDef): boolean {
  return def.renderer === 'vrect' && !!def.categories?.some((c) => c.breaks);
}

function catAt(cats: ArrayLike<number | null> | undefined, i: number): number {
  const c = cats?.[i];
  return c == null || !Number.isFinite(c) ? 0 : Math.round(c);
}

/** vrect spans overlapping [from, to), in start order. */
export function spansInRange(store: SeriesStore, def: SeriesDef, from: number, to: number): Span[] {
  return collectSpans(store, def, lowerBound(store.xs, to), from);
}

/** vrect spans covering time t (start ≤ t < end). */
export function spansAt(store: SeriesStore, def: SeriesDef, t: number): Span[] {
  let hi = lowerBound(store.xs, t);
  while (hi < store.xs.length && store.xs[hi] === t) hi++;
  return collectSpans(store, def, hi, t);
}

/** Spans among rows [0, hi) whose end is after `from`. */
function collectSpans(store: SeriesStore, def: SeriesDef, hi: number, from: number): Span[] {
  const { end, category } = spanColumns(def);
  const ends = end ? store.columns[end] : undefined;
  const cats = category ? store.columns[category] : undefined;
  const out: Span[] = [];
  for (let i = 0; i < hi; i++) {
    const start = store.xs[i]!;
    const e = ends?.[i] ?? start;
    if (e <= from || e <= start) continue;
    out.push({ start, end: e, cat: catAt(cats, i), idx: i });
  }
  return out;
}

/**
 * Time at which to describe spans on hover. Over data the tooltip shows the
 * nearest sample `x`, so spans are taken at `x` and the session row agrees with
 * the bar. Over a gap (a weekend), where the nearest sample lies across it, they
 * are taken at the cursor time `rawX`. The cursor counts as over data when it is
 * within one local step of `x`: the smaller of its two neighbour gaps.
 */
export function spanHoverTime(xs: ArrayLike<number>, x: number, rawX: number): number {
  let i = 0;
  let hi = xs.length;
  while (i < hi) {
    const m = (i + hi) >>> 1;
    if (xs[m]! < x) i = m + 1;
    else hi = m;
  }
  if (i >= xs.length || xs[i] !== x) return rawX;
  const prev = i > 0 ? x - xs[i - 1]! : Number.POSITIVE_INFINITY;
  const next = i < xs.length - 1 ? xs[i + 1]! - x : Number.POSITIVE_INFINITY;
  const step = Math.min(prev, next);
  return Number.isFinite(step) && Math.abs(rawX - x) <= step ? x : rawX;
}

/** vlines with t in [from, to], in time order. */
export function linesInRange(store: SeriesStore, def: SeriesDef, from: number, to: number): VLine[] {
  const cats = spanColumns(def).category;
  const col = cats ? store.columns[cats] : undefined;
  const out: VLine[] = [];
  for (let i = lowerBound(store.xs, from); i < store.xs.length; i++) {
    const t = store.xs[i]!;
    if (t > to) break;
    out.push({ t, cat: catAt(col, i), idx: i });
  }
  return out;
}

/** vlines within `tolMs` of time t. */
export function linesNear(store: SeriesStore, def: SeriesDef, t: number, tolMs: number): VLine[] {
  return linesInRange(store, def, t - tolMs, t + tolMs);
}

/** Merge same-category spans that touch or overlap in time (start order kept). */
export function mergeTouching(spans: readonly Span[]): Span[] {
  const open = new Map<number, Span>();
  const out: Span[] = [];
  for (const s of spans) {
    const o = open.get(s.cat);
    if (o && s.start <= o.end) {
      if (s.end > o.end) o.end = s.end;
      continue;
    }
    const c = { ...s };
    open.set(s.cat, c);
    out.push(c);
  }
  return out;
}

/**
 * Coalesce spans for drawing at the current zoom: merge touching same-category
 * spans, drop those narrower than `minWidthPx`, then merge same-category spans
 * separated by less than `seamPx`. `toPx` maps time into the thresholds' unit.
 */
export function coalesceSpans(
  spans: readonly Span[],
  toPx: (t: number) => number,
  minWidthPx = 1,
  seamPx = SEAM_PX,
): Span[] {
  const wide = mergeTouching(spans).filter((s) => toPx(s.end) - toPx(s.start) >= minWidthPx);
  const last = new Map<number, Span>();
  const out: Span[] = [];
  for (const s of wide) {
    const o = last.get(s.cat);
    if (o && toPx(s.start) - toPx(o.end) < seamPx) {
      if (s.end > o.end) o.end = s.end;
      continue;
    }
    last.set(s.cat, s);
    out.push(s);
  }
  return out;
}

/** Sort and merge overlapping/touching intervals. */
export function unionIntervals(ivs: readonly Interval[]): Interval[] {
  const sorted = [...ivs].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Break intervals for one series' spans: spans whose category `breaks` and
 * that render at least `breakMinPx` wide (`toPx` in CSS px), sorted + merged.
 */
export function breakIntervals(
  spans: readonly Span[],
  styleOf: (cat: number) => SpanStyle | undefined,
  toPx: (t: number) => number,
): Interval[] {
  const breaking = mergeTouching(spans.filter((s) => styleOf(s.cat)?.breaks));
  const wide = breaking.filter(
    (s) => toPx(s.end) - toPx(s.start) >= (styleOf(s.cat)?.breakMinPx ?? DEFAULT_BREAK_MIN_PX),
  );
  return unionIntervals(wide.map((s) => [s.start, s.end] as const));
}

/**
 * Pixel gaps a line must not draw through, one per break: from the series'
 * last sample before the break to its first sample at/after the break end
 * ('stepped' keeps the held value up to the break start). Alignment nulls are
 * ignored (bridged). `padPx` widens each gap's end (hides a step riser).
 */
export function breakGapsPx(
  xs: ArrayLike<number>,
  ys: ArrayLike<number | null | undefined>,
  breaks: readonly Interval[],
  toPx: (t: number) => number,
  mode: 'linear' | 'stepped' = 'linear',
  padPx = 0,
): Array<[number, number]> {
  if (breaks.length === 0) return [];
  const nn: number[] = [];
  for (let i = 0; i < ys.length; i++) if (ys[i] != null) nn.push(i);
  // First position in nn whose time is >= t.
  const firstAtOrAfter = (t: number): number => {
    let lo = 0;
    let hi = nn.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (xs[nn[mid]!]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const gaps: Array<[number, number]> = [];
  for (const [s, e] of breaks) {
    const a = firstAtOrAfter(s);
    const b = firstAtOrAfter(e);
    const p = a > 0 ? nn[a - 1]! : -1;
    const q = b < nn.length ? nn[b]! : -1;
    const g0 = mode === 'stepped' || p < 0 ? toPx(s) : toPx(xs[p]!);
    const g1 = (q < 0 ? toPx(e) : toPx(xs[q]!)) + padPx;
    if (g1 > g0) gaps.push([g0, g1]);
  }
  return unionIntervals(gaps) as Array<[number, number]>;
}

/** Subtract sorted, disjoint gaps from sorted, disjoint keep-intervals. */
export function subtractIntervals(
  keep: ReadonlyArray<readonly [number, number]>,
  gaps: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let j = 0;
  for (const [k0, k1] of keep) {
    let cur = k0;
    while (j < gaps.length && gaps[j]![1] <= cur) j++;
    let g = j;
    while (g < gaps.length && gaps[g]![0] < k1) {
      const [g0, g1] = gaps[g]!;
      if (g0 > cur) out.push([cur, g0]);
      cur = Math.max(cur, g1);
      if (cur >= k1) break;
      g++;
    }
    if (cur < k1) out.push([cur, k1]);
  }
  return out;
}

// ---------------------------------------------------------------- styling

/** Opaque ink for tooltip bullets, legend, labels and minimap marks — a
 *  faint span tint would vanish at bullet size. */
export function spanInkColor(def: SeriesDef, style: SpanStyle | undefined): string {
  return opaque(style?.edge?.color ?? style?.hatch?.color ?? style?.fill ?? def.color);
}

/** Drop the alpha of an rgba()/hsla()/#rrggbbaa/#rgba colour; others pass through. */
export function opaque(color: string): string {
  const c = color.trim();
  const fn = /^(rgb|hsl)a?\(\s*([^,\s]+)[\s,]+([^,\s]+)[\s,]+([^,\s/)]+)/i.exec(c);
  if (fn) return `${fn[1]!.toLowerCase()}(${fn[2]}, ${fn[3]}, ${fn[4]})`;
  if (/^#([0-9a-f]{8}|[0-9a-f]{4})$/i.test(c)) return c.slice(0, c.length === 9 ? 7 : 4);
  return c;
}

/** Excel's fill patterns as 8×8 bitmaps: one byte per row, high bit leftmost,
 *  rows repeating to eight. `label` is Excel's Format Cells name. */
export const EXCEL_PATTERNS: Record<ExcelPattern, { label: string; rows: readonly number[] }> = {
  solid: { label: 'Solid', rows: [0xff] },
  darkGray: { label: '75% Gray', rows: [0x77, 0xdd] },
  mediumGray: { label: '50% Gray', rows: [0xaa, 0x55] },
  lightGray: { label: '25% Gray', rows: [0x88, 0x22] },
  gray125: { label: '12.5% Gray', rows: [0x88, 0x00, 0x22, 0x00] },
  gray0625: { label: '6.25% Gray', rows: [0x80, 0x00, 0x08, 0x00] },
  darkHorizontal: { label: 'Horizontal Stripe', rows: [0xff, 0xff, 0x00, 0x00] },
  darkVertical: { label: 'Vertical Stripe', rows: [0xcc] },
  darkDown: { label: 'Reverse Diagonal Stripe', rows: [0xcc, 0x66, 0x33, 0x99] },
  darkUp: { label: 'Diagonal Stripe', rows: [0x33, 0x66, 0xcc, 0x99] },
  darkGrid: { label: 'Diagonal Crosshatch', rows: [0xcc, 0xcc, 0x33, 0x33] },
  darkTrellis: { label: 'Thick Diagonal Crosshatch', rows: [0xff, 0x66, 0xff, 0x99] },
  lightHorizontal: { label: 'Thin Horizontal Stripe', rows: [0xff, 0x00, 0x00, 0x00] },
  lightVertical: { label: 'Thin Vertical Stripe', rows: [0x88] },
  lightDown: { label: 'Thin Reverse Diagonal Stripe', rows: [0x88, 0x44, 0x22, 0x11] },
  lightUp: { label: 'Thin Diagonal Stripe', rows: [0x11, 0x22, 0x44, 0x88] },
  lightGrid: { label: 'Thin Horizontal Crosshatch', rows: [0xff, 0x88, 0x88, 0x88] },
  lightTrellis: { label: 'Thin Diagonal Crosshatch', rows: [0x88, 0x55, 0x22, 0x55] },
};

/** The Excel bitmap for `pattern`, or undefined for a drawn pattern. */
export function excelBitmap(pattern: SpanHatch['pattern']): readonly number[] | undefined {
  return (EXCEL_PATTERNS as Record<string, { rows: readonly number[] } | undefined>)[pattern]?.rows;
}

/** Whether pixel (`col`, `row`) of an Excel bitmap is set. */
function excelPixel(rows: readonly number[], col: number, row: number): boolean {
  return (rows[row % rows.length]! & (0x80 >> col)) !== 0;
}

/** CSS `background` for a category's legend swatch (hatch over fill). */
export function spanSwatchCss(def: SeriesDef, style: SpanStyle | undefined): string {
  if (def.renderer === 'vline' || !style) return spanInkColor(def, style);
  const h = style.hatch;
  const fill = style.fill ?? (h ? 'transparent' : spanInkColor(def, style));
  if (!h) return fill;
  const c = h.color ?? DEFAULT_HATCH_COLOR;
  const bitmap = excelBitmap(h.pattern);
  if (bitmap) {
    let d = '';
    for (let r = 0; r < 8; r++) for (let col = 0; col < 8; col++) if (excelPixel(bitmap, col, r)) d += `M${col} ${r}h1v1h-1z`;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" shape-rendering="crispEdges">' +
      `<path fill="${c}" d="${d}"/></svg>`;
    return [`url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / 8px 8px`, fill].join(', ');
  }
  const stripe = (deg: number) =>
    `repeating-linear-gradient(${deg}deg, ${c} 0 1px, transparent 1px 3.5px)`;
  const layers: Record<Exclude<SpanHatch['pattern'], ExcelPattern>, string[]> = {
    diagonal: [stripe(-45)],
    'back-diagonal': [stripe(45)],
    'diagonal-cross': [stripe(45), stripe(-45)],
    horizontal: [stripe(0)],
    vertical: [stripe(90)],
    cross: [stripe(0), stripe(90)],
    dots: [`radial-gradient(circle, ${c} 0.8px, transparent 1.2px) 0 0 / 3.5px 3.5px`],
    checker: [`repeating-conic-gradient(${c} 0 25%, transparent 0 50%) 0 0 / 4px 4px`],
  };
  return [...layers[h.pattern as Exclude<SpanHatch['pattern'], ExcelPattern>], fill].join(', ');
}

const hatchTiles = new Map<string, HTMLCanvasElement>();
const hatchPatterns = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasPattern | null>>();

/** Hatch tile side in device px: the pattern's repeat period. A checker tile is
 *  kept even so its two squares match; an Excel tile is a multiple of 8 so each
 *  bitmap pixel covers whole device pixels. */
export function hatchTileSize(h: SpanHatch, dpr: number): number {
  if (excelBitmap(h.pattern)) return Math.max(8, Math.round(((h.spacingPx ?? 8) * dpr) / 8) * 8);
  const size = Math.max(2, Math.round((h.spacingPx ?? 6) * dpr));
  return h.pattern === 'checker' ? size + (size % 2) : size;
}

/** Repeating hatch pattern for `ctx`, cached per style + devicePixelRatio. */
export function hatchPattern(
  ctx: CanvasRenderingContext2D,
  h: SpanHatch,
  dpr: number,
): CanvasPattern | null {
  const key = `${h.pattern}|${h.color ?? ''}|${h.spacingPx ?? 6}|${h.widthPx ?? 1}|${dpr}`;
  let perCtx = hatchPatterns.get(ctx);
  if (!perCtx) hatchPatterns.set(ctx, (perCtx = new Map()));
  if (perCtx.has(key)) return perCtx.get(key)!;
  let tile = hatchTiles.get(key);
  if (!tile) {
    tile = document.createElement('canvas');
    const size = hatchTileSize(h, dpr);
    tile.width = tile.height = size;
    const c = tile.getContext('2d');
    if (c) paintHatchTile(c, h, size, (h.widthPx ?? 1) * dpr);
    hatchTiles.set(key, tile);
  }
  const pattern = ctx.createPattern(tile, 'repeat');
  perCtx.set(key, pattern);
  return pattern;
}

function paintHatchTile(c: CanvasRenderingContext2D, h: SpanHatch, s: number, lw: number): void {
  c.fillStyle = c.strokeStyle = h.color ?? DEFAULT_HATCH_COLOR;
  const bitmap = excelBitmap(h.pattern);
  if (bitmap) {
    const px = s / 8;
    for (let r = 0; r < 8; r++) for (let col = 0; col < 8; col++) if (excelPixel(bitmap, col, r)) c.fillRect(col * px, r * px, px, px);
    return;
  }
  c.lineWidth = lw;
  const mid = Math.floor((s - lw) / 2);
  // Diagonals repeat at ±s so corner fragments tile seamlessly.
  const diag = (rising: boolean) => {
    c.beginPath();
    for (const k of [-1, 0, 1]) {
      if (rising) {
        c.moveTo(k * s, s);
        c.lineTo((k + 1) * s, 0);
      } else {
        c.moveTo(k * s, 0);
        c.lineTo((k + 1) * s, s);
      }
    }
    c.stroke();
  };
  switch (h.pattern) {
    case 'horizontal':
      c.fillRect(0, mid, s, lw);
      break;
    case 'vertical':
      c.fillRect(mid, 0, lw, s);
      break;
    case 'cross':
      c.fillRect(0, mid, s, lw);
      c.fillRect(mid, 0, lw, s);
      break;
    case 'diagonal':
      diag(true);
      break;
    case 'back-diagonal':
      diag(false);
      break;
    case 'diagonal-cross':
      diag(true);
      diag(false);
      break;
    case 'dots':
      c.beginPath();
      c.arc(s / 2, s / 2, Math.max(0.5, lw), 0, Math.PI * 2);
      c.fill();
      break;
    case 'checker':
      c.fillRect(0, 0, s / 2, s / 2);
      c.fillRect(s / 2, s / 2, s / 2, s / 2);
      break;
  }
}

// ---------------------------------------------------------------- drawing

/** Font for span labels (CSS px, CSS weight, CSS family). */
export interface LabelFont {
  sizePx: number;
  weight: string;
  family: string;
}

/** The legend strip's own font: the label default when its computed style is unavailable. */
export const DEFAULT_LABEL_FONT: LabelFont = { sizePx: 12, weight: '400', family: 'system-ui, sans-serif' };

export interface SpanLayerOptions {
  /** Span series drawn in this pane. */
  defs: SeriesDef[];
  /** Default label font (the legend entries'); DEFAULT_LABEL_FONT when absent. */
  labelFont?: () => LabelFont;
  store(key: string): SeriesStore | undefined;
  visible(def: SeriesDef, cat: number): boolean;
  /** Whether this pane draws the series' static category labels. */
  labelsHere(def: SeriesDef): boolean;
}

/** Draws a pane's vrect/vline series: 'below' after grid/axes, 'above' last. */
export function spansPlugin(o: SpanLayerOptions): uPlot.Plugin {
  return {
    hooks: {
      drawAxes: (u: uPlot) => drawSpanLayer(u, o, 'below'),
      draw: (u: uPlot) => drawSpanLayer(u, o, 'above'),
    },
  };
}

function drawSpanLayer(u: uPlot, o: SpanLayerOptions, layer: 'below' | 'above'): void {
  const defs = o.defs.filter((d) => (d.layer ?? 'below') === layer);
  if (defs.length === 0) return;
  const xMin = u.scales['x']?.min;
  const xMax = u.scales['x']?.max;
  if (xMin == null || xMax == null) return;
  const dpr = window.devicePixelRatio || 1;
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  for (const def of defs) {
    const store = o.store(def.key);
    if (!store || store.length === 0) continue;
    if (def.renderer === 'vrect') drawRects(u, o, def, store, xMin, xMax, dpr);
    else drawLines(u, o, def, store, xMin, xMax, dpr);
  }
  ctx.restore();
}

function drawRects(
  u: uPlot,
  o: SpanLayerOptions,
  def: SeriesDef,
  store: SeriesStore,
  xMin: number,
  xMax: number,
  dpr: number,
): void {
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  const toPx = (t: number) => u.valToPos(t, 'x', true);
  const spans = spansInRange(store, def, xMin, xMax).filter((s) => o.visible(def, s.cat));
  const merged = coalesceSpans(spans, toPx, (def.minWidthPx ?? 1) * dpr, SEAM_PX * dpr);
  const labels = o.labelsHere(def);
  for (const s of merged) {
    const style = def.categories?.[s.cat];
    const x0 = Math.round(Math.max(left - 1, toPx(s.start)));
    const x1 = Math.round(Math.min(left + width + 1, toPx(s.end)));
    const w = Math.max(1, x1 - x0);
    const fill = style ? style.fill : def.color;
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(x0, top, w, height);
    }
    if (style?.hatch) {
      const pattern = hatchPattern(ctx, style.hatch, dpr);
      if (pattern) {
        // Anchor the hatch to time so it pans with the data.
        const pitch = hatchTileSize(style.hatch, dpr);
        const ox = ((toPx(0) % pitch) + pitch) % pitch;
        if (typeof DOMMatrix !== 'undefined') pattern.setTransform(new DOMMatrix([1, 0, 0, 1, ox, top]));
        ctx.fillStyle = pattern;
        ctx.fillRect(x0, top, w, height);
      }
    }
    const edge = style?.edge;
    if (edge) {
      const sides = edge.sides ?? 'both';
      if (sides !== 'end' && s.start >= xMin) strokeVLine(ctx, toPx(s.start), top, height, edge, dpr);
      if (sides !== 'start' && s.end <= xMax) strokeVLine(ctx, toPx(s.end), top, height, edge, dpr);
    }
    if (labels && style?.label) {
      drawSpanLabel(ctx, style.label, x0, x0 + w, top, height, spanInkColor(def, style), dpr, false, o.labelFont?.());
    }
  }
}

function drawLines(
  u: uPlot,
  o: SpanLayerOptions,
  def: SeriesDef,
  store: SeriesStore,
  xMin: number,
  xMax: number,
  dpr: number,
): void {
  const ctx = u.ctx;
  const { top, height } = u.bbox;
  const labels = o.labelsHere(def);
  let lastPx = -Infinity;
  let lastCat = -1;
  for (const l of linesInRange(store, def, xMin, xMax)) {
    if (!o.visible(def, l.cat)) continue;
    const x = u.valToPos(l.t, 'x', true);
    if (l.cat === lastCat && x - lastPx < dpr) continue; // same pixel, same style
    lastPx = x;
    lastCat = l.cat;
    const style = def.categories?.[l.cat];
    const edge = {
      color: style?.edge?.color ?? style?.fill ?? def.color,
      widthPx: style?.edge?.widthPx ?? def.lineWidthPx ?? 1,
      dash: style?.edge?.dash,
    };
    strokeVLine(ctx, x, top, height, edge, dpr);
    if (labels && style?.label) {
      drawSpanLabel(ctx, style.label, x, x, top, height, edge.color, dpr, true, o.labelFont?.());
    }
  }
}

function strokeVLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  height: number,
  edge: { color: string; widthPx?: number; dash?: number[] },
  dpr: number,
): void {
  const lw = (edge.widthPx ?? 1) * dpr;
  if (!(lw > 0)) return;
  const xx = Math.round(x) + (Math.round(lw) % 2 ? 0.5 : 0);
  ctx.strokeStyle = edge.color;
  ctx.lineWidth = lw;
  ctx.setLineDash(edge.dash?.map((d) => d * dpr) ?? []);
  ctx.beginPath();
  ctx.moveTo(xx, top);
  ctx.lineTo(xx, top + height);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawSpanLabel(
  ctx: CanvasRenderingContext2D,
  label: NonNullable<SpanStyle['label']>,
  x0: number,
  x1: number,
  top: number,
  height: number,
  color: string,
  dpr: number,
  isLine: boolean,
  font: LabelFont = DEFAULT_LABEL_FONT,
): void {
  const pad = 3 * dpr;
  const lines = label.text.split('\n');
  const widest = (px: number) => {
    ctx.font = `${label.fontWeight ?? font.weight} ${Math.round(px * dpr)}px ${font.family}`;
    return Math.max(...lines.map((l) => ctx.measureText(l).width));
  };
  let sizePx = label.fontSizePx ?? font.sizePx;
  const tw = widest(sizePx);
  const room = x1 - x0 - 2 * pad;
  if (!isLine && tw > room) {
    // Shrink to fit (width scales with size), stepping down past hinting overshoot; hide below the floor.
    const minPx = Math.min(sizePx, label.minFontSizePx ?? 10);
    let fit = Math.floor(((sizePx * room) / tw) * 2) / 2;
    while (fit >= minPx && widest(fit) > room) fit -= 0.5;
    if (fit < minPx) return;
    sizePx = fit;
  }
  const lineH = Math.round(sizePx * 1.2 * dpr);
  const pos = label.position ?? 'top-left';
  ctx.fillStyle = label.color ?? color;
  ctx.textBaseline = pos === 'inside' ? 'middle' : 'top';
  // Stack lines down from the top, or centre the block for 'inside'.
  const y0 = pos === 'inside' ? top + height / 2 - ((lines.length - 1) * lineH) / 2 : top + pad;
  const left = pos === 'top-left' || (isLine && pos === 'inside');
  ctx.textAlign = left ? 'left' : 'center';
  const x = left ? x0 + pad : (x0 + x1) / 2;
  const halo = label.halo;
  if (halo) {
    // A stroke is centred on the glyph outline; the fill covers its inner half.
    ctx.strokeStyle = halo.color;
    ctx.lineWidth = 2 * (halo.widthPx ?? 1) * dpr;
    ctx.lineJoin = 'round';
    lines.forEach((line, k) => ctx.strokeText(line, x, y0 + k * lineH));
  }
  lines.forEach((line, k) => ctx.fillText(line, x, y0 + k * lineH));
}
