// State-bars renderer: the categorical lane drawn as filled
// vertical bars colored by state ordinal (viridis-like default ramp), drawn
// via a draw-hook plugin like the candlestick renderer. The carrier series
// keeps paths hidden but feeds cursor/idx; bar height = ordinal value.

import type uPlot from 'uplot';

/** Compact viridis-ish ramp; index 0 (reserved Undefined) gets red. */
export const DEFAULT_STATE_COLORS = [
  '#ef5350', // 0 = Undefined / invalid — reserved sentinel
  '#440154',
  '#31688e',
  '#35b779',
  '#fde725',
  '#fdae61',
  '#8073ac',
];

export function stateColor(ordinal: number, colors?: string[]): string {
  const palette = colors && colors.length ? colors : DEFAULT_STATE_COLORS;
  return palette[Math.max(0, Math.min(ordinal, palette.length - 1))] ?? '#888';
}

export interface StateBarsOptions {
  /** uPlot series index carrying the ordinal values. */
  seriesIdx: number;
  /** Ordinal → color; falls back to DEFAULT_STATE_COLORS. */
  colors?: string[];
  /** Toggle visibility with the carrier series. */
  isVisible?: () => boolean;
}

export function stateBarsPlugin(o: StateBarsOptions): uPlot.Plugin {
  return {
    hooks: {
      draw: (u: uPlot) => {
        if (o.isVisible && !o.isVisible()) return;
        const xs = u.data[0]!;
        const vals = u.data[o.seriesIdx];
        if (!vals) return;

        const ctx = u.ctx;
        const xMin = u.scales['x']?.min ?? -Infinity;
        const xMax = u.scales['x']?.max ?? Infinity;
        const yMin = u.scales['y']?.min ?? 0;
        const y0 = u.valToPos(Math.max(yMin, -0.5), 'y', true);

        // Bar width from spacing between consecutive non-null samples.
        let stepX = Infinity;
        let prev: number | null = null;
        for (let i = 0; i < xs.length; i++) {
          if (vals[i] == null) continue;
          const x = xs[i]!;
          if (prev != null) {
            stepX = Math.min(stepX, x - prev);
            if (Number.isFinite(stepX) && stepX > 0) break;
          }
          prev = x;
        }
        const px0 = u.valToPos(0, 'x', true);
        const px1 = u.valToPos(Number.isFinite(stepX) ? stepX : 1, 'x', true);
        const w = Math.max(1, Math.abs(px1 - px0));

        // Non-null sample centers, in order. Bar boundaries sit at the
        // MIDPOINTS between consecutive centers, ROUNDED to integers and
        // SHARED: bar k's right edge is bar k+1's left edge by construction,
        // so adjacent segments abut exactly — no sub-pixel hairline gap (the
        // old centered `cx ± w/2` rects rounded independently and left
        // ~1px slivers). globalAlpha stays off the fill so the shared edges
        // don't double-blend.
        const idx: number[] = [];
        for (let i = 0; i < xs.length; i++) if (vals[i] != null) idx.push(i);
        if (idx.length === 0) return;
        const cxs = idx.map((i) => u.valToPos(xs[i]!, 'x', true));

        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();
        ctx.globalAlpha = 0.85;

        for (let k = 0; k < idx.length; k++) {
          const cx = cxs[k]!;
          const leftB = k > 0 ? (cxs[k - 1]! + cx) / 2 : cx - w / 2;
          const rightB = k < idx.length - 1 ? (cx + cxs[k + 1]!) / 2 : cx + w / 2;
          const L = Math.round(leftB);
          const R = Math.round(rightB);
          if (R < u.bbox.left || L > u.bbox.left + u.bbox.width) continue; // off-screen
          const v = vals[idx[k]!]!;
          const yTop = u.valToPos(v, 'y', true);
          ctx.fillStyle = stateColor(Math.round(v), o.colors);
          ctx.fillRect(L, yTop, Math.max(1, R - L), Math.max(1, y0 - yTop));
        }
        ctx.restore();
      },
    },
  };
}
