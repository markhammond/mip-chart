// Angled Y-axis category labels. uPlot only honours `axis.rotate` on the
// bottom X-axis (side 2) — Y-axis label rotation is forced to 0 — so a pane
// that wants slanted labels (recipe axisLabelAngle, e.g. a dense state lane
// with long category names) draws them itself in the reserved gutter. The text
// is allowed to run longer than the horizontal cap, and overlapping rows are
// auto-thinned so the slant stays readable instead of smearing together.

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
        // Char budget: how many fit across the gutter at this slant (cos→0 near
        // vertical, so clamp). Keeps long names from spilling over the plot.
        const charW = fontCanvas * 0.6;
        const cos = Math.max(0.18, Math.abs(Math.cos(angle)));
        const sin = Math.max(0.01, Math.abs(Math.sin(angle)));
        const avail = (o.gutterPx - 6) * dpr;
        const byWidth = Math.floor(avail / (charW * cos));
        const minGap = fontCanvas * 1.25; // auto-thin overlapping rows
        const clearTop = 3 * dpr; // keep a row's slant clear of the title above
        const minChars = 4; // below this a label is too abbreviated to bother
        const top = u.bbox.top;
        const bot = u.bbox.top + u.bbox.height;
        let lastY = -Infinity;
        for (let i = 0; i < o.labels.length; i++) {
          const y = u.valToPos(i, scaleKey, true);
          if (y < top - 2 || y > bot + 2) continue;
          if (Math.abs(y - lastY) < minGap) continue;
          // Per-row budget: a row only rises as far as the canvas top (the title
          // edge) allows — so the TOP rows shorten themselves instead of forcing
          // a tall reserved band that shoves the title away from the plot.
          const byRise = Math.floor((y - clearTop) / (charW * sin));
          const maxChars = Math.min(28, byWidth, byRise);
          if (maxChars < minChars) continue; // too cramped here — skip this row
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
