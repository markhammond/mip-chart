// Synthetic (range, density) data provider for the live example.
// Simulates the server side: deterministic OHLC random walk, per-series-type
// downsampling (OHLC-aggregate / LTTB / transition-preserving), true in-view
// extrema + left-edge baseline, parallel out-of-order fragment delivery with
// latency jitter.

import type { NavigationRequest, SeriesFragment, TimeRange } from '../src/index';

export const BAR_MS = 30 * 60 * 1000; // 30m bars
const START = Date.UTC(2018, 0, 1);
const BAR_COUNT = 4 * 365 * 48; // ~4 years

// ----------------------------------------------------------- deterministic data

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0xc0ffee);
const closes = new Float64Array(BAR_COUNT);
const highs = new Float64Array(BAR_COUNT);
const lows = new Float64Array(BAR_COUNT);
const emaFast = new Float64Array(BAR_COUNT);
const emaSlow = new Float64Array(BAR_COUNT);
const stateVals = new Int8Array(BAR_COUNT);

{
  let v = 30_000;
  let ef = v;
  let es = v;
  for (let i = 0; i < BAR_COUNT; i++) {
    const drift = Math.sin(i / 4000) * 0.0008;
    v *= 1 + drift + (rng() - 0.5) * 0.012;
    v = Math.max(v, 100);
    closes[i] = v;
    const wig = v * 0.004 * (0.5 + rng());
    highs[i] = Math.max(v, i ? closes[i - 1]! : v) + wig;
    lows[i] = Math.min(v, i ? closes[i - 1]! : v) - wig;
    ef += (v - ef) * (2 / (20 + 1));
    es += (v - es) * (2 / (96 + 1));
    emaFast[i] = ef;
    emaSlow[i] = es;
    // 0 = reserved Undefined (rare); else Bear/Flat/Bull from ema relation
    stateVals[i] =
      rng() < 0.002 ? 0 : ef > es * 1.002 ? 3 : ef < es * 0.998 ? 1 : 2;
  }
}

export const EXTENT: TimeRange = { from: START, to: START + BAR_COUNT * BAR_MS };
export const STATE_NAMES = ['Undefined', 'Bear', 'Flat', 'Bull'];

const barAt = (t: number) => Math.min(Math.max(Math.floor((t - START) / BAR_MS), 0), BAR_COUNT - 1);
const open = (i: number) => (i > 0 ? closes[i - 1]! : closes[0]!);
const vwap = (i: number) => (highs[i]! + lows[i]! + closes[i]!) / 3;

// ------------------------------------------------------------- downsampling

/** OHLC time-bucket aggregation (never LTTB). */
function sampleOhlc(i0: number, i1: number, stride: number) {
  const xs: number[] = [];
  const o: (number | null)[] = [];
  const h: (number | null)[] = [];
  const l: (number | null)[] = [];
  const c: (number | null)[] = [];
  for (let b = i0; b < i1; b += stride) {
    const e = Math.min(b + stride, i1);
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = b; i < e; i++) {
      if (highs[i]! > hi) hi = highs[i]!;
      if (lows[i]! < lo) lo = lows[i]!;
    }
    xs.push(START + b * BAR_MS);
    o.push(open(b));
    h.push(hi);
    l.push(lo);
    c.push(closes[e - 1]!);
  }
  return { xs, columns: { open: o, high: h, low: l, close: c } };
}

/** LTTB for line series. */
function lttb(i0: number, i1: number, budget: number, val: (i: number) => number) {
  const n = i1 - i0;
  const xs: number[] = [];
  const ys: (number | null)[] = [];
  const push = (i: number) => {
    xs.push(START + i * BAR_MS);
    ys.push(val(i));
  };
  if (n <= budget) {
    for (let i = i0; i < i1; i++) push(i);
    return { xs, ys };
  }
  push(i0);
  const bucketSize = (n - 2) / (budget - 2);
  let a = i0;
  for (let b = 0; b < budget - 2; b++) {
    const rs = i0 + 1 + Math.floor(b * bucketSize);
    const re = Math.min(i0 + 1 + Math.floor((b + 1) * bucketSize), i1 - 1);
    // average of next bucket
    const ns = re;
    const ne = Math.min(i0 + 1 + Math.floor((b + 2) * bucketSize), i1);
    let avgX = 0;
    let avgY = 0;
    const cnt = Math.max(ne - ns, 1);
    for (let i = ns; i < ne; i++) {
      avgX += i;
      avgY += val(i);
    }
    avgX /= cnt;
    avgY /= cnt;
    let best = rs;
    let bestArea = -1;
    for (let i = rs; i < re; i++) {
      const area = Math.abs((a - avgX) * (val(i) - val(a)) - (a - i) * (avgY - val(a)));
      if (area > bestArea) {
        bestArea = area;
        best = i;
      }
    }
    push(best);
    a = best;
  }
  push(i1 - 1);
  return { xs, ys };
}

