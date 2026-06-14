// Lean dual-month date-range picker. The bottom range-viewer label becomes the
// trigger, and picking a start→end day range sets the visible window.
// Dependency-free (no jQuery/moment) and host-agnostic, so it renders inside
// exported snapshots like everything else.

import type { TimeRange, UtcMillis } from './types';

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** What the picker needs from the chart: the current/limit ranges + a sink. */
export interface DateRangeHost {
  /** Current visible window — seeds the displayed months and the selection. */
  getVisible(): TimeRange;
  /** Full navigable extent — days outside it are disabled. */
  getExtent(): TimeRange;
  /** A day range was applied: [startOfDay(from), startOfDay(to)+1d). */
  onApply(range: TimeRange): void;
}

/** All time math is UTC (the chart's only domain) to avoid TZ drift. */
const dayTs = (y: number, m: number, d: number): number => Date.UTC(y, m, d);
const floorDay = (t: UtcMillis): number => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const firstWeekday = (y: number, m: number): number => new Date(Date.UTC(y, m, 1)).getUTCDay();
const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
const fmtDay = (t: number): string => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const s = document.createElement('style');
  s.id = 'vcn-dp-style';
  s.textContent = `
.vcn-range-trigger{display:inline-flex;align-items:center;gap:6px;
  padding:3px 11px;border-radius:7px;border:1px solid transparent;cursor:pointer;
  font:11px system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;
  color:#5b6472;transition:background 120ms ease,border-color 120ms ease,color 120ms ease}
.vcn-range-trigger:hover{background:#eef1f5;border-color:#dfe3ea;color:#2b3340}
.vcn-range-trigger svg{opacity:.75;flex:none}
.vcn-dp{position:fixed;z-index:1000;background:#fff;border:1px solid #d2d6df;
  border-radius:8px;box-shadow:0 8px 28px rgba(20,28,46,.18);padding:12px 14px;
  font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#2b3340;
  user-select:none}
.vcn-dp-cals{display:flex;gap:22px}
.vcn-dp-cal{width:224px}
.vcn-dp-head{display:flex;align-items:center;justify-content:center;
  position:relative;font-weight:600;height:24px;margin-bottom:6px;color:#1f2733}
.vcn-dp-nav{position:absolute;top:0;width:24px;height:24px;border:0;background:none;
  cursor:pointer;color:#1f2733;font-size:15px;border-radius:5px;line-height:24px}
.vcn-dp-nav:hover{background:#eef0f4}
.vcn-dp-nav[disabled]{color:#cdd1d9;cursor:default;background:none}
.vcn-dp-prev{left:0}.vcn-dp-next{right:0}
.vcn-dp-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:1px}
.vcn-dp-wd{text-align:center;font-weight:600;color:#6b7280;font-size:11px;
  padding:3px 0}
.vcn-dp-day{aspect-ratio:1;border:0;background:none;cursor:pointer;border-radius:6px;
  font:12px/1 inherit;color:#2b3340;padding:0}
.vcn-dp-day:hover{background:#eef0f4}
.vcn-dp-out{color:#b8bcc4}
.vcn-dp-off{color:#d6d9df;cursor:default}
.vcn-dp-off:hover{background:none}
.vcn-dp-in{background:#e6effb;border-radius:0}
.vcn-dp-end{background:#4a86d8;color:#fff}
.vcn-dp-end:hover{background:#3f78c6}
.vcn-dp-foot{display:flex;align-items:center;gap:10px;margin-top:12px;
  padding-top:10px;border-top:1px solid #edeef2}
.vcn-dp-sel{flex:1;font:12px system-ui,-apple-system,sans-serif;
  font-variant-numeric:tabular-nums;color:#5b6472}
.vcn-dp-btn{border:1px solid #d2d6df;background:#f3f4f7;color:#2b3340;
  border-radius:7px;padding:5px 14px;font-size:12px;cursor:pointer}
.vcn-dp-btn:hover{background:#e9eaee}
.vcn-dp-apply{border-color:#4a86d8;background:#4a86d8;color:#fff}
.vcn-dp-apply:hover{background:#3f78c6}
.vcn-dp-apply[disabled]{opacity:.5;cursor:default;background:#4a86d8}`;
  document.head.appendChild(s);
}

