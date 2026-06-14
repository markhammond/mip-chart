// Axis split (tick position) computation — pure, unit-tested.
// Replaces uPlot's defaults where they fall short:
//   - log scales: default splits anchor at scale.min + power steps → ugly
//   - % mode: ticks must be "nice" in percent space, not native units

/** "Nice" tick step via Heckbert rounding (1/2/5/10 ladder). */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = (raw / mag) * (1 + 1e-12); // tolerate float dust at thresholds
  const factor = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return factor * mag;
}

/** Nice linear splits covering [min, max], ≤ ~targetTicks of them. */
export function niceLinearSplits(min: number, max: number, targetTicks = 6): number[] {
  if (!(max > min)) return [min];
  const step = niceStep((max - min) / Math.max(targetTicks - 1, 1));
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) {
    out.push(roundTo(v, step));
  }
  return out;
}

/**
 * Nice log splits covering [min, max] (both > 0): decade marks, subdivided
 * 1-2-5 within a decade when the range spans few decades.
 */
export function niceLogSplits(min: number, max: number, targetTicks = 6): number[] {
  if (!(min > 0) || !(max > min)) return [min];
  const lmin = Math.log10(min);
  const lmax = Math.log10(max);
  const decades = lmax - lmin;

  if (decades >= targetTicks) {
    // one tick per N decades
    const stepDec = Math.ceil(decades / targetTicks);
    const out: number[] = [];
    for (let d = Math.ceil(lmin); d <= lmax; d += stepDec) out.push(Math.pow(10, d));
    return out.length ? out : [min, max];
  }
  if (decades >= 1.3) {
    // decade marks + 2/5 subdivisions
    const out: number[] = [];
    for (let d = Math.floor(lmin); d <= Math.ceil(lmax); d++) {
      for (const m of [1, 2, 5]) {
        const v = m * Math.pow(10, d);
        if (v >= min && v <= max) out.push(v);
      }
    }
    return out.length ? out : [min, max];
  }
  // sub-decade span: linear steps read better
  return niceLinearSplits(min, max, targetTicks);
}

/**
 * Nice splits for percentage mode: positions chosen in PERCENT space
 * (vs `origin`), returned in NATIVE units for the engine. Composes with log
 * scale — ticks are nice percents either way; spacing on a log axis is
 * naturally compressed upward, matching the TradingView convention.
 */
export function nicePercentSplits(
  origin: number,
  min: number,
  max: number,
  targetTicks = 6,
): number[] {
  if (!origin || !(max > min)) return [min];
  const pmin = (min / origin - 1) * 100;
  const pmax = (max / origin - 1) * 100;
  return niceLinearSplits(pmin, pmax, targetTicks).map((p) => origin * (1 + p / 100));
}

function roundTo(v: number, step: number): number {
  // Kill float drift so labels render clean (e.g. 0.30000000000000004).
  const dec = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(Math.min(dec, 12)));
}

// ---------------------------------------------------------------------------
// TradingView lightweight-charts price-scale heuristic:
// PriceTickMarkBuilder + PriceTickSpanCalculator, ported.
//
//  - tick density: markHeight = ceil(fontPx × density), density default 2.5;
//    maxTickSpan = span × markHeight / paneHeightPx
//  - step ladder: three span calculators with divider cycles [2,2.5,2] /
//    [2,2,2.5] / [2.5,2,2], minimum wins ⇒ smallest member of
//    {1, 2, 2.5, 4, 5}×10^k that is ≥ maxTickSpan
//  - marks walk DOWN from high − (high mod span)
//  - log scales recompute the span each iteration from the LOCAL pixel
//    density, so labels stay nice price values with ≥ markHeight spacing
// ---------------------------------------------------------------------------

export const TV_TICK_DENSITY = 2.5;

const TV_LADDER = [1, 2, 2.5, 4, 5];

/** Smallest {1,2,2.5,4,5}×10^k ≥ raw (the union of TVLC's three cyclic
 *  divider ladders). */
export function tvLadderCeil(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const exp = Math.floor(Math.log10(raw));
  for (let k = exp; ; k++) {
    const mag = Math.pow(10, k);
    for (const m of TV_LADDER) {
      const v = m * mag;
      if (v >= raw * (1 - 1e-14)) return v;
    }
  }
}

export interface TvTickOptions {
  heightPx: number;
  fontPx: number;
  density?: number; // lightweight-charts tickMarkDensity (default 2.5)
}

/** Linear-scale tick values per the lightweight-charts builder. */
export function tvLinearTicks(lo: number, hi: number, o: TvTickOptions): number[] {
  if (!(hi > lo) || !(o.heightPx > 0)) return [lo];
  const markHeight = Math.ceil(o.fontPx * (o.density ?? TV_TICK_DENSITY));
  const span = tvLadderCeil(((hi - lo) * markHeight) / o.heightPx);
  const out: number[] = [];
  for (let v = Math.floor(hi / span) * span; v >= lo - span * 1e-14; v -= span) {
    out.unshift(roundTo(v, span));
  }
  return out.filter((v) => v >= lo - Math.abs(lo) * 1e-12);
}

/**
 * Log-scale tick values per the lightweight-charts builder: walk down from
 * the top, recomputing the step from the LOCAL pixel density at each level —
 * labels remain nice price values; pixel spacing stays ≥ markHeight.
 */
export function tvLogTicks(lo: number, hi: number, o: TvTickOptions): number[] {
  if (!(lo > 0) || !(hi > lo) || !(o.heightPx > 0)) return [Math.max(lo, 1e-12)];
  const markHeight = Math.ceil(o.fontPx * (o.density ?? TV_TICK_DENSITY));
  const pxPerLog = o.heightPx / (Math.log10(hi) - Math.log10(lo));
  // Over a small (near-linear) span, the per-level walk picks different ladder
  // steps at different heights → uneven gaps and odd labels. Use one step,
  // sized at the top (worst log compression, so nothing crowds), to keep labels
  // round and evenly spaced. Past ~½ a decade, fall back to the per-level walk.
  if (Math.log10(hi) - Math.log10(lo) < 0.5) {
    const span = tvLadderCeil((markHeight * hi * Math.LN10) / pxPerLog);
    const flat: number[] = [];
    for (let m = Math.floor(hi / span) * span; m >= lo - span * 1e-14; m -= span) {
      if (m >= lo) flat.unshift(roundTo(m, span));
    }
    if (flat.length >= 2) return flat;
  }
  const out: number[] = [];
  let v = hi;
  for (let guard = 0; guard < 200 && v >= lo; guard++) {
    // local price-per-pixel at level v on a log axis: v·ln10 / pxPerLog
    const localSpan = tvLadderCeil((markHeight * v * Math.LN10) / pxPerLog);
    const mark = Math.floor(v / localSpan) * localSpan;
    if (mark < lo) break;
    if (out.length === 0 || mark < out[0]!) out.unshift(roundTo(mark, localSpan));
    v = mark - localSpan;
  }
  return out.length ? out : [lo];
}

/** Percent-mode ticks: the TV ladder applied in percent-from-origin space,
 *  returned in native units for the engine. */
export function tvPercentTicks(
  origin: number,
  lo: number,
  hi: number,
  o: TvTickOptions,
): number[] {
  if (!origin || !(hi > lo)) return [lo];
  const plo = (lo / origin - 1) * 100;
  const phi = (hi / origin - 1) * 100;
  return tvLinearTicks(plo, phi, o).map((p) => origin * (1 + p / 100));
}
