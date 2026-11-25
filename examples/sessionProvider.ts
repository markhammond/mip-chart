// Synthetic equity-session provider for the spans example: 5m bars during a
// 14:30–21:00 UTC regular session on trading days only, plus span series —
// session calendar (closed days / overnight), earnings pre/post windows, and
// filing/release event lines. Spans are returned whenever they OVERLAP the
// requested range, per the vrect/vline contract.

import type { NavigationRequest, SeriesFragment, TimeRange } from '../src/index';

export const BAR_MS = 5 * 60 * 1000;
const DAY = 86_400_000;
const OPEN_MS = (14 * 60 + 30) * 60_000;
const CLOSE_MS = 21 * 3_600_000;
const FIRST_DAY = Date.UTC(2023, 0, 2);
const LAST_DAY = Date.UTC(2024, 11, 31);
const HOLIDAYS = new Set(
  ['2023-01-16', '2023-04-07', '2023-07-04', '2023-11-23', '2023-12-25',
    '2024-01-01', '2024-03-29', '2024-07-04', '2024-11-28', '2024-12-25']
    .map((d) => Date.parse(d + 'T00:00:00Z')),
);
export const STATE_NAMES = ['Undefined', 'Bear', 'Flat', 'Bull'];

const isTradingDay = (day: number) => {
  const wd = new Date(day).getUTCDay();
  return wd !== 0 && wd !== 6 && !HOLIDAYS.has(day);
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------- bars

const tradingDays: number[] = [];
for (let d = FIRST_DAY; d <= LAST_DAY; d += DAY) if (isTradingDay(d)) tradingDays.push(d);

const T: number[] = [];
for (const d of tradingDays) for (let t = d + OPEN_MS; t < d + CLOSE_MS; t += BAR_MS) T.push(t);
const N = T.length;
const O = new Float64Array(N);
const H = new Float64Array(N);
const L = new Float64Array(N);
const C = new Float64Array(N);
const MOM = new Float64Array(N);
const ENV = new Float64Array(N);
const REGIME = new Float64Array(N);
const STATE = new Int8Array(N);
{
  const rng = mulberry32(0x5e55);
  let v = 180;
  let ema = v;
  let dev = 0.5;
  let slow = 0;
  for (let i = 0; i < N; i++) {
    // Overnight gap at each session open.
    const open = i > 0 && T[i]! - T[i - 1]! > BAR_MS ? v * (1 + (rng() - 0.5) * 0.03) : v;
    v = open * (1 + (rng() - 0.5) * 0.004 + Math.sin(i / 2500) * 0.0002);
    O[i] = open;
    C[i] = v;
    const wig = v * 0.0015 * (0.4 + rng());
    H[i] = Math.max(open, v) + wig;
    L[i] = Math.min(open, v) - wig;
    ema += (v - ema) * (2 / 41);
    MOM[i] = ((v - ema) / ema) * 100;
    dev += (Math.abs(MOM[i]!) - dev) * (2 / 101);
    ENV[i] = 2 * dev;
    slow += (MOM[i]! - slow) * (2 / 401);
    REGIME[i] = Math.round(slow * 8) / 8;
    STATE[i] = rng() < 0.001 ? 0 : MOM[i]! > 0.15 ? 3 : MOM[i]! < -0.15 ? 1 : 2;
  }
}

export const EXTENT: TimeRange = { from: T[0]!, to: T[N - 1]! + BAR_MS };

// ------------------------------------------------------------- spans

interface SpanRow { start: number; end: number; cat: number }

/** Session calendar: non-trading calendar days → 0 'Closed', the rest of
 *  every between-session gap → 1 'Overnight'. */
const sessionSpans: SpanRow[] = [];
for (let k = 1; k < tradingDays.length; k++) {
  let cur = tradingDays[k - 1]! + CLOSE_MS;
  const next = tradingDays[k]! + OPEN_MS;
  while (cur < next) {
    const day = Math.floor(cur / DAY) * DAY;
    const segEnd = Math.min(day + DAY, next);
    const cat = isTradingDay(day) ? 1 : 0;
    const last = sessionSpans[sessionSpans.length - 1];
    if (last && last.cat === cat && last.end === cur) last.end = segEnd;
    else sessionSpans.push({ start: cur, end: segEnd, cat });
    cur = segEnd;
  }
}

/** Earnings after the close on the first trading day ≥ the 25th of Jan/Apr/Jul/Oct. */
const earningsDays: number[] = [];
for (const y of [2023, 2024])
  for (const m of [0, 3, 6, 9]) {
    let d = Date.UTC(y, m, 25);
    while (!isTradingDay(d)) d += DAY;
    earningsDays.push(d);
  }
export const LAST_EARNINGS = earningsDays[earningsDays.length - 1]!;

const earningsSpans: SpanRow[] = earningsDays.flatMap((d) => [
  { start: d - 7 * DAY + OPEN_MS, end: d + CLOSE_MS, cat: 0 }, // pre-window
  { start: d + CLOSE_MS, end: d + 3 * DAY + CLOSE_MS, cat: 1 }, // post-window
]);

/** Event lines: 0 = 8-K filing (red dashed), 1 = inferred release minute (green). */
const eventLines: Array<{ t: number; cat: number }> = [];
{
  const rng = mulberry32(0xf111);
  for (const d of earningsDays) {
    eventLines.push({ t: d + CLOSE_MS + 5 * 60_000, cat: 1 });
    eventLines.push({ t: d + CLOSE_MS + 25 * 60_000, cat: 0 });
  }
  for (const d of tradingDays)
    if (rng() < 0.04) eventLines.push({ t: d + OPEN_MS + Math.floor(rng() * 78) * BAR_MS, cat: 0 });
  eventLines.sort((a, b) => a.t - b.t);
}

export const FILING_TEXT = (x: number) =>
  earningsDays.some((d) => x - d - CLOSE_MS < DAY && x > d)
    ? 'Form 8-K · Item 2.02 Results of Operations'
    : 'Form 8-K · Item 8.01 Other Events';

// ------------------------------------------------------------- sampling

const lowerBound = (xs: ArrayLike<number>, t: number) => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

function ohlc(i0: number, i1: number, stride: number) {
  const xs: number[] = [];
  const o: number[] = [];
  const h: number[] = [];
  const l: number[] = [];
  const c: number[] = [];
  for (let b = i0; b < i1; b += stride) {
    const e = Math.min(b + stride, i1);
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = b; i < e; i++) {
      hi = Math.max(hi, H[i]!);
      lo = Math.min(lo, L[i]!);
    }
    xs.push(T[b]!);
    o.push(O[b]!);
    h.push(hi);
    l.push(lo);
    c.push(C[e - 1]!);
  }
  return { xs, columns: { open: o, high: h, low: l, close: c } };
}