export class DateRangePicker {
  private pop: HTMLDivElement | null = null;
  private selStart: number | null = null;
  private selEnd: number | null = null;
  private refYear = 0; // left-month anchor
  private refMonth = 0;
  private readonly onTrigger: () => void;
  private readonly onDocDown: (e: MouseEvent) => void;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(
    private readonly trigger: HTMLElement,
    private readonly host: DateRangeHost,
  ) {
    injectStyles();
    trigger.style.cursor = 'pointer';
    trigger.title = 'Click to choose a date range';
    this.onTrigger = () => (this.pop ? this.close() : this.open());
    this.onDocDown = (e) => {
      if (this.pop && !this.pop.contains(e.target as Node) && e.target !== this.trigger)
        this.close();
    };
    this.onKey = (e) => {
      if (e.key === 'Escape') this.close();
    };
    trigger.addEventListener('click', this.onTrigger);
  }

  destroy(): void {
    this.close();
    this.trigger.removeEventListener('click', this.onTrigger);
  }

  private open(): void {
    const vis = this.host.getVisible();
    const startDay = new Date(vis.from);
    this.refYear = startDay.getUTCFullYear();
    this.refMonth = startDay.getUTCMonth();
    // Seed the selection from the current window (inclusive day range).
    this.selStart = floorDay(vis.from);
    this.selEnd = floorDay(vis.to - 1);
    this.pop = document.createElement('div');
    this.pop.className = 'vcn-dp';
    this.pop.style.visibility = 'hidden';
    document.body.appendChild(this.pop);
    this.render();
    this.position();
    this.pop.style.visibility = 'visible';
    // Defer the outside-click wiring so this opening click doesn't self-close.
    setTimeout(() => {
      document.addEventListener('mousedown', this.onDocDown);
      document.addEventListener('keydown', this.onKey);
    }, 0);
  }

  private close(): void {
    document.removeEventListener('mousedown', this.onDocDown);
    document.removeEventListener('keydown', this.onKey);
    this.pop?.remove();
    this.pop = null;
  }

  /** Page both months by `delta`, clamped so we never wander past the extent. */
  private shiftMonths(delta: number): void {
    const ext = this.host.getExtent();
    const lo = new Date(ext.from);
    const hi = new Date(ext.to - 1);
    const minIdx = lo.getUTCFullYear() * 12 + lo.getUTCMonth();
    const maxIdx = hi.getUTCFullYear() * 12 + hi.getUTCMonth();
    let idx = this.refYear * 12 + this.refMonth + delta;
    // The right calendar shows ref+1, so the left anchor stops one short of max.
    idx = Math.max(minIdx, Math.min(idx, Math.max(minIdx, maxIdx - 1)));
    this.refYear = Math.floor(idx / 12);
    this.refMonth = idx % 12;
    this.render();
  }

  private onDayClick(ts: number): void {
    if (this.selStart == null || this.selEnd != null) {
      this.selStart = ts;
      this.selEnd = null;
    } else if (ts < this.selStart) {
      this.selEnd = this.selStart;
      this.selStart = ts;
    } else {
      this.selEnd = ts;
    }
    this.render();
  }

