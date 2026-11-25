// Shape-preserving cubic line paths — PCHIP (Piecewise Cubic Hermite
// Interpolating Polynomial). Never overshoots the data (unlike Catmull-Rom), so
// no false extrema on financial series. Interpolates in pixel space (valToPos
// per point), correct on log scales. Nulls on the unified timeline are spanned;
// optional breaks split the curve into independent runs.
//
// Interior tangent is the Fritsch–Butland weighted harmonic mean (identical to
// d3 curveMonotoneX). PCHIP's refinement is the ENDPOINTS: a shape-limited
// non-centered three-point derivative instead of the boundary secant — more
// natural edge curvature without overshoot.

import type uPlot from 'uplot';

/**
 * PCHIP endpoint derivative (Fritsch): a non-centered three-point estimate
 * clamped to preserve shape. `hA/sA` are the interval width & secant slope
 * touching the endpoint; `hB/sB` are the next ones inward.
 */
export function pchipEndpointSlope(hA: number, hB: number, sA: number, sB: number): number {
  const d = ((2 * hA + hB) * sA - hA * sB) / (hA + hB);
  // Reverses the boundary secant ⇒ would overshoot into a fabricated bump.
  if (Math.sign(d) !== Math.sign(sA)) return 0;
  // Near a turning edge (secants disagree) cap at 3× the secant — the
  // monotonicity bound against overshoot.
  if (Math.sign(sA) !== Math.sign(sB) && Math.abs(d) > 3 * Math.abs(sA)) {
    return 3 * sA;
  }
  return d;
}

/** Path2D-compatible sink, so the curve math is testable without a canvas. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
}

/**
 * Split the non-null rows of [idx0, idx1] into runs that never cross a break
 * (sorted, disjoint [start, end) intervals). Rows inside a break are dropped.
 */
export function segmentAtBreaks(
  xs: ArrayLike<number>,
  ys: ArrayLike<number | null | undefined>,
  idx0: number,
  idx1: number,
  breaks: ReadonlyArray<readonly [number, number]>,
): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  let j = 0;
  let lastX = -Infinity;
  for (let i = idx0; i <= idx1; i++) {
    if (ys[i] == null) continue;
    const x = xs[i]!;
    let crossed = false;
    while (j < breaks.length && breaks[j]![1] <= x) {
      if (breaks[j]![1] > lastX) crossed = true;
      j++;
    }
    if (j < breaks.length && breaks[j]![0] <= x) continue; // inside a break
    if (crossed && run.length) {
      runs.push(run);
      run = [];
    }
    run.push(i);
    lastX = x;
  }
  if (run.length) runs.push(run);
  return runs;
}

/** Append one PCHIP run through pixel-space points (starts with moveTo). */
export function pchipSegment(stroke: PathSink, px: number[], py: number[]): void {
  const n = px.length;
  if (n === 0) return;
  stroke.moveTo(px[0]!, py[0]!);
  if (n === 1) return;
  if (n === 2) {
    stroke.lineTo(px[1]!, py[1]!);
    return;
  }

  // Interval widths and secant slopes.
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = px[i + 1]! - px[i]!;
    h.push(dx);
    d.push(dx !== 0 ? (py[i + 1]! - py[i]!) / dx : 0);
  }

  // Tangents: PCHIP endpoints + Fritsch–Butland weighted-harmonic-mean interior.
  const m: number[] = [pchipEndpointSlope(h[0]!, h[1]!, d[0]!, d[1]!)];
  for (let i = 1; i < n - 1; i++) {
    const d0 = d[i - 1]!;
    const d1 = d[i]!;
    if (d0 * d1 <= 0) {
      m.push(0); // local extremum: flat tangent
    } else {
      const h0 = h[i - 1]!;
      const h1 = h[i]!;
      const common = h0 + h1;
      m.push((3 * common) / ((common + h1) / d0 + (common + h0) / d1));
    }
  }
  m.push(pchipEndpointSlope(h[n - 2]!, h[n - 3]!, d[n - 2]!, d[n - 3]!));

  // Cubic Hermite segments as beziers.
  for (let i = 0; i < n - 1; i++) {
    const dx = h[i]! / 3;
    stroke.bezierCurveTo(
      px[i]! + dx,
      py[i]! + m[i]! * dx,
      px[i + 1]! - dx,
      py[i + 1]! - m[i + 1]! * dx,
      px[i + 1]!,
      py[i + 1]!,
    );
  }
}

/**
 * PCHIP line path builder. With `breaks` (time intervals, sorted + disjoint),
 * each run between breaks is its own PCHIP curve, so endpoint tangents never
 * leak across a break.
 */
export function pchipPaths(
  breaks?: (u: uPlot) => ReadonlyArray<readonly [number, number]>,
): uPlot.Series.PathBuilder {
  return (u: uPlot, seriesIdx: number, idx0: number, idx1: number) => {
    const xs = u.data[0]!;
    const ys = u.data[seriesIdx]!;
    const scaleKey = u.series[seriesIdx]!.scale!;
    const stroke = new Path2D();
    const brk = breaks?.(u) ?? [];
    const runs: number[][] = brk.length
      ? segmentAtBreaks(xs, ys, idx0, idx1, brk)
      : [nonNullRows(ys, idx0, idx1)];
    for (const run of runs) {
      const px = run.map((i) => u.valToPos(xs[i]!, 'x', true));
      const py = run.map((i) => u.valToPos(ys[i]!, scaleKey, true));
      pchipSegment(stroke, px, py);
    }
    return { stroke };
  };
}

function nonNullRows(ys: ArrayLike<number | null | undefined>, idx0: number, idx1: number): number[] {
  const out: number[] = [];
  for (let i = idx0; i <= idx1; i++) if (ys[i] != null) out.push(i);
  return out;
}
