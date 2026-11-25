// Minimap / overview navigator — a loosely-coupled axis component: knows ONLY
// the TimeAxis (propose + subscribe) and its own overview data, never the pane
// stack. Template for any future axis-linked component (scrollbar, annotation
// strip, …).
//
// Visual + interaction design ported from Apache ECharts' dataZoom slider:
// low-contrast data shadow, a move-handle bar riding on top of the window
// (grabbable even when the window is pixels wide), pill resize grips on the
// edges, no labels — the navigator's range readout strip carries from/to.

import uPlot from 'uplot';
import type { TimeRange, UtcMillis } from './types';
import { TimeAxis } from './timeAxis';

export interface MinimapOptions {
  axis: TimeAxis;
  heightPx?: number;
  /** Data-shadow line colour. */
  color?: string;
  /** Data-shadow area fill. */
  fill?: string;
  width: number;
  /** Right-side gutter to reserve so the overview's plot area stays
   *  pixel-aligned with the pane stack above it (same Y-axis width). */
  gutterPx?: number;
}

// ECharts dataZoom default palette (lowered contrast).
const SHADOW_LINE = '#aab6d4'; // dataBackground line (#d2dbee, nudged legible)
const SHADOW_FILL = 'rgba(210,219,238,.35)'; // dataBackground area
const FILLER = 'rgba(135,175,247,.18)'; // selected-window filler
const FILLER_BORDER = 'rgba(135,175,247,.4)';
const HANDLE_BORDER = '#acb8d1'; // pill handle stroke
const MOVE_HANDLE = '#d2dbee'; // move-handle bar
const MOVE_HANDLE_HOVER = '#b6c3e0';

/** Height of the move-handle strip riding above the data shadow. */
const MOVE_H = 10;
/** Invisible hit width around each resize pill. */
const GRIP_HIT_PX = 14;

export class Minimap {
  private plot: uPlot;
  private brush: HTMLElement;
  private moveHandle: HTMLElement;
  private handleL: HTMLElement;
  private handleR: HTMLElement;
  private unsubscribe: () => void;
  private overResize: ResizeObserver;
  private hasData = false;
  /** Recipe-driven event dots (e.g. undefined-factor markers), drawn over the
   *  data shadow near the bottom of the strip. */
  private overlay: Array<{ t: number; to?: number; color: string }> = [];

