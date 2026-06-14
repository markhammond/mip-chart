// Shape-preserving cubic line paths — PCHIP (Piecewise Cubic Hermite
// Interpolating Polynomial). Smooth curves that NEVER overshoot the data
// (unlike Catmull-Rom), so no false extrema on financial series. Interpolation
// runs in pixel space (valToPos per point), correct on log scales too. Nulls on
// the unified timeline are spanned (alignment artifacts).
//
// NB the INTERIOR tangent is the Fritsch–Butland weighted harmonic mean — which
// is identical to plain "monotone cubic" (d3 curveMonotoneX); they share that
// formula. PCHIP's refinement is the ENDPOINTS: a non-centered three-point
// derivative, shape-limited, instead of the boundary secant — giving more
// natural curvature at the visible edges without introducing overshoot.

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
  // Near a turning edge (secants disagree) cap the slope at 3× the secant —
  // the monotonicity bound that keeps the cubic from overshooting.
  if (Math.sign(sA) !== Math.sign(sB) && Math.abs(d) > 3 * Math.abs(sA)) {
    return 3 * sA;
  }
  return d;
}

export function pchipPaths(): uPlot.Series.PathBuilder {
  return (u: uPlot, seriesIdx: number, idx0: number, idx1: number) => {
    const xs = u.data[0]!;
    const ys = u.data[seriesIdx]!;
    const scaleKey = u.series[seriesIdx]!.scale!;

    // Collect non-null points in pixel space (canvas coords).
    const px: number[] = [];
    const py: number[] = [];
    for (let i = idx0; i <= idx1; i++) {
      const y = ys[i];
      if (y == null) continue;
      px.push(u.valToPos(xs[i]!, 'x', true));
      py.push(u.valToPos(y, scaleKey, true));
    }

    const n = px.length;
    const stroke = new Path2D();
    if (n === 0) return { stroke };
    stroke.moveTo(px[0]!, py[0]!);
    if (n === 1) return { stroke };
    if (n === 2) {
      stroke.lineTo(px[1]!, py[1]!);
      return { stroke };
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
        m.push(0); // local extremum: flat tangent ⇒ monotone segments
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

    return { stroke };
  };
}
