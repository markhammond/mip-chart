// Disjoint interval set over half-open [from, to) UTC-ms ranges.
// Used by hosts/harnesses for loaded-range dedup.
// Pure + unit-tested. Serves the client-side eviction window; a data source
// may keep its own interval algebra independently.

import type { TimeRange } from './types';

export class DisjointIntervalSet {
  /** Sorted, non-overlapping, non-adjacent. */
  private ranges: TimeRange[] = [];

  get all(): readonly TimeRange[] {
    return this.ranges;
  }

  add(r: TimeRange): void {
    if (r.to <= r.from) return;
    const out: TimeRange[] = [];
    let { from, to } = r;
    let inserted = false;
    for (const cur of this.ranges) {
      if (cur.to < from) {
        out.push(cur);
      } else if (cur.from > to) {
        if (!inserted) {
          out.push({ from, to });
          inserted = true;
        }
        out.push(cur);
      } else {
        // overlap or adjacency — absorb
        from = Math.min(from, cur.from);
        to = Math.max(to, cur.to);
      }
    }
    if (!inserted) out.push({ from, to });
    this.ranges = out;
  }

  covers(r: TimeRange): boolean {
    if (r.to <= r.from) return true;
    return this.ranges.some((cur) => cur.from <= r.from && cur.to >= r.to);
  }

  /** Sub-ranges of `r` not yet covered (the fetch plan). */
  missing(r: TimeRange): TimeRange[] {
    const out: TimeRange[] = [];
    let cursor = r.from;
    for (const cur of this.ranges) {
      if (cur.to <= cursor) continue;
      if (cur.from >= r.to) break;
      if (cur.from > cursor) out.push({ from: cursor, to: Math.min(cur.from, r.to) });
      cursor = Math.max(cursor, cur.to);
      if (cursor >= r.to) break;
    }
    if (cursor < r.to) out.push({ from: cursor, to: r.to });
    return out;
  }

  /** Drop coverage outside `keep` (bounded-memory window). */
  retainWithin(keep: TimeRange): void {
    const out: TimeRange[] = [];
    for (const cur of this.ranges) {
      const from = Math.max(cur.from, keep.from);
      const to = Math.min(cur.to, keep.to);
      if (to > from) out.push({ from, to });
    }
    this.ranges = out;
  }

  clear(): void {
    this.ranges = [];
  }
}
