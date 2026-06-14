// Angled Y-axis category labels. uPlot forces Y-axis label rotation to 0, so a
// pane wanting slanted labels (recipe axisLabelAngle) draws them itself in the
// gutter. Text may run longer than the horizontal cap; overlapping rows auto-thin.

import type uPlot from 'uplot';

export interface AngledLabelsOpts {
  /** Label per ordinal value (index = the y value it sits at). */
  labels: string[];
  /** Degrees; negative tilts the text upward toward the gutter. */
  angleDeg: number;
  /** uPlot axis side: 1 = right gutter, 3 = left. */
  side: 1 | 3;
  /** Reserved gutter width (CSS px) the native axis already holds. */
  gutterPx: number;
  fontPx: number;
  color: string;
  /** Y-scale key the ordinals live on (default 'y'). */
  scaleKey?: string;
}

export function angledAxisLabels(o: AngledLabelsOpts): uPlot.Plugin {
  const scaleKey = o.scaleKey ?? 'y';
  return {
    hooks: {
      draw: (u: uPlot) => {
        const dpr = window.devicePixelRatio || 1;
        const ctx = u.ctx;
        const angle = (o.angleDeg * Math.PI) / 180;
        const fontCanvas = o.fontPx * dpr;
        ctx.save();
        ctx.font = `${fontCanvas}px Menlo, Consolas, monospace`;
        ctx.fillStyle = o.color;
        ctx.textBaseline = 'middle';
        ctx.textAlign = o.side === 1 ? 'left' : 'right';
        const innerX =
          o.side === 1 ? u.bbox.left + u.bbox.width + 4 * dpr : u.bbox.left - 4 * dpr;
        // Char budget across the gutter at this slant; clamp cos (→0 near vertical).
        const charW = fontCanvas * 0.6;
        const cos = Math.max(0.18, Math.abs(Math.cos(angle)));
        const sin = Math.max(0.01, Math.abs(Math.sin(angle)));
        const avail = (o.gutterPx - 6) * dpr;
        const byWidth = Math.floor(avail / (charW * cos));
        const minGap = fontCanvas * 1.25; // auto-thin overlapping rows
        const clearTop = 3 * dpr; // keep a row's slant clear of the title above
        const minChars = 4; // below this a label is too abbreviated to show
        const top = u.bbox.top;
        const bot = u.bbox.top + u.bbox.height;
        let lastY = -Infinity;
        for (let i = 0; i < o.labels.length; i++) {
          const y = u.valToPos(i, scaleKey, true);
          if (y < top - 2 || y > bot + 2) continue;
          if (Math.abs(y - lastY) < minGap) continue;
          // Per-row budget: cap a row's rise at the canvas top so top rows
          // shorten themselves rather than forcing a taller reserved band.
          const byRise = Math.floor((y - clearTop) / (charW * sin));
          const maxChars = Math.min(28, byWidth, byRise);
          if (maxChars < minChars) continue; // too cramped — skip row
          lastY = y;
          let txt = o.labels[i] ?? '';
          if (txt.length > maxChars) txt = `${txt.slice(0, maxChars - 1)}…`;
          ctx.save();
          ctx.translate(innerX, y);
          ctx.rotate(angle);
          ctx.fillText(txt, 0, 0);
          ctx.restore();
        }
        ctx.restore();
      },
    },
  };
}
