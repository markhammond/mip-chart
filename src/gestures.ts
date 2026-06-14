// Gesture plugin — pointer-event based, no uPlot
// select machinery. ONE single-pointer state machine serves both a touch
// finger and a trackpad/mouse click-drag, so the same gesture spec works on a
// touchscreen and on a laptop trackpad (which emits mouse + wheel events, not
// touch pointers).
//
//   click-drag / 1-finger drag = box zoom (self-drawn overlay; pushes a level)
//   shift+drag                 = pan (precise desktop escape hatch)
//   click-hold-still / press   = long-press → toggle the hover legend
//   double-click / double-tap  = undo one zoom level, else reset the viewport
//   2-finger swipe / wheel      = pan          (trackpad two-finger translate)
//   pinch / ctrl+wheel          = zoom         (trackpad two-finger scale)
//   2-finger touch              = combined pan+zoom (touchscreen affine fit)
//
// Gestures only *propose* ranges to the shared TimeAxis (or ask the host to
// push/pop the zoom stack); the navigator's axis subscription applies scales.

import type uPlot from 'uplot';
import type { TimeRange } from './types';

export interface GestureCallbacks {
  /** Instant local preview (pan, 2-finger fit, wheel). */
  propose(range: TimeRange): void;
  /** Box zoom: push the current range onto the undo stack, then show `range`. */
  boxZoom(range: TimeRange): void;
  /** Undo one box-zoom level, or reset to the default window if none remain. */
  popZoom(): void;
  /** Long-press: toggle the hover legend. On a trackpad/mouse (live hover)
   *  this hides/shows it; on touch (no hover) it pins/unpins at the point. */
  toggleHover(clientX: number, clientY: number, isTouch: boolean): void;
  /** A continuous gesture started/ended — hosts hide hover chrome while active. */
  setActive?(active: boolean): void;
}

const WHEEL_FACTOR_MIN = 0.6;
const WHEEL_FACTOR_MAX = 1.6;
const LONG_PRESS_MS = 500;
const MOVE_PX = 8; // movement past which a press becomes a box
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;

