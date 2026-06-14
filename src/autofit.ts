// Visible-window Y-autofit, log-aware. Pure, unit-tested.

export interface FitOptions {
  log: boolean;
  /**
   * Lightweight-charts scaleMargins: fractions of the PANE
   * HEIGHT kept empty above/below the data, defaults top 0.2 / bottom 0.1 —
   * data occupies the middle 70% with price headroom above. Applied in
   * log10 space on log axes.
   */
  topFrac?: number;
  bottomFrac?: number;
  /** Positive floor for log fitting (default 1e-9). */
  floor?: number;
}

/** Running min/max accumulator over candidate values. */
export class ExtentAccumulator {
  min = Infinity;
  max = -Infinity;

  add(v: number | null | undefined): void {
    if (v == null || !Number.isFinite(v)) return;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }

  addRange(values: ReadonlyArray<number | null>, lo: number, hi: number): void {
    for (let i = lo; i < hi; i++) this.add(values[i]);
  }

  get empty(): boolean {
    return this.min > this.max;
  }
}

/**
 * Compute a [min, max] Y range bounding the accumulated extrema with
 * lightweight-charts-style scale margins: the data span is stretched so it
 * occupies (1 − top − bottom) of the pane, i.e. marginAbove =
 * span·top/(1−top−bottom) (linear space; log10 space on log axes).
 * Returns null when no data.
 */
export function fitY(extent: ExtentAccumulator, opts: FitOptions): [number, number] | null {
  if (extent.empty) return null;
  const top = opts.topFrac ?? 0.2;
  const bottom = opts.bottomFrac ?? 0.1;
  const usable = Math.max(1 - top - bottom, 0.1);
  let { min, max } = extent;

  if (opts.log) {
    const floor = opts.floor ?? 1e-9;
    min = Math.max(min, floor);
    max = Math.max(max, floor);
    const lmin = Math.log10(min);
    const lmax = Math.log10(max);
    const span = lmax - lmin || Math.abs(lmax) * 0.01 || 0.01;
    return [
      Math.pow(10, lmin - (span * bottom) / usable),
      Math.pow(10, lmax + (span * top) / usable),
    ];
  }

  const span = max - min || Math.abs(max) * 0.01 || 1;
  return [min - (span * bottom) / usable, max + (span * top) / usable];
}
