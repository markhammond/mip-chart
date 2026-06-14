// The shared time axis — the library's loose-coupling spine. Components attach
// to ONE TimeAxis and either propose a visible range or observe changes; they
// never reference each other, only the axis.

import type { TimeRange } from './types';

export type NavigationCause = 'gesture' | 'navigate' | 'brush' | 'program';

export type AxisListener = (range: TimeRange, cause: NavigationCause) => void;

/**
 * Perception-based maximum-magnification clamp:
 * the smallest useful visible span is `barMs × max(minVisibleBars,
 * plotWidthPx / maxBarPitchPx)`.
 *
 * - maxBarPitchPx ≈ 16: a candlestick is fully articulated (body, wicks,
 *   inter-bar gap all discriminable) by ~10–16 px of pitch — wider bars add
 *   whitespace, not information, so this is the max useful magnification.
 * - minVisibleBars ≈ 48: keeps enough local context in view to read
 *   structure rather than isolated marks (shape/trend judgments need an
 *   ensemble; a working set of ~1–2 sessions of bars reads naturally).
 */
export function minVisibleSpanMs(
  barMs: number,
  plotWidthPx: number,
  maxBarPitchPx = 16,
  minVisibleBars = 48,
): number {
  const pitchBars = Math.ceil(Math.max(plotWidthPx, 1) / Math.max(maxBarPitchPx, 1));
  return barMs * Math.max(minVisibleBars, pitchBars);
}

export class TimeAxis {
  private listeners = new Set<AxisListener>();
  private _visible: TimeRange;

  /** Smallest permissible visible span — the zoom-magnification clamp.
   *  Mutable: the navigator recomputes it on resize (width-dependent). */
  minSpanMs: number;

  constructor(
    /** Full navigable extent, known up front. */
    readonly extent: TimeRange,
    initial: TimeRange,
    minSpanMs = 60_000,
  ) {
    this.minSpanMs = minSpanMs;
    this._visible = this.clamp(initial);
  }

  get visible(): TimeRange {
    return { ...this._visible };
  }

  /** Clamp a candidate range into the extent, preserving its span.
   *  Quantizes to INTEGER milliseconds — gesture math (exp zoom factors)
   *  produces fractions, but the wire contract is UTC-ms longs. */
  clamp(r: TimeRange): TimeRange {
    const span = Math.min(Math.max(r.to - r.from, this.minSpanMs), this.extent.to - this.extent.from);
    let from = Math.max(r.from, this.extent.from);
    let to = from + span;
    if (to > this.extent.to) {
      to = this.extent.to;
      from = to - span;
    }
    return { from: Math.round(from), to: Math.round(to) };
  }

  /**
   * Propose a new visible range. Clamped; no-ops (sub-ms identical ranges)
   * are swallowed. Returns the applied range, or null if nothing changed.
   * Listeners are notified synchronously, in subscription order.
   */
  propose(r: TimeRange, cause: NavigationCause): TimeRange | null {
    const next = this.clamp(r);
    if (next.from === this._visible.from && next.to === this._visible.to) return null;
    this._visible = next;
    for (const fn of this.listeners) fn({ ...next }, cause);
    return { ...next };
  }

  /** Attach a component. Returns the detach function. */
  subscribe(fn: AxisListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