  constructor(private readonly container: HTMLElement, private readonly opts: MinimapOptions) {
    const { axis } = opts;
    const color = opts.color ?? SHADOW_LINE;
    const fill = opts.fill ?? SHADOW_FILL;

    // Top strip reserved for the move handle (outside the plot area).
    container.style.position = 'relative';
    container.style.paddingTop = `${MOVE_H}px`;
    container.style.boxSizing = 'border-box';

    this.plot = new uPlot(
      {
        width: opts.width,
        height: (opts.heightPx ?? 64) - MOVE_H,
        padding: [2, 0, 0, 0], // match the panes' padding for alignment
        ms: 1,
        tzDate: (ts) => uPlot.tzDate(new Date(ts), 'Etc/UTC'),
        scales: {
          x: { time: true, range: () => [axis.extent.from, axis.extent.to] },
        },
        series: [{}, { stroke: color, width: 1, fill, spanGaps: true }],
        axes: [
          // No calendar labels; from/to render at the ends on hover.
          { show: false },
          // Tickless stub reserving the panes' Y-gutter width (alignment).
          {
            side: 1,
            size: opts.gutterPx ?? 0,
            show: (opts.gutterPx ?? 0) > 0,
            grid: { show: false },
            ticks: { show: false },
            splits: () => [],
            values: () => [],
          },
        ],
        legend: { show: false },
        cursor: { show: false, drag: { x: false, y: false } },
        plugins: [
          {
            // Recipe-driven event dots over the data shadow, near the bottom.
            hooks: {
              draw: (u: uPlot) => {
                if (this.overlay.length === 0) return;
                const ctx = u.ctx;
                const dpr = window.devicePixelRatio || 1;
                const r = 2.5 * dpr;
                const y = u.bbox.top + u.bbox.height - r - dpr;
                ctx.save();
                for (const p of this.overlay) {
                  const x = u.valToPos(p.t, 'x', true);
                  if (p.to != null) {
                    // Span: a thin bar along the bottom, at least 1 device px wide.
                    const x1 = u.valToPos(p.to, 'x', true);
                    if (x1 < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
                    ctx.fillStyle = p.color;
                    ctx.fillRect(x, y - r, Math.max(dpr, x1 - x), r);
                    continue;
                  }
                  if (x < u.bbox.left - r || x > u.bbox.left + u.bbox.width + r) continue;
                  ctx.fillStyle = p.color;
                  ctx.beginPath();
                  ctx.arc(x, y, r, 0, Math.PI * 2);
                  ctx.fill();
                }
                ctx.restore();
              },
            },
          },
        ],
      },
      [[], []] as unknown as uPlot.AlignedData,
      container,
    );

    // Brush overlay lives inside the plot area (u.over).
    const over = this.plot.over;
    over.style.cursor = 'crosshair';
    this.brush = mkDiv(
      `position:absolute;top:0;bottom:0;background:${FILLER};` +
        `border:1px solid ${FILLER_BORDER};cursor:grab;box-sizing:border-box;`,
    );
    this.handleL = mkGrip('left');
    this.handleR = mkGrip('right');
    this.brush.append(this.handleL, this.handleR);
    over.appendChild(this.brush);

    // Move-handle bar riding on top of the window, grabbable even when the
    // window is narrower than the grips. Make it a brush CHILD (CSS-centered,
    // min-width) so it can't detach — no JS positioning to go stale. uPlot's
    // wrappers don't clip, so the negative top is visible.
    this.moveHandle = mkDiv(
      // Flush against the brush top (bottom edge at y=0); overhangs 1px each
      // side to tuck under the resize pills (which keep a higher z-index).
      `position:absolute;top:-${MOVE_H - 2}px;height:${MOVE_H - 2}px;` +
        'left:50%;transform:translateX(-50%);width:max(calc(100% + 2px), 24px);' +
        `background:${MOVE_HANDLE};` +
        'border-radius:2px;cursor:grab;display:flex;align-items:center;' +
        'justify-content:center;z-index:2;',
    );
    const grip = mkDiv(
      'width:14px;height:3px;border-radius:2px;' +
        'background:repeating-linear-gradient(90deg,#8a93a8 0 2px,transparent 2px 5px);',
    );
    this.moveHandle.appendChild(grip);
    this.moveHandle.addEventListener('pointerenter', () => {
      this.moveHandle.style.background = MOVE_HANDLE_HOVER;
    });
    this.moveHandle.addEventListener('pointerleave', () => {
      this.moveHandle.style.background = MOVE_HANDLE;
    });
    this.brush.appendChild(this.moveHandle);

    this.wirePointer(over);
    this.unsubscribe = axis.subscribe(() => this.positionBrush());
    this.positionBrush();
    // uPlot applies the gutter-axis size on a later draw, leaving over briefly
    // full-width; a brush positioned then parks one gutter too far right.
    // Observe over itself — deterministic, no timing guesses.
    this.overResize = new ResizeObserver(() => this.positionBrush());
    this.overResize.observe(over);
  }

  /** Feed overview data (coarse sketch or full-extent refinement). */
  setOverview(xs: UtcMillis[], values: Array<number | null>): void {
    this.hasData = xs.length > 0;
    this.plot.setData([xs, values] as unknown as uPlot.AlignedData, false);
    this.plot.redraw();
    this.positionBrush();
  }

  /** Replace the event overlay drawn over the shadow: dots at `t`, or bars
   *  from `t` to `to` for spans. */
  setOverlay(points: Array<{ t: UtcMillis; to?: UtcMillis; color: string }>): void {
    this.overlay = points;
    this.plot.redraw();
  }

  setWidth(width: number): void {
    this.plot.setSize({ width, height: (this.opts.heightPx ?? 64) - MOVE_H });
    this.positionBrush();
  }

  get isPendingData(): boolean {
    return !this.hasData;
  }

  private positionBrush(): void {
    const { axis } = this.opts;
    const v = axis.visible;
    const e = axis.extent;
    // Use the over-element's LIVE width — valToPos reads uPlot's bbox, which
    // lags layout around construction/axis sizing.
    const width = this.plot.over.clientWidth;
    const span = e.to - e.from || 1;
    const left = ((v.from - e.from) / span) * width;
    const right = ((v.to - e.from) / span) * width;
    const w = Math.max(right - left, 2);
    this.brush.style.left = `${left}px`;
    this.brush.style.width = `${w}px`;
    // move handle is a CSS-centered brush child — nothing to position
  }

  private wirePointer(over: HTMLElement): void {
    const { axis } = this.opts;

    type DragMode = 'move' | 'left' | 'right' | null;
    let mode: DragMode = null;
    let startX = 0;
    let startRange: TimeRange | null = null;

    const pxToMs = (px: number) =>
      (px / over.clientWidth) * (axis.extent.to - axis.extent.from);

    const onDown = (e: PointerEvent, m: Exclude<DragMode, null>) => {
      mode = m;
      startX = e.clientX;
      startRange = axis.visible;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };

    this.brush.addEventListener('pointerdown', (e) => onDown(e, 'move'));
    this.moveHandle.addEventListener('pointerdown', (e) => onDown(e, 'move'));
    this.handleL.addEventListener('pointerdown', (e) => onDown(e, 'left'));
    this.handleR.addEventListener('pointerdown', (e) => onDown(e, 'right'));

    const onMove = (e: PointerEvent) => {
      if (!mode || !startRange) return;
      const dt = pxToMs(e.clientX - startX);
      if (mode === 'move') {
        axis.propose({ from: startRange.from + dt, to: startRange.to + dt }, 'brush');
      } else if (mode === 'left') {
        axis.propose({ from: startRange.from + dt, to: startRange.to }, 'brush');
      } else {
        axis.propose({ from: startRange.from, to: startRange.to + dt }, 'brush');
      }
    };
    const onUp = () => {
      mode = null;
      startRange = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    // Click on the track (outside the brush): center the window there.
    over.addEventListener('pointerdown', (e) => {
      if (e.target !== over) return;
      const rect = over.getBoundingClientRect();
      const t = this.plot.posToVal(e.clientX - rect.left, 'x');
      const v = axis.visible;
      const half = (v.to - v.from) / 2;
      axis.propose({ from: t - half, to: t + half }, 'brush');
    });
  }

  destroy(): void {
    this.overResize.disconnect();
    this.unsubscribe();
    this.plot.destroy();
    this.container.innerHTML = '';
  }
}

function mkDiv(css: string): HTMLElement {
  const d = document.createElement('div');
  d.style.cssText = css;
  return d;
}

/** ECharts-style pill resize grip inside a wider invisible hit area.
 *  The LEFT grip stacks above the right one: on a collapsed window the
 *  hit areas overlap, and expanding naturally starts by pulling the left
 *  edge leftward — right-on-top made that grab the wrong grip. */
function mkGrip(side: 'left' | 'right'): HTMLElement {
  const hit = mkDiv(
    `position:absolute;top:0;bottom:0;${side}:-${GRIP_HIT_PX / 2}px;` +
      `width:${GRIP_HIT_PX}px;cursor:ew-resize;display:flex;` +
      `align-items:center;justify-content:center;z-index:${side === 'left' ? 4 : 3};`,
  );
  const pill = mkDiv(
    // Protrude past the brush (into the strip, past the baseline) so the grips
    // read as bracketing the window.
    'position:absolute;top:-2px;bottom:-2px;left:50%;transform:translateX(-50%);' +
      'width:7px;background:#fff;' +
      `border:1px solid ${HANDLE_BORDER};border-radius:3px;` +
      'box-shadow:0 1px 2px rgba(0,0,0,.12);box-sizing:border-box;',
  );
  hit.appendChild(pill);
  return hit;
}