/** Transition-preserving categorical reduction. */
function sampleStates(i0: number, i1: number, stride: number) {
  const xs: number[] = [];
  const valid: (number | null)[] = [];
  const invalid: (number | null)[] = [];
  const push = (i: number) => {
    xs.push(START + i * BAR_MS);
    const f = stateVals[i]!;
    valid.push(f > 0 ? f : null);
    invalid.push(f === 0 ? 0 : null);
  };
  let last = -2;
  for (let i = i0; i < i1; i++) {
    const f = stateVals[i]!;
    if (f !== last || (i - i0) % stride === 0) push(i); // every transition + bucket anchor
    last = f;
  }
  return { xs, valid, invalid };
}

// ---------------------------------------------------------------- provider

export interface ProviderStats {
  requests: number;
  fragments: number;
  barsServed: number;
}

export class SyntheticProvider {
  stats: ProviderStats = { requests: 0, fragments: 0, barsServed: 0 };
  /** Simulated network latency bounds (ms). */
  latency: [number, number] = [30, 250];

  constructor(
    private readonly deliver: (f: SeriesFragment) => void,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  serve(req: NavigationRequest): void {
    this.stats.requests++;
    const ranges = req.fetchRanges.length
      ? req.fetchRanges
      : [req.visible]; // density-only refresh
    const visSpanBars = Math.max(1, Math.round((req.visible.to - req.visible.from) / BAR_MS));
    const stride = Math.max(1, Math.ceil(visSpanBars / req.maxPointsPerSeries));

    // True in-view (full-resolution) extrema + left-edge baseline.
    const v0 = barAt(req.visible.from);
    const v1 = Math.max(v0 + 1, barAt(req.visible.to));
    let priceMin = Infinity;
    let priceMax = -Infinity;
    let oscMin = Infinity;
    let oscMax = -Infinity;
    for (let i = v0; i < v1; i++) {
      if (highs[i]! > priceMax) priceMax = highs[i]!;
      if (lows[i]! < priceMin) priceMin = lows[i]!;
      const f = emaFast[i]!;
      const s = emaSlow[i]!;
      if (Math.min(f, s) < oscMin) oscMin = Math.min(f, s);
      if (Math.max(f, s) > oscMax) oscMax = Math.max(f, s);
    }
    const baseline = closes[v0]!; // % origin anchors to the left-edge close

    // 5 series fragments per range: candles, vwap, emaFast, emaSlow, states(2 cols).
    const fragments: SeriesFragment[] = [];
    for (const r of ranges) {
      const i0 = barAt(r.from);
      const i1 = Math.max(i0 + 1, Math.min(barAt(r.to) + 1, BAR_COUNT));
      this.stats.barsServed += i1 - i0;

      const ohlc = sampleOhlc(i0, i1, stride);
      const vw = lttb(i0, i1, Math.ceil((i1 - i0) / stride), vwap);
      const ef = lttb(i0, i1, Math.ceil((i1 - i0) / stride), (i) => emaFast[i]!);
      const es = lttb(i0, i1, Math.ceil((i1 - i0) / stride), (i) => emaSlow[i]!);
      const st = sampleStates(i0, i1, stride);

      const base = {
        phaseId: req.phaseId,
        fragmentCount: 0, // patched below
        range: r,
      };
      fragments.push(
        { ...base, seriesKey: 'candles', xs: ohlc.xs, columns: ohlc.columns, trueExtrema: { min: priceMin, max: priceMax }, trueBaseline: baseline },
        { ...base, seriesKey: 'vwap', xs: vw.xs, columns: { value: vw.ys }, trueExtrema: { min: priceMin, max: priceMax } },
        { ...base, seriesKey: 'emaFast', xs: ef.xs, columns: { value: ef.ys }, trueExtrema: { min: oscMin, max: oscMax } },
        { ...base, seriesKey: 'emaSlow', xs: es.xs, columns: { value: es.ys }, trueExtrema: { min: oscMin, max: oscMax } },
        { ...base, seriesKey: 'states', xs: st.xs, columns: { valid: st.valid } },
        { ...base, seriesKey: 'states-invalid', xs: st.xs, columns: { invalid: st.invalid } },
      );
    }
    for (const f of fragments) f.fragmentCount = fragments.length;

    // Deliver shuffled with latency jitter — exercises the out-of-order barrier.
    const shuffled = [...fragments].sort(() => rngDelivery() - 0.5);
    for (const f of shuffled) {
      const ms = this.latency[0] + rngDelivery() * (this.latency[1] - this.latency[0]);
      setTimeout(() => {
        this.stats.fragments++;
        this.deliver(f);
      }, ms);
    }
    this.log(
      `phase ${req.phaseId}: ${ranges.length} range(s), stride ${stride}, ${fragments.length} fragments`,
    );
  }

  /** Full-extent overview series for the minimap. */
  serveOverview(maxPoints: number, deliver: (xs: number[], values: Array<number | null>) => void): void {
    const sampled = lttb(0, BAR_COUNT, Math.min(maxPoints, BAR_COUNT), (i) => closes[i]!);
    // Simulate the slower full-extent aggregation (progressive refinement).
    setTimeout(() => {
      this.log(`overview: ${sampled.xs.length} points over full extent`);
      deliver(sampled.xs, sampled.ys);
    }, 400);
  }
}

// Delivery jitter is intentionally non-deterministic (it simulates the
// network); the *commit* stays deterministic via the phase barrier.
const rngDelivery = mulberry32(0xdecade);
