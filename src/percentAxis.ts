// Percentage-change scale mode from a left-edge origin.
// An axis *label* transform — series data stays in native units. Pure logic.

import type { TimeRange, UtcMillis } from './types';
import { lowerBound } from './seriesStore';

export class PercentOrigin {
  /** Native-unit origin value (the 0% anchor). Null until first rebase. */
  origin: number | null = null;

  /**
   * Rebase to the leftmost visible sample of the baseline series, with
   * carry-forward to the first non-null at/after the left edge.
   * `trueBaseline` (provider-shipped full-resolution value) wins when
   * present. Origin anchoring is independent of series visibility —
   * callers must NOT skip rebase when the baseline series is hidden.
   */
  rebase(
    xs: readonly UtcMillis[],
    values: ReadonlyArray<number | null>,
    visible: TimeRange,
    trueBaseline?: number | null,
  ): void {
    if (trueBaseline != null && Number.isFinite(trueBaseline)) {
      this.origin = trueBaseline;
      return;
    }
    const lo = lowerBound(xs as number[], visible.from);
    const hi = lowerBound(xs as number[], visible.to);
    for (let i = lo; i < hi; i++) {
      const v = values[i];
      if (v != null && Number.isFinite(v)) {
        this.origin = v;
        return;
      }
    }
    // No in-view sample: keep the previous origin (defined fallback).
  }

  /** Native value → percent-from-origin, or null when origin is unset/zero. */
  toPercent(v: number): number | null {
    if (this.origin == null || this.origin === 0) return null;
    return (v / this.origin - 1) * 100;
  }

  /** Axis tick label for a native-unit split value. */
  format(v: number, decimals = 2): string {
    const pct = this.toPercent(v);
    if (pct == null) return '';
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(decimals)}%`;
  }

  /**
   * Choose tick decimals so adjacent splits stay distinguishable.
   * `splits` are native-unit axis split values; null entries (uPlot label
   * filters) render empty.
   */
  formatSplits(splits: ReadonlyArray<number | null>): string[] {
    if (this.origin == null || this.origin === 0) return splits.map(() => '');
    const finite = splits.filter((v): v is number => v != null && Number.isFinite(v));
    let decimals = 2;
    if (finite.length >= 2) {
      const stepPct = Math.abs(((finite[1]! - finite[0]!) / Math.abs(this.origin)) * 100);
      if (stepPct >= 1) decimals = 1;
      if (stepPct >= 10) decimals = 0;
      if (stepPct > 0 && stepPct < 0.1) decimals = 3;
    }
    return splits.map((v) => (v == null || !Number.isFinite(v) ? '' : this.format(v, decimals)));
  }
}