/** Bucket means of several aligned arrays. */
function means(i0: number, i1: number, stride: number, cols: Record<string, (i: number) => number>) {
  const xs: number[] = [];
  const out: Record<string, number[]> = {};
  for (const k of Object.keys(cols)) out[k] = [];
  for (let b = i0; b < i1; b += stride) {
    const e = Math.min(b + stride, i1);
    xs.push(T[b]!);
    for (const [k, f] of Object.entries(cols)) {
      let s = 0;
      for (let i = b; i < e; i++) s += f(i);
      out[k]!.push(s / (e - b));
    }
  }
  return { xs, columns: out };
}

/** Transition-preserving reduction (every change + bucket anchors). */
function transitions(i0: number, i1: number, stride: number, f: (i: number) => number) {
  const xs: number[] = [];
  const ys: number[] = [];
  let last = NaN;
  for (let i = i0; i < i1; i++) {
    const v = f(i);
    if (v !== last || (i - i0) % stride === 0) {
      xs.push(T[i]!);
      ys.push(v);
    }
    last = v;
  }
  return { xs, ys };
}

function spansOverlapping(rows: SpanRow[], r: TimeRange) {
  const hit = rows.filter((s) => s.end > r.from && s.start < r.to);
  return { xs: hit.map((s) => s.start), columns: { end: hit.map((s) => s.end), category: hit.map((s) => s.cat) } };
}