export function gesturePlugin(cb: GestureCallbacks): uPlot.Plugin {
  return {
    hooks: {
      ready: (u: uPlot) => {
        const over = u.over;
        over.style.touchAction = 'none'; // claim touch from page scroll/zoom

        const xScale = (): TimeRange => ({
          from: u.scales['x']?.min ?? 0,
          to: u.scales['x']?.max ?? 1,
        });
        const localX = (clientX: number) => clientX - over.getBoundingClientRect().left;
        const xValAt = (clientX: number) => u.posToVal(localX(clientX), 'x');
        const zoomAbout = (anchor: number, factor: number) => {
          const r = xScale();
          cb.propose({
            from: anchor - (anchor - r.from) * factor,
            to: anchor + (r.to - anchor) * factor,
          });
        };

        // --- wheel: trackpad two-finger swipe = pan, pinch (ctrl) = zoom ---
        over.addEventListener(
          'wheel',
          (e: WheelEvent) => {
            e.preventDefault();
            if (e.ctrlKey) {
              // browsers encode trackpad pinch as ctrl+wheel (fine steps)
              const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
              const factor = Math.min(
                WHEEL_FACTOR_MAX,
                Math.max(WHEEL_FACTOR_MIN, Math.exp(px * 0.0035)),
              );
              zoomAbout(xValAt(e.clientX), factor);
            } else {
              // two-finger swipe → pan by the dominant axis (content follows)
              const raw = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
              const dpx = e.deltaMode === 1 ? raw * 16 : raw;
              const r = xScale();
              const dxVal = (dpx / Math.max(over.clientWidth, 1)) * (r.to - r.from);
              cb.propose({ from: r.from + dxVal, to: r.to + dxVal });
            }
          },
          { passive: false },
        );

        // --- box overlay --------------------------------------------------
        let boxEl: HTMLDivElement | null = null;
        const startBox = (clientX: number) => {
          boxEl = document.createElement('div');
          boxEl.style.cssText =
            'position:absolute;top:0;bottom:0;pointer-events:none;' +
            'background:rgba(91,127,181,.15);border:1px solid rgba(91,127,181,.6);';
          boxEl.style.left = `${localX(clientX)}px`;
          boxEl.style.width = '0px';
          over.appendChild(boxEl);
        };
        const updateBox = (anchorClientX: number, clientX: number) => {
          if (!boxEl) return;
          const a = localX(anchorClientX);
          const b = localX(clientX);
          boxEl.style.left = `${Math.min(a, b)}px`;
          boxEl.style.width = `${Math.abs(b - a)}px`;
        };
        const finishBox = () => {
          if (!boxEl) return;
          const left = parseFloat(boxEl.style.left);
          const width = parseFloat(boxEl.style.width);
          boxEl.remove();
          boxEl = null;
          if (width > MOVE_PX) {
            cb.boxZoom({ from: u.posToVal(left, 'x'), to: u.posToVal(left + width, 'x') });
          }
        };
        const cancelBox = () => {
          if (boxEl) {
            boxEl.remove();
            boxEl = null;
          }
        };

        // --- pointers (unified: touch fingers OR the mouse button) --------
        // Each pointer is anchored to the value it was over at gesture start;
        // the touch 2-finger affine fits the range that keeps those values
        // under the fingers (pan + zoom in one step).
        type P = { x: number; y: number; val: number };
        const pointers = new Map<number, P>();
        type Mode = 'idle' | 'press' | 'box' | 'pan' | 'two' | 'consumed';
        let mode: Mode = 'idle';
        let startX = 0;
        let startY = 0;
        let panStart: TimeRange | null = null;
        let longPress: ReturnType<typeof setTimeout> | null = null;
        let lastTap = { t: 0, x: 0, y: 0 };

        const clearLongPress = () => {
          if (longPress) {
            clearTimeout(longPress);
            longPress = null;
          }
        };
        const reanchor = () => {
          const rect = over.getBoundingClientRect();
          for (const [id, p] of pointers) {
            pointers.set(id, { x: p.x, y: p.y, val: u.posToVal(p.x - rect.left, 'x') });
          }
        };
        const fitTwoFinger = () => {
          if (pointers.size !== 2) return;
          const [a, b] = [...pointers.values()] as [P, P];
          const W = Math.max(over.clientWidth, 1);
          const rect = over.getBoundingClientRect();
          const fa = (a.x - rect.left) / W;
          const fb = (b.x - rect.left) / W;
          const denom = fa - fb;
          if (Math.abs(denom) < 1e-4) return;
          const span = (a.val - b.val) / denom;
          if (!(span > 0)) return;
          const from = a.val - fa * span;
          cb.propose({ from, to: from + span });
        };

        over.addEventListener('pointerdown', (e: PointerEvent) => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          try {
            over.setPointerCapture(e.pointerId);
          } catch {
            // inactive/synthetic pointer — gesture still tracks
          }
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, val: xValAt(e.clientX) });

          if (pointers.size === 2) {
            // second touch finger → combined pan+zoom
            clearLongPress();
            cancelBox();
            reanchor();
            mode = 'two';
            cb.setActive?.(true);
          } else if (e.shiftKey) {
            // shift+drag → precise pan (desktop escape hatch)
            mode = 'pan';
            startX = e.clientX;
            panStart = xScale();
            cb.setActive?.(true);
          } else {
            // press: becomes box (move), long-press (hold), or tap (release)
            mode = 'press';
            startX = e.clientX;
            startY = e.clientY;
            const isTouch = e.pointerType === 'touch';
            clearLongPress();
            longPress = setTimeout(() => {
              longPress = null;
              if (mode === 'press') {
                mode = 'consumed';
                cb.toggleHover(startX, startY, isTouch);
              }
            }, LONG_PRESS_MS);
          }
          e.preventDefault();
        });

        over.addEventListener('pointermove', (e: PointerEvent) => {
          const p = pointers.get(e.pointerId);
          if (!p) return;
          pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, val: p.val });

          if (mode === 'press') {
            if (Math.abs(e.clientX - startX) > MOVE_PX || Math.abs(e.clientY - startY) > MOVE_PX) {
              clearLongPress();
              mode = 'box';
              cb.setActive?.(true);
              startBox(startX);
              updateBox(startX, e.clientX);
            }
          } else if (mode === 'box') {
            updateBox(startX, e.clientX);
          } else if (mode === 'pan' && panStart) {
            const span = panStart.to - panStart.from;
            const dxVal = ((e.clientX - startX) / Math.max(over.clientWidth, 1)) * span;
            cb.propose({ from: panStart.from - dxVal, to: panStart.to - dxVal });
          } else if (mode === 'two') {
            fitTwoFinger();
          }
        });

        const onUp = (e: PointerEvent) => {
          if (!pointers.has(e.pointerId)) return;
          const wasMode = mode;
          pointers.delete(e.pointerId);

          if (wasMode === 'box') {
            finishBox();
            cb.setActive?.(false);
          } else if (wasMode === 'pan' || wasMode === 'two') {
            cb.setActive?.(false);
            panStart = null;
          } else if (wasMode === 'press') {
            clearLongPress();
            const now = e.timeStamp || Date.now();
            const isDouble =
              now - lastTap.t < DOUBLE_TAP_MS &&
              Math.abs(e.clientX - lastTap.x) < DOUBLE_TAP_PX &&
              Math.abs(e.clientY - lastTap.y) < DOUBLE_TAP_PX;
            if (isDouble) {
              lastTap = { t: 0, x: 0, y: 0 };
              cb.popZoom();
            } else {
              lastTap = { t: now, x: e.clientX, y: e.clientY };
            }
          }
          // Remaining pointers (one lifted from a pinch) stay inert until all
          // lift — avoids a stray box/pan from the leftover finger.
          mode = pointers.size ? 'consumed' : 'idle';
          if (pointers.size === 0) {
            clearLongPress();
            over.style.cursor = '';
          }
        };
        over.addEventListener('pointerup', onUp);
        over.addEventListener('pointercancel', onUp);
      },
    },
  };
}
