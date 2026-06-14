// Primary-pane watermark — a faint centred label (low opacity, behind the
// data). The recipe supplies the text WITH its own line breaks (`\n`); the
// component never
// auto-wraps — it just scales the font so the block fits ~85% of the plot in
// both dimensions, snapping to a ladder so the size holds steady while
// resizing. Lives behind the series (uPlot's `.u-under`), so data draws over it.

import type uPlot from 'uplot';

export interface Watermark {
  /** Attach into the plot's under-layer (call once the plot is ready). */
  mount(u: uPlot): void;
  /** Re-fit the font to the current plot size (call on every resize). */
  fit(u: uPlot): void;
}

/** Perceptually-spaced font ladder (px). The fit snaps to the largest rung that
 *  fits, so the size holds steady across a resize drag instead of drifting. */
const FONT_LADDER = [16, 21, 28, 37, 48, 62, 80, 100, 124];

export function makeWatermark(text: string): Watermark {
  const wrap = document.createElement('div');
  wrap.className = 'vcn-watermark';
  wrap.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'pointer-events:none;overflow:hidden;';
  const txt = document.createElement('div');
  txt.textContent = text; // honours author '\n' breaks verbatim (white-space:pre)
  // Faint, bold, centred — a watermark look. `pre` means no wrapping;
  // the author's line breaks are the only breaks.
  txt.style.cssText =
    'white-space:pre;text-align:center;font-family:system-ui,-apple-system,sans-serif;' +
    'font-weight:700;color:#28324a;opacity:.09;line-height:1.12;';
  wrap.appendChild(txt);

  const underOf = (u: uPlot): HTMLElement | null =>
    u.root.querySelector('.u-under') as HTMLElement | null;

  return {
    mount(u) {
      underOf(u)?.appendChild(wrap);
    },
    fit(u) {
      // Measure from uPlot's bbox (plot area in canvas px), NOT the DOM
      // `.u-under` clientWidth: inside the setSize hook the bbox is already
      // updated while the DOM layout is still stale, so reading clientWidth
      // would re-fit against the OLD size (and never update on resize — visible
      // in a standalone snapshot that's resized).
      const dpr = window.devicePixelRatio || 1;
      const W = u.bbox.width / dpr;
      const H = u.bbox.height / dpr;
      if (W < 4 || H < 4) return;
      const boxW = W * 0.85;
      const boxH = H * 0.85;
      let lo = 8;
      let hi = Math.min(boxH, FONT_LADDER[FONT_LADDER.length - 1]!);
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        txt.style.fontSize = `${mid}px`;
        // +1 tolerance: scrollWidth/Height are rounded-up integers, boxW/H are
        // fractional — without it the width check fails at every size.
        if (txt.scrollWidth <= boxW + 1 && txt.scrollHeight <= boxH + 1) lo = mid;
        else hi = mid;
      }
      // Snap DOWN to the largest ladder rung that fits, so the size stays put
      // through a resize drag and only jumps at distinct levels.
      let size = Math.min(Math.floor(lo), FONT_LADDER[0]!);
      for (const rung of FONT_LADDER) if (rung <= lo) size = rung;
      txt.style.fontSize = `${size}px`;
    },
  };
}
