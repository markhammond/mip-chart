// TradingView lightweight-charts time-scale tick model (same
// spirit as the price-scale port in splits.ts): tick candidates are CALENDAR
// BOUNDARIES carrying a weight (year > month > day > 12h > … > 1m); marks
// are accepted greedily by descending weight wherever the label spacing
// allows, so the axis self-calibrates across zoom levels and labels read
// hierarchically (2026 · Feb · 12 · 16:00). All calendar math in UTC.

export interface TimeTick {
  t: number; // UTC ms
  label: string;
  weight: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hhmm(t: number): string {
  const d = new Date(t);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export interface TimeTickOptions {
  widthPx: number;
  fontPx: number;
  /** Min pixel distance between accepted marks (≈ widest label + padding);
   *  default derives from the font ('16:00' ≈ 5 chars). */
  minPx?: number;
}

/**
 * Weighted greedy tick selection over calendar boundaries (TVLC TickMarks):
 * higher-weight marks claim space first; finer levels fill remaining gaps.
 */
export function tvTimeTicks(fromMs: number, toMs: number, o: TimeTickOptions): TimeTick[] {
  if (!(toMs > fromMs) || !(o.widthPx > 0)) return [];
  const pxPerMs = o.widthPx / (toMs - fromMs);
  const minPx = o.minPx ?? Math.max(44, Math.round(o.fontPx * 4.8));
  const maxMarks = Math.max(2, Math.ceil(o.widthPx / minPx) + 2);

  const accepted: number[] = []; // pixel positions, sorted
  const result: TimeTick[] = [];

  const fits = (px: number): boolean => {
    // binary search the sorted neighbor positions
    let lo = 0;
    let hi = accepted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (accepted[mid]! < px) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && px - accepted[lo - 1]! < minPx) return false;
    if (lo < accepted.length && accepted[lo]! - px < minPx) return false;
    return true;
  };
  const tryAccept = (t: number, label: string, weight: number): void => {
    if (t < fromMs || t > toMs || result.length >= maxMarks * 3) return;
    const px = (t - fromMs) * pxPerMs;
    if (!fits(px)) return;
    let lo = 0;
    let hi = accepted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (accepted[mid]! < px) lo = mid + 1;
      else hi = mid;
    }
    accepted.splice(lo, 0, px);
    result.push({ t, label, weight });
  };

  const from = new Date(fromMs);
  const spanMs = toMs - fromMs;

  // — years (weight 70) —
  for (let y = from.getUTCFullYear(); ; y++) {
    const t = Date.UTC(y, 0, 1);
    if (t > toMs) break;
    tryAccept(t, String(y), 70);
  }

  // — month starts (60) —
  if (spanMs < 15 * 366 * DAY) {
    for (let y = from.getUTCFullYear(), m = from.getUTCMonth(); ; ) {
      const t = Date.UTC(y, m, 1);
      if (t > toMs) break;
      if (m !== 0) tryAccept(t, MONTHS[m]!, 60); // Jan belongs to the year mark
      m++;
      if (m === 12) {
        m = 0;
        y++;
      }
    }
  }

  // — day starts (50) —
  if (spanMs < 500 * DAY) {
    for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t <= toMs; t += DAY) {
      const d = new Date(t);
      if (d.getUTCDate() !== 1) tryAccept(t, String(d.getUTCDate()), 50);
    }
  }

  // — intraday levels (33…20), coarse → fine; stop when a level stops
  //   fitting anything (finer ones won't fit either) —
  const intraday: Array<[stepMs: number, weight: number]> = [
    [12 * HOUR, 33],
    [6 * HOUR, 32],
    [3 * HOUR, 31],
    [1 * HOUR, 30],
    [30 * 60_000, 22],
    [15 * 60_000, 21],
    [5 * 60_000, 20],
    [60_000, 19],
  ];
  for (const [step, weight] of intraday) {
    if (spanMs / step > o.widthPx) continue; // hopelessly dense — skip level
    const sizeBefore = result.length;
    for (let t = Math.ceil(fromMs / step) * step; t <= toMs; t += step) {
      if (t % DAY === 0) continue; // midnight belongs to the day mark
      tryAccept(t, hhmm(t), weight);
    }
    if (result.length === sizeBefore && spanMs / step < o.widthPx / minPx) break;
  }

  result.sort((a, b) => a.t - b.t);
  return result;
}