  private render(): void {
    if (!this.pop) return;
    const ext = this.host.getExtent();
    const extLo = floorDay(ext.from);
    const extHi = floorDay(ext.to - 1);
    const min = this.selStart != null && this.selEnd != null ? Math.min(this.selStart, this.selEnd) : null;
    const max = this.selStart != null && this.selEnd != null ? Math.max(this.selStart, this.selEnd) : null;

    const cal = (y: number, m: number): string => {
      const off = firstWeekday(y, m);
      let cells = '';
      for (let i = 0; i < 42; i++) {
        const ts = dayTs(y, m, 1 - off + i);
        const d = new Date(ts);
        const inMonth = d.getUTCMonth() === m;
        const disabled = ts < extLo || ts > extHi;
        const isEnd = ts === this.selStart || ts === this.selEnd;
        const inRange = min != null && max != null && ts >= min && ts <= max;
        const cls = ['vcn-dp-day'];
        if (disabled) cls.push('vcn-dp-off');
        else if (!inMonth) cls.push('vcn-dp-out');
        if (isEnd) cls.push('vcn-dp-end');
        else if (inRange) cls.push('vcn-dp-in');
        cells += `<button class="${cls.join(' ')}" ${disabled ? 'disabled' : `data-ts="${ts}"`}>${d.getUTCDate()}</button>`;
      }
      const lo12 = new Date(ext.from).getUTCFullYear() * 12 + new Date(ext.from).getUTCMonth();
      const cur12 = y * 12 + m;
      const showPrev = m === this.refMonth && y === this.refYear; // left cal owns prev
      return (
        `<div class="vcn-dp-cal"><div class="vcn-dp-head">` +
        (showPrev ? `<button class="vcn-dp-nav vcn-dp-prev" ${cur12 <= lo12 ? 'disabled' : ''}>‹</button>` : '') +
        `${MONTHS[m]} ${y}` +
        (!showPrev ? `<button class="vcn-dp-nav vcn-dp-next"></button>` : '') +
        `</div>` +
        `<div class="vcn-dp-grid">${WEEKDAYS.map((w) => `<div class="vcn-dp-wd">${w}</div>`).join('')}${cells}</div></div>`
      );
    };

    // Right month = ref + 1.
    const r12 = this.refYear * 12 + this.refMonth + 1;
    const ry = Math.floor(r12 / 12);
    const rm = r12 % 12;
    const extHi12 = extHi != null ? new Date(extHi).getUTCFullYear() * 12 + new Date(extHi).getUTCMonth() : Infinity;
    const selTxt =
      this.selStart != null
        ? `${fmtDay(this.selStart)} – ${fmtDay(this.selEnd ?? this.selStart)}`
        : 'Pick a start and end day';

    this.pop.innerHTML =
      `<div class="vcn-dp-cals">${cal(this.refYear, this.refMonth)}${cal(ry, rm)}</div>` +
      `<div class="vcn-dp-foot"><span class="vcn-dp-sel">${selTxt}</span>` +
      `<button class="vcn-dp-btn vcn-dp-cancel">Cancel</button>` +
      `<button class="vcn-dp-btn vcn-dp-apply" ${this.selStart == null ? 'disabled' : ''}>Apply</button></div>`;

    // The right calendar's next-arrow sits in its (otherwise empty) head slot.
    const nextBtn = this.pop.querySelector('.vcn-dp-next') as HTMLButtonElement | null;
    if (nextBtn) {
      nextBtn.textContent = '›';
      if (r12 >= extHi12) nextBtn.setAttribute('disabled', '');
    }

    this.pop.querySelector('.vcn-dp-prev')?.addEventListener('click', () => this.shiftMonths(-1));
    nextBtn?.addEventListener('click', () => this.shiftMonths(1));
    this.pop.querySelectorAll<HTMLButtonElement>('.vcn-dp-day[data-ts]').forEach((b) =>
      b.addEventListener('click', () => this.onDayClick(+b.dataset.ts!)),
    );
    this.pop.querySelector('.vcn-dp-cancel')?.addEventListener('click', () => this.close());
    this.pop.querySelector('.vcn-dp-apply')?.addEventListener('click', () => this.apply());
  }

  private apply(): void {
    if (this.selStart == null) return;
    const end = this.selEnd ?? this.selStart;
    this.host.onApply({ from: this.selStart, to: end + DAY_MS });
    this.close();
  }

  /** Anchor above the trigger (it lives near the page bottom); flip below and
   *  clamp horizontally if there isn't room. */
  private position(): void {
    if (!this.pop) return;
    const t = this.trigger.getBoundingClientRect();
    const w = this.pop.offsetWidth;
    const h = this.pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = t.left + t.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = t.top - h - 8;
    if (top < 8) top = Math.min(t.bottom + 8, vh - h - 8);
    this.pop.style.left = `${Math.round(left)}px`;
    this.pop.style.top = `${Math.round(top)}px`;
  }
}
