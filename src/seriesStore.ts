// Per-series columnar store: sorted-merge of fragments + bounded-window
// eviction. Pure logic, unit-testable.

import type { SeriesFragment, TimeRange, UtcMillis } from './types';

export class SeriesStore {
  xs: UtcMillis[] = [];
  columns: Record<string, Array<number | null>> = {};

  constructor(private readonly columnNames: string[]) {
    for (const c of columnNames) this.columns[c] = [];
  }

  get length(): number {
    return this.xs.length;
  }

  /**
   * Merge a fragment. New data wins on timestamp collision (re-fetched ranges
   * may carry a different density). O(existing + incoming) merge — bounded by
   * the loaded window, never total history.
   */
  merge(fragment: SeriesFragment): void {
    const inXs = fragment.xs;
    if (inXs.length === 0) return;

    const oldXs = this.xs;
    const n = oldXs.length;
    const m = inXs.length;
    const outXs: UtcMillis[] = [];
    const outCols: Record<string, Array<number | null>> = {};
    for (const c of this.columnNames) outCols[c] = [];

    const pushOld = (i: number) => {
      outXs.push(oldXs[i]!);
      for (const c of this.columnNames) outCols[c]!.push(this.columns[c]![i] ?? null);
    };
    const pushNew = (j: number) => {
      outXs.push(inXs[j]!);
      for (const c of this.columnNames) outCols[c]!.push(fragment.columns[c]?.[j] ?? null);
    };

    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (j >= m) {
        pushOld(i++);
      } else if (i >= n) {
        pushNew(j++);
      } else {
        const a = oldXs[i]!;
        const b = inXs[j]!;
        if (a < b) pushOld(i++);
        else if (b < a) pushNew(j++);
        else {
          pushNew(j++); // collision: new wins
          i++;
        }
      }
    }

    this.xs = outXs;
    this.columns = outCols;
  }

  /** Drop points outside `keep`. */
  evictOutside(keep: TimeRange): void {
    const lo = lowerBound(this.xs, keep.from);
    const hi = lowerBound(this.xs, keep.to);
    if (lo === 0 && hi === this.xs.length) return;
    this.xs = this.xs.slice(lo, hi);
    for (const c of this.columnNames) this.columns[c] = this.columns[c]!.slice(lo, hi);
  }

  /** Index range [lo, hi) of points with x in [from, to). */
  visibleIndexRange(r: TimeRange): [number, number] {
    return [lowerBound(this.xs, r.from), lowerBound(this.xs, r.to)];
  }

  clear(): void {
    this.xs = [];
    for (const c of this.columnNames) this.columns[c] = [];
  }
}

/**
 * Nearest non-null value around `idx` in an aligned column (hover lookups):
 * the unified timeline + LTTB leave nulls on rows a series didn't sample, so
 * exact-row reads intermittently miss (e.g. VWAP under candles). Prefers the
 * closer side; scans at most `maxScan` rows each way.
 */
export function nearestNonNull(
  col: ArrayLike<number | null | undefined>,
  idx: number,
  maxScan = 32,
): number | null {
  const i = nearestNonNullIdx(col, idx, maxScan);
  return i < 0 ? null : (col[i] as number);
}

/** Index variant of nearestNonNull (−1 when nothing within maxScan) — lets
 *  hover resolve auxiliary columns/timestamps at the ROW the value actually
 *  came from (a sparse event series). */
export function nearestNonNullIdx(
  col: ArrayLike<number | null | undefined>,
  idx: number,
  maxScan = 32,
): number {
  if (col[idx] != null) return idx;
  for (let d = 1; d <= maxScan; d++) {
    if (idx - d >= 0 && col[idx - d] != null) return idx - d;
    if (idx + d < col.length && col[idx + d] != null) return idx + d;
  }
  return -1;
}

/** Last non-null index AT OR BEFORE `idx` — causal hover resolution: with time
 *  running left→right, a series' value at the cursor is its most recent sample,
 *  never one in the future. Scans back at most `maxScan` rows (LTTB/grid gaps);
 *  −1 when none. Unlike nearestNonNullIdx this never looks ahead. */
export function priorNonNullIdx(
  col: ArrayLike<number | null | undefined>,
  idx: number,
  maxScan = 32,
): number {
  for (let d = 0; d <= maxScan; d++) {
    const j = idx - d;
    if (j < 0) break;
    if (col[j] != null) return j;
  }
  return -1;
}

/** First index whose value is >= target (xs sorted ascending). */
export function lowerBound(xs: readonly number[], target: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Align several stores onto one unified sorted X timeline —
 * the per-pane uPlot data table. Missing samples become null (uPlot renders
 * gaps or spans them per-series).
 */
export function alignStores(
  stores: ReadonlyArray<{ store: SeriesStore; column: string }>,
): { xs: UtcMillis[]; ys: Array<Array<number | null>> } {
  // Union of timestamps.
  const seen = new Set<number>();
  const xs: number[] = [];
  for (const { store } of stores) {
    for (const x of store.xs) {
      if (!seen.has(x)) {
        seen.add(x);
        xs.push(x);
      }
    }
  }
  xs.sort((a, b) => a - b);

  const ys = stores.map(({ store, column }) => {
    const col = store.columns[column] ?? [];
    const out = new Array<number | null>(xs.length).fill(null);
    let k = 0;
    for (let i = 0; i < store.xs.length; i++) {
      const x = store.xs[i]!;
      while (k < xs.length && xs[k]! < x) k++;
      if (k < xs.length && xs[k] === x) out[k] = col[i] ?? null;
    }
    return out;
  });

  return { xs, ys };
}
