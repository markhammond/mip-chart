// Candlestick rendering for uPlot.
// uPlot has no native OHLC type; the canonical approach (uPlot candlestick
// demo) is invisible o/h/l/c series (they still feed Y-autoscale) plus a
// draw-hook plugin that paints candles directly on the canvas.

import type uPlot from 'uplot';

export interface CandlePluginOptions {
  /** Series indices (into u.series) of open/high/low/close. */
  open: number;
  high: number;
  low: number;
  close: number;
  /** Nominal bar duration in x-units (ms), for candle width. */
  barMs: number;
  upColor?: string;
  downColor?: string;
  /** Toggle visibility without removing the plugin. */
  isVisible?: () => boolean;
  /**
   * Minimum candle pitch in CSS px (default 6 — a 5px odd body + 1px
   * separation; mirrors the data source's minimum candle pitch). Visible candles
   * denser than this are re-aggregated at draw time — exact OHLC
   * composition (open=first, high=max, low=min, close=last) — so the
   * floor holds even for already-loaded fine data the covered-pan
   * short-circuit never refetches.
   */
  minPitchPx?: number;
}

export function candlestickPlugin(o: CandlePluginOptions): uPlot.Plugin {
  const up = o.upColor ?? '#26a69a';
  const down = o.downColor ?? '#ef5350';

  return {
    hooks: {
      draw: (u: uPlot) => {
        if (o.isVisible && !o.isVisible()) return;

        const ctx = u.ctx;
        const data = u.data;
        const xs = data[0]!;
        const opens = data[o.open]!;
        const highs = data[o.high]!;
        const lows = data[o.low]!;
        const closes = data[o.close]!;

        const xMin = u.scales['x']?.min ?? -Infinity;
        const xMax = u.scales['x']?.max ?? Infinity;
        const dpr = window.devicePixelRatio || 1;

        // Re-aggregate visible candles into pixel buckets at the pitch floor
        // via exact OHLC composition; identity when data pitch already meets
        // the floor. groupMs = bars needed for the floor at the current span;
        // bucket on an ABSOLUTE-TIME grid (floor(x / groupMs)) so buckets are
        // pan-invariant. Take edge buckets WHOLE (bbox clip handles off-screen
        // members) so they don't morph while scrolling. Zoom changes groupMs.
        const minPitchCanvas = (o.minPitchPx ?? 6) * dpr;
        const spanMs = xMax - xMin;
        const pxPerMs = spanMs > 0 ? u.bbox.width / spanMs : 0;
        const minPitchMs = pxPerMs > 0 ? minPitchCanvas / pxPerMs : o.barMs;
        const groupMs = Math.max(1, Math.ceil(minPitchMs / o.barMs)) * o.barMs;
        const loBucket = Math.floor(xMin / groupMs);
        const hiBucket = Math.floor(xMax / groupMs);

        const centers: number[] = [];
        const aggOpen: number[] = [];
        const aggHigh: number[] = [];
        const aggLow: number[] = [];
        const aggClose: number[] = [];
        let bucket = Number.NaN;
        for (let i = 0; i < xs.length; i++) {
          const op = opens[i];
          const hi = highs[i];
          const lo = lows[i];
          const cl = closes[i];
          if (op == null || hi == null || lo == null || cl == null) continue;
          const x = xs[i]!;
          const b = Math.floor(x / groupMs);
          if (b < loBucket || b > hiBucket) continue;
          if (b !== bucket) {
            bucket = b;
            // Center on the BUCKET GRID SLOT (b·groupMs), not the first bar, for
            // uniform pitch. groupMs is a barMs multiple and opens are barMs-
            // aligned, so in the identity case the slot is the bar time and
            // candles stay pixel-aligned with the EMA/VWAP points.
            centers.push(Math.round(u.valToPos(b * groupMs, 'x', true)));
            aggOpen.push(op); // open = first
            aggHigh.push(hi);
            aggLow.push(lo);
            aggClose.push(cl);
          } else {
            const g = aggHigh.length - 1;
            if (hi > aggHigh[g]!) aggHigh[g] = hi; // high = max
            if (lo < aggLow[g]!) aggLow[g] = lo; // low = min
            aggClose[g] = cl; // close = last
          }
        }
        if (centers.length === 0) return;

        // CONSTANT width for every candle, derived from the single groupMs
        // pitch — not from measured neighbor gaps (whose ±1px center rounding
        // alternates and jitters widths). Centers still vary per bar.
        const sepPx = Math.max(1, Math.round(dpr)); // ≥1 CSS px between bodies
        const pitchPx = groupMs * pxPerMs;

        // Body: pitch-driven. Tight pitches pack to pitch−1px; the 70%
        // breathing room only reads well on large candles. ODD width so it
        // centers on the data column (cx + 0.5).
        let bodyW = Math.min(
          pitchPx <= 10 * dpr ? pitchPx - sepPx : pitchPx * 0.7,
          41 * dpr,
        );
        bodyW = Math.max(1, Math.floor(bodyW));
        if (bodyW % 2 === 0) bodyW -= 1;
        bodyW = Math.max(1, bodyW);

        // Wick: thin ~1 CSS px line (scaling gently with the body), centered on
        // cx + 0.5. Keep the width FRACTIONAL (not odd-snapped) so it anti-
        // aliases smoothly on retina rather than reading as a blocky 3px bar.
        const wickW = Math.min(Math.max(1.05 * dpr, bodyW * 0.14), 1.6 * dpr);

        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();
        ctx.lineWidth = 1;

        for (let k = 0; k < centers.length; k++) {
          const cx = centers[k]!;
          const op = aggOpen[k]!;
          const hi = aggHigh[k]!;
          const lo = aggLow[k]!;
          const cl = aggClose[k]!;

          const color = cl >= op ? up : down;
          const yHi = Math.round(u.valToPos(hi, 'y', true));
          const yLo = Math.round(u.valToPos(lo, 'y', true));
          const yOp = Math.round(u.valToPos(op, 'y', true));
          const yCl = Math.round(u.valToPos(cl, 'y', true));

          // wick — thin rect centered on cx + 0.5, spanning high→low;
          // fractional width anti-aliases the edges.
          ctx.fillStyle = color;
          ctx.fillRect(cx + 0.5 - wickW / 2, yHi, wickW, Math.max(1, yLo - yHi));

          // body — odd width spanning [cx-half, cx+half], so the wick column
          // is its exact center
          const top = Math.min(yOp, yCl);
          const h = Math.max(1, Math.abs(yCl - yOp));
          ctx.fillRect(cx - (bodyW - 1) / 2, top, bodyW, h);
        }

        ctx.restore();
      },
    },
  };
}

/** Series stub that feeds autoscale but paints nothing (paths/points off). */
export function hiddenScaleSeries(label: string): uPlot.Series {
  return {
    label,
    scale: 'y',
    paths: () => null,
    points: { show: false },
  };
}