// ------------------------------------------------------------- provider

export class SessionProvider {
  latency: [number, number] = [20, 160];
  private readonly jitter = mulberry32(0xd1ce);

  constructor(private readonly deliver: (f: SeriesFragment) => void) {}

  serve(req: NavigationRequest): void {
    const v0 = lowerBound(T, req.visible.from);
    const v1 = Math.max(v0 + 1, lowerBound(T, req.visible.to));
    const stride = Math.max(1, Math.ceil((v1 - v0) / req.maxPointsPerSeries));
    let pMin = Infinity;
    let pMax = -Infinity;
    let mMin = Infinity;
    let mMax = -Infinity;
    for (let i = v0; i < Math.min(v1, N); i++) {
      pMin = Math.min(pMin, L[i]!);
      pMax = Math.max(pMax, H[i]!);
      mMin = Math.min(mMin, MOM[i]!, -ENV[i]!);
      mMax = Math.max(mMax, MOM[i]!, ENV[i]!);
    }
    const fragments: SeriesFragment[] = [];
    for (const r of req.fetchRanges) {
      const i0 = lowerBound(T, r.from);
      const i1 = lowerBound(T, r.to);
      const base = {
        laneId: req.laneId,
        sampleIntervalMs: req.sampleIntervalMs,
        phaseId: req.phaseId,
        fragmentCount: 0,
        range: r,
      };
      const bars = ohlc(i0, i1, stride);
      const m = means(i0, i1, stride, {
        vwap: (i) => (H[i]! + L[i]! + C[i]!) / 3,
        mom: (i) => MOM[i]!,
        upper: (i) => ENV[i]!,
        lower: (i) => -ENV[i]!,
      });
      const reg = transitions(i0, i1, stride, (i) => REGIME[i]!);
      const st = transitions(i0, i1, stride, (i) => STATE[i]!);
      const ev = eventLines.filter((e) => e.t >= r.from && e.t < r.to);
      const price = pMin <= pMax ? { min: pMin, max: pMax } : null;
      const osc = mMin <= mMax ? { min: mMin, max: mMax } : null;
      fragments.push(
        { ...base, seriesKey: 'candles', ...bars, trueExtrema: price, trueBaseline: C[v0] ?? null },
        { ...base, seriesKey: 'vwap', xs: m.xs, columns: { value: m.columns['vwap']! }, trueExtrema: price },
        { ...base, seriesKey: 'env', xs: m.xs, columns: { upper: m.columns['upper']!, lower: m.columns['lower']! }, trueExtrema: osc },
        { ...base, seriesKey: 'mom', xs: m.xs, columns: { value: m.columns['mom']! }, trueExtrema: osc },
        { ...base, seriesKey: 'regime', xs: reg.xs, columns: { value: reg.ys } },
        { ...base, seriesKey: 'states', xs: st.xs, columns: { value: st.ys.map((s) => (s > 0 ? s : null)) } },
        { ...base, seriesKey: 'sessions', ...spansOverlapping(sessionSpans, r) },
        { ...base, seriesKey: 'earnings', ...spansOverlapping(earningsSpans, r) },
        { ...base, seriesKey: 'events', xs: ev.map((e) => e.t), columns: { category: ev.map((e) => e.cat) } },
      );
    }
    for (const f of fragments) f.fragmentCount = fragments.length;
    for (const f of fragments) {
      const ms = this.latency[0] + this.jitter() * (this.latency[1] - this.latency[0]);
      setTimeout(() => this.deliver(f), ms);
    }
  }

  serveOverview(maxPoints: number, deliver: (xs: number[], ys: Array<number | null>) => void): void {
    const stride = Math.max(1, Math.ceil(N / maxPoints));
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < N; i += stride) {
      xs.push(T[i]!);
      ys.push(C[i]!);
    }
    setTimeout(() => deliver(xs, ys), 200);
  }
}
